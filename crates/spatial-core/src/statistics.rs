//! 受限流式指标，后续空间关联复用同一指标与累计规则。
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_METRICS: usize = 8;
const MAX_GROUPS: usize = 1000;
const MAX_GROUP_KEY_BYTES: usize = 4096;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const METRIC_ERROR: &str = "统计指标格式无效";
const PRECISION_ERROR: &str = "数值统计超出安全精度范围";

#[derive(Clone, Copy)]
pub(crate) enum MetricOp {
    CountAll,
    CountValid,
    Sum,
    Mean,
    Min,
    Max,
}
pub(crate) struct Metric {
    pub(crate) name: String,
    field: Option<String>,
    op: MetricOp,
}
pub(crate) fn metrics_schema() -> Value {
    let name = json!({"type":"string","minLength":1,"maxLength":64});
    json!({"type":"array","minItems":1,"maxItems":MAX_METRICS,"items":{"oneOf":[
        {"type":"object","properties":{"name":name,"op":{"type":"string","enum":["count_all"]}},"required":["name","op"],"additionalProperties":false},
        {"type":"object","properties":{"name":name,"op":{"type":"string","enum":["count_valid","sum","mean","min","max"]},"field":{"type":"string","minLength":1,"maxLength":256}},"required":["name","op","field"],"additionalProperties":false}
    ]}})
}
pub(crate) fn parse_metrics(value: &Value) -> Result<Vec<Metric>, String> {
    let values = value
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= MAX_METRICS)
        .ok_or("统计需要1至8个指标")?;
    let mut names = BTreeSet::new();
    let mut metrics = Vec::new();
    for value in values {
        crate::checkpoint()?;
        let obj = value.as_object().ok_or(METRIC_ERROR)?;
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.chars().count() <= 64)
            .ok_or(METRIC_ERROR)?;
        if !names.insert(name) {
            return Err("统计指标名称不能重复".into());
        }
        let op = match obj.get("op").and_then(Value::as_str) {
            Some("count_all") => MetricOp::CountAll,
            Some("count_valid") => MetricOp::CountValid,
            Some("sum") => MetricOp::Sum,
            Some("mean") => MetricOp::Mean,
            Some("min") => MetricOp::Min,
            Some("max") => MetricOp::Max,
            _ => return Err(METRIC_ERROR.into()),
        };
        let field = if matches!(op, MetricOp::CountAll) {
            if obj.len() != 2 || obj.contains_key("field") {
                return Err(METRIC_ERROR.into());
            }
            None
        } else {
            if obj.len() != 3 {
                return Err(METRIC_ERROR.into());
            }
            Some(
                obj.get("field")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty() && s.chars().count() <= 256)
                    .ok_or(METRIC_ERROR)?
                    .to_owned(),
            )
        };
        if obj
            .keys()
            .any(|k| !matches!(k.as_str(), "name" | "op" | "field"))
        {
            return Err(METRIC_ERROR.into());
        }
        metrics.push(Metric {
            name: name.into(),
            field,
            op,
        });
    }
    Ok(metrics)
}
pub(crate) fn validate_fields(
    metrics: &[Metric],
    group_by: Option<&str>,
    source: &[Value],
) -> Result<(), String> {
    let fields: BTreeSet<_> = metrics
        .iter()
        .filter_map(|m| m.field.as_deref())
        .chain(group_by)
        .collect();
    for field in fields {
        let mut exists = false;
        for f in source {
            crate::checkpoint()?;
            exists |= f["properties"]
                .as_object()
                .is_some_and(|p| p.contains_key(field));
        }
        if !exists {
            return Err("统计字段在图层中不存在".into());
        }
    }
    Ok(())
}

#[derive(Clone, Default)]
pub(crate) struct Accumulator {
    valid: usize,
    null: usize,
    missing: usize,
    sum: f64,
    correction: f64,
    min: Option<Value>,
    max: Option<Value>,
}
fn numeric(value: &Value) -> Result<f64, String> {
    if !value.is_number() {
        return Err("数值统计字段必须为数字或空值".into());
    }
    if value.to_string().len() > MAX_GROUP_KEY_BYTES {
        return Err(PRECISION_ERROR.into());
    }
    let n = value
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or("数值统计只接受有限数值")?;
    if n.abs() > MAX_SAFE_INTEGER
        || n == 0.0
            && crate::attributes::number_key(value)? != crate::attributes::number_key(&json!(0))?
    {
        return Err(PRECISION_ERROR.into());
    }
    // 2^53-1 周围的小数也不能因舍入落回安全边界。
    if n.abs() == MAX_SAFE_INTEGER
        && (crate::attributes::compare_numbers(value, &json!(MAX_SAFE_INTEGER))?
            == std::cmp::Ordering::Greater
            || crate::attributes::compare_numbers(value, &json!(-MAX_SAFE_INTEGER))?
                == std::cmp::Ordering::Less)
    {
        return Err(PRECISION_ERROR.into());
    }
    Ok(n)
}
impl Accumulator {
    pub(crate) fn add(&mut self, metric: &Metric, feature: &Value) -> Result<(), String> {
        crate::checkpoint()?;
        if matches!(metric.op, MetricOp::CountAll) {
            self.valid += 1;
            return Ok(());
        }
        let value = feature["properties"]
            .as_object()
            .and_then(|p| p.get(metric.field.as_ref().unwrap()));
        let Some(value) = value else {
            self.missing += 1;
            return Ok(());
        };
        if value.is_null() {
            self.null += 1;
            return Ok(());
        }
        self.valid += 1;
        if matches!(metric.op, MetricOp::CountValid) {
            return Ok(());
        }
        let n = numeric(value)?;
        if self
            .min
            .as_ref()
            .map(|old| crate::attributes::compare_numbers(value, old))
            .transpose()?
            .is_none_or(|order| order.is_lt())
        {
            self.min = Some(value.clone());
        }
        if self
            .max
            .as_ref()
            .map(|old| crate::attributes::compare_numbers(value, old))
            .transpose()?
            .is_none_or(|order| order.is_gt())
        {
            self.max = Some(value.clone());
        }
        if matches!(metric.op, MetricOp::Sum | MetricOp::Mean) {
            let next = self.sum + n;
            if !next.is_finite() || next.abs() > MAX_SAFE_INTEGER {
                return Err(PRECISION_ERROR.into());
            }
            self.correction += if self.sum.abs() >= n.abs() {
                (self.sum - next) + n
            } else {
                (n - next) + self.sum
            };
            self.sum = next;
            if !self.correction.is_finite()
                || !(self.sum + self.correction).is_finite()
                || (self.sum + self.correction).abs() > MAX_SAFE_INTEGER
                || self.sum.abs() == MAX_SAFE_INTEGER
                    && self.correction != 0.0
                    && self.correction.signum() == self.sum.signum()
            {
                return Err(PRECISION_ERROR.into());
            }
        }
        Ok(())
    }
    pub(crate) fn value(&self, metric: &Metric) -> Value {
        match metric.op {
            MetricOp::CountAll | MetricOp::CountValid => json!(self.valid),
            _ if self.valid == 0 => Value::Null,
            MetricOp::Sum => json!(self.sum + self.correction),
            MetricOp::Mean => json!((self.sum + self.correction) / self.valid as f64),
            MetricOp::Min => json!(self.min),
            MetricOp::Max => json!(self.max),
        }
    }
    fn counts(&self) -> Value {
        json!({"validCount":self.valid,"nullCount":self.null,"missingCount":self.missing})
    }
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum GroupKey {
    All,
    Missing,
    Null,
    Boolean(bool),
    Number(String),
    Text(String),
}
fn group_key(value: Option<&Value>, grouped: bool) -> Result<(GroupKey, Value), String> {
    if !grouped {
        return Ok((GroupKey::All, json!({"type":"all"})));
    }
    match value {
        None => Ok((GroupKey::Missing, json!({"type":"missing"}))),
        Some(Value::Null) => Ok((GroupKey::Null, json!({"type":"null"}))),
        Some(Value::Bool(v)) => Ok((GroupKey::Boolean(*v), json!({"type":"boolean","value":v}))),
        Some(Value::String(v)) => {
            if v.len() > MAX_GROUP_KEY_BYTES {
                return Err("分组值超过4096字节".into());
            }
            Ok((
                GroupKey::Text(v.clone()),
                json!({"type":"string","value":v}),
            ))
        }
        Some(v @ Value::Number(_)) => {
            if v.to_string().len() > MAX_GROUP_KEY_BYTES {
                return Err("分组值超过4096字节".into());
            }
            Ok((
                GroupKey::Number(crate::attributes::number_key(v)?),
                json!({"type":"number","value":v}),
            ))
        }
        _ => Err("分组字段只支持标量或空值".into()),
    }
}
struct Group {
    label: Value,
    input_count: usize,
    accumulators: Vec<Accumulator>,
}
pub(crate) fn field_statistics(args: &Value, source: &[Value]) -> Result<Value, String> {
    let metrics = parse_metrics(&args["metrics"])?;
    let group_by = args.get("groupBy").and_then(Value::as_str);
    validate_fields(&metrics, group_by, source)?;
    let mut groups = BTreeMap::<GroupKey, Group>::new();
    for feature in source {
        crate::checkpoint()?;
        let group =
            group_by.and_then(|field| feature["properties"].as_object().and_then(|p| p.get(field)));
        let (key, label) = group_key(group, group_by.is_some())?;
        if groups.len() >= MAX_GROUPS && !groups.contains_key(&key) {
            return Err("统计分组超过1000组，未返回截断结果".into());
        }
        let state = groups.entry(key).or_insert_with(|| Group {
            label,
            input_count: 0,
            accumulators: vec![Accumulator::default(); metrics.len()],
        });
        state.input_count += 1;
        for (metric, accumulator) in metrics.iter().zip(&mut state.accumulators) {
            accumulator.add(metric, feature)?;
        }
    }
    let mut rows = Vec::new();
    for state in groups.into_values() {
        crate::checkpoint()?;
        let mut values = serde_json::Map::new();
        let mut counts = serde_json::Map::new();
        for (metric, accumulator) in metrics.iter().zip(state.accumulators) {
            values.insert(metric.name.clone(), accumulator.value(metric));
            counts.insert(metric.name.clone(), accumulator.counts());
        }
        rows.push(json!({"group":state.label,"inputCount":state.input_count,"values":values,"counts":counts}));
    }
    Ok(
        json!({"type":"table","operation":"field_statistics","inputCount":source.len(),"groupBy":group_by,
        "groupCount":rows.len(),"metrics":args["metrics"],"numericModel":"finite_f64_safe_integer_guard",
        "numericPrecision":"approximate_non_financial","rows":rows}),
    )
}
