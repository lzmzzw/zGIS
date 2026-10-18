//! 有界属性条件；不执行 SQL、脚本或隐式类型转换。
use serde_json::{json, Value};
use std::cmp::Ordering;

const MAX_DEPTH: usize = 4;
const MAX_LEAVES: usize = 32;
const MAX_IN: usize = 100;
const CONDITION_ERROR: &str = "属性条件格式无效";
const NUMBER_ERROR: &str = "属性比较仅支持有限数值";
const TYPE_ERROR: &str = "属性字段类型不适用于此比较";

/// 根节点深度为 1；展开到固定深度，宿主无须解析递归 $ref。
pub(crate) fn condition_schema() -> Value {
    fn node(depth: usize) -> Value {
        let scalar = json!({"oneOf":[{"type":"string"},{"type":"number"},{"type":"boolean"}]});
        let field = json!({"type":"string","minLength":1,"maxLength":256});
        let mut variants = vec![
            json!({"type":"object","properties":{"field":field,"op":{"type":"string","enum":["eq","ne"]},"value":scalar},"required":["field","op","value"],"additionalProperties":false}),
            json!({"type":"object","properties":{"field":field,"op":{"type":"string","enum":["gt","gte","lt","lte"]},"value":{"type":"number"}},"required":["field","op","value"],"additionalProperties":false}),
            json!({"type":"object","properties":{"field":field,"op":{"type":"string","enum":["contains"]},"value":{"type":"string"}},"required":["field","op","value"],"additionalProperties":false}),
            json!({"type":"object","properties":{"field":field,"op":{"type":"string","enum":["in"]},"value":{"type":"array","items":scalar,"minItems":1,"maxItems":MAX_IN}},"required":["field","op","value"],"additionalProperties":false}),
            json!({"type":"object","properties":{"field":field,"op":{"type":"string","enum":["is_null","is_missing"]}},"required":["field","op"],"additionalProperties":false}),
        ];
        if depth < MAX_DEPTH {
            let child = node(depth + 1);
            for key in ["all", "any"] {
                let mut properties = json!({});
                properties[key] =
                    json!({"type":"array","items":child,"minItems":1,"maxItems":MAX_LEAVES});
                variants.push(json!({"type":"object","properties":properties,"required":[key],"additionalProperties":false}));
            }
        }
        json!({"oneOf":variants})
    }
    let mut schema = node(1);
    schema["description"] = json!("区分大小写；不转换类型；root深度1，最多4层、32个叶子、IN100项。null/missing不参与普通比较。");
    schema
}

#[derive(Clone, Copy)]
enum Operator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Contains,
    IsNull,
    IsMissing,
}
enum Condition<'a> {
    All(Vec<Condition<'a>>),
    Any(Vec<Condition<'a>>),
    Leaf {
        field: &'a str,
        op: Operator,
        value: &'a Value,
    },
}
impl<'a> Condition<'a> {
    fn parse(value: &'a Value, depth: usize, leaves: &mut usize) -> Result<Self, String> {
        crate::checkpoint()?;
        if depth > MAX_DEPTH {
            return Err("属性条件最多四层".into());
        }
        let object = value.as_object().ok_or(CONDITION_ERROR)?;
        for key in ["all", "any"] {
            if let Some(children) = object.get(key) {
                if object.len() != 1 {
                    return Err(CONDITION_ERROR.into());
                }
                let children = children
                    .as_array()
                    .filter(|a| !a.is_empty() && a.len() <= MAX_LEAVES)
                    .ok_or(CONDITION_ERROR)?;
                let nodes = children
                    .iter()
                    .map(|v| Self::parse(v, depth + 1, leaves))
                    .collect::<Result<Vec<_>, _>>()?;
                return Ok(if key == "all" {
                    Self::All(nodes)
                } else {
                    Self::Any(nodes)
                });
            }
        }
        *leaves += 1;
        if *leaves > MAX_LEAVES {
            return Err("属性条件最多32项".into());
        }
        let field = object
            .get("field")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.chars().count() <= 256)
            .ok_or(CONDITION_ERROR)?;
        let op = match object.get("op").and_then(Value::as_str) {
            Some("eq") => Operator::Eq,
            Some("ne") => Operator::Ne,
            Some("gt") => Operator::Gt,
            Some("gte") => Operator::Gte,
            Some("lt") => Operator::Lt,
            Some("lte") => Operator::Lte,
            Some("in") => Operator::In,
            Some("contains") => Operator::Contains,
            Some("is_null") => Operator::IsNull,
            Some("is_missing") => Operator::IsMissing,
            _ => return Err(CONDITION_ERROR.into()),
        };
        let unary = matches!(op, Operator::IsNull | Operator::IsMissing);
        if object.len() != if unary { 2 } else { 3 }
            || object
                .keys()
                .any(|k| !matches!(k.as_str(), "field" | "op" | "value"))
            || unary && object.contains_key("value")
        {
            return Err(CONDITION_ERROR.into());
        }
        let value = if unary {
            &Value::Null
        } else {
            object.get("value").ok_or(CONDITION_ERROR)?
        };
        match op {
            Operator::Eq | Operator::Ne => scalar(value)?,
            Operator::Gt | Operator::Gte | Operator::Lt | Operator::Lte => {
                decimal(value)?;
            }
            Operator::Contains if !value.is_string() => return Err(CONDITION_ERROR.into()),
            Operator::In => {
                let values = value
                    .as_array()
                    .filter(|a| !a.is_empty() && a.len() <= MAX_IN)
                    .ok_or("IN条件需要1至100个值")?;
                for item in values {
                    scalar(item)?;
                }
            }
            _ => {}
        }
        Ok(Self::Leaf { field, op, value })
    }
    fn fields(&self, fields: &mut std::collections::BTreeSet<&'a str>) {
        match self {
            Self::All(nodes) | Self::Any(nodes) => {
                for node in nodes {
                    node.fields(fields);
                }
            }
            Self::Leaf { field, .. } => {
                fields.insert(field);
            }
        }
    }
    fn evaluate(&self, properties: &Value) -> Result<bool, String> {
        crate::checkpoint()?;
        match self {
            Self::All(nodes) | Self::Any(nodes) => {
                let all = matches!(self, Self::All(_));
                let mut result = all;
                // 不短路：不能因条件顺序掩盖混合类型字段错误。
                for node in nodes {
                    let value = node.evaluate(properties)?;
                    result = if all { result & value } else { result | value };
                }
                Ok(result)
            }
            Self::Leaf { field, op, value } => {
                let actual = properties.as_object().and_then(|p| p.get(*field));
                if matches!(op, Operator::IsMissing) {
                    return Ok(actual.is_none());
                }
                if matches!(op, Operator::IsNull) {
                    return Ok(actual.is_some_and(Value::is_null));
                }
                let Some(actual) = actual.filter(|v| !v.is_null()) else {
                    return Ok(false);
                };
                match op {
                    Operator::Eq => equal(actual, value),
                    Operator::Ne => Ok(!equal(actual, value)?),
                    Operator::In => {
                        let mut found = false;
                        for item in value.as_array().unwrap() {
                            found |= equal(actual, item)?;
                        }
                        Ok(found)
                    }
                    Operator::Contains => Ok(actual
                        .as_str()
                        .ok_or(TYPE_ERROR)?
                        .contains(value.as_str().unwrap())),
                    Operator::Gt | Operator::Gte | Operator::Lt | Operator::Lte => {
                        if !actual.is_number() {
                            return Err(TYPE_ERROR.into());
                        }
                        let ordering = decimal(actual)?.compare(&decimal(value)?);
                        Ok(match op {
                            Operator::Gt => ordering == Ordering::Greater,
                            Operator::Gte => ordering != Ordering::Less,
                            Operator::Lt => ordering == Ordering::Less,
                            _ => ordering != Ordering::Greater,
                        })
                    }
                    _ => unreachable!(),
                }
            }
        }
    }
}

fn scalar(value: &Value) -> Result<(), String> {
    match value {
        Value::String(_) | Value::Bool(_) => Ok(()),
        Value::Number(_) => decimal(value).map(|_| ()),
        _ => Err(CONDITION_ERROR.into()),
    }
}
fn equal(a: &Value, b: &Value) -> Result<bool, String> {
    if a.is_array() || a.is_object() {
        return Err(TYPE_ERROR.into());
    }
    if a.is_number() && b.is_number() {
        return Ok(decimal(a)?.compare(&decimal(b)?) == Ordering::Equal);
    }
    Ok(a == b)
}

// 十进制精确比较：避免把 JSON 大整数和高精度小数先压到 f64 后误判相等。
struct Decimal {
    negative: bool,
    digits: String,
    magnitude: i64,
}
impl Decimal {
    fn compare(&self, other: &Self) -> Ordering {
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let mut result = self.magnitude.cmp(&other.magnitude);
        if result == Ordering::Equal {
            let width = self.digits.len().max(other.digits.len());
            result = self
                .digits
                .bytes()
                .chain(std::iter::repeat(b'0'))
                .take(width)
                .cmp(
                    other
                        .digits
                        .bytes()
                        .chain(std::iter::repeat(b'0'))
                        .take(width),
                );
        }
        if self.negative {
            result.reverse()
        } else {
            result
        }
    }
}
fn decimal(value: &Value) -> Result<Decimal, String> {
    if !value.is_number() || !value.as_f64().is_some_and(f64::is_finite) {
        return Err(NUMBER_ERROR.into());
    }
    let raw = value.to_string();
    let negative = raw.starts_with('-');
    let raw = raw.trim_start_matches('-');
    let (mantissa, exponent) = if let Some(i) = raw.find(['e', 'E']) {
        (
            &raw[..i],
            raw[i + 1..].parse::<i64>().map_err(|_| NUMBER_ERROR)?,
        )
    } else {
        (raw, 0)
    };
    let decimal_places = mantissa.find('.').map_or(0, |i| mantissa.len() - i - 1);
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok(Decimal {
            negative: false,
            digits: "0".into(),
            magnitude: i64::MIN,
        });
    }
    let magnitude = exponent
        .checked_sub(decimal_places as i64)
        .and_then(|n| n.checked_add(digits.len() as i64))
        .ok_or(NUMBER_ERROR)?;
    Ok(Decimal {
        negative,
        digits: digits.trim_end_matches('0').into(),
        magnitude,
    })
}

pub(crate) fn validate_condition(value: &Value) -> Result<(), String> {
    Condition::parse(value, 1, &mut 0).map(|_| ())
}

pub(crate) fn number_key(value: &Value) -> Result<String, String> {
    let n = decimal(value)?;
    Ok(format!("{}:{}:{}", n.negative, n.magnitude, n.digits))
}

pub(crate) fn compare_numbers(a: &Value, b: &Value) -> Result<Ordering, String> {
    Ok(decimal(a)?.compare(&decimal(b)?))
}

pub(crate) fn matching_indices(value: &Value, source: &[Value]) -> Result<Vec<usize>, String> {
    let condition = Condition::parse(value, 1, &mut 0)?;
    let mut fields = std::collections::BTreeSet::new();
    condition.fields(&mut fields);
    for field in fields {
        let mut exists = false;
        for feature in source {
            crate::checkpoint()?;
            exists |= feature["properties"]
                .as_object()
                .is_some_and(|p| p.contains_key(field));
        }
        if !exists {
            return Err("属性条件字段在图层中不存在".into());
        }
    }
    let mut output = Vec::new();
    for (index, feature) in source.iter().enumerate() {
        if condition.evaluate(&feature["properties"])? {
            output.push(index);
        }
    }
    Ok(output)
}
