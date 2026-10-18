//! 分析能力唯一目录；纯参数、GUI 选择限制与宿主来源引用分离。
use serde_json::{json, Value};
pub const DEFAULT_PREDICATE: &str = "intersects";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    CleanGeometries,
    SpatialQuery,
    SpatialJoin,
    Nearest,
    TopologyCheck,
    Buffer,
    Clip,
    Dissolve,
    LayerSummary,
    Intersection,
    Difference,
    SymmetricDifference,
    Centroid,
    PointOnSurface,
    ConvexHull,
    Envelope,
    MultipartToSingleparts,
    ExtractVertices,
    PolygonToLines,
    Simplify,
    GeometryAttributes,
    CountPoints,
    Merge,
}
impl Operation {
    pub fn id(self) -> &'static str {
        match self {
            Self::CleanGeometries => "clean_geometries",
            Self::SpatialQuery => "spatial_query",
            Self::SpatialJoin => "spatial_join",
            Self::Nearest => "nearest",
            Self::TopologyCheck => "topology_check",
            Self::Buffer => "buffer",
            Self::Clip => "clip",
            Self::Dissolve => "dissolve",
            Self::LayerSummary => "layer_summary",
            Self::Intersection => "intersection",
            Self::Difference => "difference",
            Self::SymmetricDifference => "symmetric_difference",
            Self::Centroid => "centroid",
            Self::PointOnSurface => "point_on_surface",
            Self::ConvexHull => "convex_hull",
            Self::Envelope => "envelope",
            Self::MultipartToSingleparts => "multipart_to_singleparts",
            Self::ExtractVertices => "extract_vertices",
            Self::PolygonToLines => "polygon_to_lines",
            Self::Simplify => "simplify",
            Self::GeometryAttributes => "geometry_attributes",
            Self::CountPoints => "count_points",
            Self::Merge => "merge",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetRequirement {
    None,
    Optional,
    Required,
}
#[derive(Clone, Copy, Debug)]
pub enum Parameter {
    Predicate,
    Bbox,
    DistanceMeters,
    ToleranceMeters,
    GroupBy,
}
impl Parameter {
    pub fn key(self) -> &'static str {
        match self {
            Self::Predicate => "predicate",
            Self::Bbox => "bbox",
            Self::DistanceMeters => "distanceMeters",
            Self::ToleranceMeters => "toleranceMeters",
            Self::GroupBy => "groupBy",
        }
    }
    pub fn required(self) -> bool {
        matches!(self, Self::DistanceMeters | Self::ToleranceMeters)
    }
    pub fn schema(self) -> Value {
        match self {
            Self::Predicate => {
                json!({"type":"string","enum":["intersects","within","contains","touches","disjoint"],"default":DEFAULT_PREDICATE})
            }
            Self::Bbox => {
                json!({"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4})
            }
            Self::DistanceMeters | Self::ToleranceMeters => {
                json!({"type":"number","exclusiveMinimum":0,"maximum":100000})
            }
            Self::GroupBy => json!({"type":"string","minLength":1}),
        }
    }
    fn validate(self, value: &Value) -> Result<(), String> {
        let schema = self.schema();
        match self {
            Self::Predicate => {
                value.as_str().ok_or("predicate 必须为字符串")?;
                if !schema["enum"].as_array().unwrap().contains(value) {
                    return Err("不支持的空间谓词".into());
                }
            }
            Self::Bbox => {
                if !value.as_array().is_some_and(|a| {
                    a.len() >= schema["minItems"].as_u64().unwrap() as usize
                        && a.len() <= schema["maxItems"].as_u64().unwrap() as usize
                        && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
                }) {
                    return Err("bbox 必须有四个数值".into());
                }
            }
            Self::DistanceMeters | Self::ToleranceMeters => {
                if !value.as_f64().is_some_and(|n| {
                    n.is_finite()
                        && n > schema["exclusiveMinimum"].as_f64().unwrap()
                        && n <= schema["maximum"].as_f64().unwrap()
                }) {
                    return Err(match self {
                        Self::DistanceMeters => "distanceMeters 必须 > 0 且 <= 100000",
                        _ => "toleranceMeters 必须 > 0 且 <= 100000",
                    }
                    .into());
                }
            }
            Self::GroupBy => {
                if value.as_str().is_none_or(|s| {
                    s.chars().count() < schema["minLength"].as_u64().unwrap() as usize
                }) {
                    return Err("groupBy 必须是非空字符串".into());
                }
            }
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug)]
pub enum ResultKind {
    Features,
    Report,
}
/// 几何种类字段仅限定 GUI 图层选择；算法仍执行自身的实际几何检查。
pub struct AnalysisSpec {
    pub operation: Operation,
    pub description: &'static str,
    pub target: TargetRequirement,
    pub parameters: &'static [Parameter],
    pub gui: bool,
    pub source_kinds: &'static [&'static str],
    pub target_kinds: &'static [&'static str],
    pub metric: bool,
    pub result_kind: ResultKind,
}
impl AnalysisSpec {
    pub fn id(&self) -> &'static str {
        self.operation.id()
    }
    pub fn parameter_schema(&self) -> Value {
        let properties: serde_json::Map<String, Value> = self
            .parameters
            .iter()
            .map(|p| (p.key().into(), p.schema()))
            .collect();
        let required: Vec<_> = self
            .parameters
            .iter()
            .filter(|p| p.required())
            .map(|p| p.key())
            .collect();
        json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
    }
    pub fn validate(&self, args: &Value) -> Result<(), String> {
        let object = args.as_object().ok_or("参数必须为对象")?;
        for key in object.keys() {
            if !self.parameters.iter().any(|p| p.key() == key) {
                return Err(format!("未知参数: {key}"));
            }
        }
        for parameter in self.parameters {
            if let Some(value) = object.get(parameter.key()) {
                parameter.validate(value)?;
            } else if parameter.required() {
                parameter.validate(&Value::Null)?;
            }
        }
        Ok(())
    }
    pub fn execute(
        &self,
        args: &Value,
        source: &[Value],
        target: Option<&[Value]>,
    ) -> Result<Value, String> {
        crate::checkpoint()?;
        self.validate(args)?;
        crate::spatial::execute_operation(self.operation, args, source, target)
    }
}
pub static ANALYSES: &[AnalysisSpec] = &[
    AnalysisSpec {
        operation: Operation::CleanGeometries,
        description: "移除空/无效几何并报告总数及原因预览；生成独立结果，保留有效要素",
        target: TargetRequirement::None,
        parameters: &[],
        gui: false,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::SpatialQuery,
        description: "空间谓词查询；bbox与target二选一；经纬度平面关系，禁止跨日期变更线",
        target: TargetRequirement::Optional,
        parameters: &[Parameter::Predicate, Parameter::Bbox],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &["point", "line", "polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::SpatialJoin,
        description: "空间关联，保留源属性并附加匹配目标",
        target: TargetRequirement::Required,
        parameters: &[Parameter::Predicate],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &["point", "line", "polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Nearest,
        description: "点对采用 WGS84 椭球测地距离；其他几何采用成对局部等距圆柱近似",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &["point", "line", "polygon"],
        metric: true,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::TopologyCheck,
        description: "检查无效几何、重复几何及面重叠，返回有界报告",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Report,
    },
    AnalysisSpec {
        operation: Operation::Buffer,
        description: "局部等距圆柱近似米制缓冲，限局部低中纬度数据",
        target: TargetRequirement::None,
        parameters: &[Parameter::DistanceMeters],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: true,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Clip,
        description: "面与面裁剪",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &["polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Dissolve,
        description: "合并面几何，可按字段类型和值分组",
        target: TargetRequirement::None,
        parameters: &[Parameter::GroupBy],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::LayerSummary,
        description: "图层几何、属性、范围摘要",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Report,
    },
    AnalysisSpec {
        operation: Operation::Intersection,
        description: "面相交，逐对保留源属性与 target_ 前缀目标属性",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &["polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Difference,
        description: "面差集，保留源属性",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &["polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::SymmetricDifference,
        description: "面对称差，分别保留两侧属性",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &["polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Centroid,
        description: "每个要素的平面质心，可能位于面外",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::PointOnSurface,
        description: "每个要素的表面代表点",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::ConvexHull,
        description: "每个要素的凸包，退化结果为点或线",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Envelope,
        description: "每个要素的轴对齐包络，退化结果为点或线",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::MultipartToSingleparts,
        description: "多部件转单部件，保留属性并移除旧 ID",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::ExtractVertices,
        description: "提取顶点，面环不重复末尾闭合点，保留部件/环/节点索引",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::PolygonToLines,
        description: "面边界转多线，包含洞",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &[],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Simplify,
        description: "Douglas–Peucker 近似米制简化；无效结果拒绝",
        target: TargetRequirement::None,
        parameters: &[Parameter::ToleranceMeters],
        gui: true,
        source_kinds: &["line", "polygon"],
        target_kinds: &[],
        metric: true,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::GeometryAttributes,
        description: "添加近似平方米面积及米制长度（面包含洞周长），冲突字段加下划线",
        target: TargetRequirement::None,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &[],
        metric: true,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::CountPoints,
        description: "面内点计数，包含边界，多点按每个点计数",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["polygon"],
        target_kinds: &["point"],
        metric: false,
        result_kind: ResultKind::Features,
    },
    AnalysisSpec {
        operation: Operation::Merge,
        description: "合并两层要素，保留属性并移除旧 ID",
        target: TargetRequirement::Required,
        parameters: &[],
        gui: true,
        source_kinds: &["point", "line", "polygon"],
        target_kinds: &["point", "line", "polygon"],
        metric: false,
        result_kind: ResultKind::Features,
    },
];
pub fn find(id: &str) -> Option<&'static AnalysisSpec> {
    ANALYSES.iter().find(|s| s.id() == id)
}
pub fn metadata() -> Vec<Value> {
    ANALYSES.iter().map(|s| {
        let mut value=json!({"id":s.id(),"description":s.description,"gui":s.gui,
            "requiresTarget":s.target!=TargetRequirement::None,"sourceKinds":s.source_kinds,"metric":s.metric,
            "parameters":s.parameters.iter().filter(|p| !matches!(p,Parameter::Bbox)).map(|p|p.key()).collect::<Vec<_>>(),
            "parameterSchema":s.parameter_schema(),"resultKind":match s.result_kind {ResultKind::Features=>"features",ResultKind::Report=>"report"}});
        if !s.target_kinds.is_empty() {value["targetKinds"]=json!(s.target_kinds);}
        if matches!(s.result_kind,ResultKind::Report) {value["report"]=json!(true);}
        value
    }).collect()
}
