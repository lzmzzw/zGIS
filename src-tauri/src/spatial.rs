//! Bounded planar spatial operations with XY/XYZ data preservation. Relations use longitude/latitude
//! coordinates; metric operations use a local equirectangular approximation.
use geo::{
    Area, BooleanOps, BoundingRect, Buffer, Centroid, ConvexHull, CoordsIter, Euclidean, Geometry,
    InteriorPoint, Length, MultiPolygon, Relate, Simplify, Validation,
};
use serde_json::{json, Value};

const MAX_FEATURES: usize = 10_000;
const MAX_VERTICES: usize = 1_000_000;
const MAX_PAIRS: usize = 1_000_000;
const MAX_OUTPUT_BYTES: usize = 100 * 1024 * 1024;

struct OutputBudget {
    vertices: usize,
    bytes: usize,
    limit: usize,
}
impl OutputBudget {
    fn new(limit: usize) -> Self {
        // Reserve more than the collection wrapper and optional metric metadata need.
        Self {
            vertices: 0,
            bytes: 256,
            limit,
        }
    }
    fn repeated_properties(&self, source: &Value, count: usize) -> Result<(), String> {
        let remaining = self.limit.saturating_sub(self.bytes);
        let bytes = json_size(&source["properties"], remaining)?;
        if bytes.saturating_mul(count) > remaining {
            return Err("结果超过 100 MiB；重复属性未复制，未返回截断结果".into());
        }
        Ok(())
    }
}
// Count serialized UTF-8 bytes without allocating a second copy of large properties.
fn json_size(value: &Value, limit: usize) -> Result<usize, String> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let next = self.bytes.saturating_add(bytes.len());
            if next > self.limit {
                return Err(std::io::Error::other("结果超过 100 MiB"));
            }
            self.bytes = next;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| "结果超过 100 MiB；未返回截断结果")?;
    Ok(counter.bytes)
}
fn coordinate_count(v: &Value) -> usize {
    v.as_array()
        .map(|a| {
            if !a.is_empty() && a.iter().all(|v| !v.is_array()) {
                1
            } else {
                a.iter()
                    .map(coordinate_count)
                    .fold(0usize, usize::saturating_add)
            }
        })
        .unwrap_or(0)
}

pub fn tool_definitions() -> Vec<Value> {
    let reference = json!({"oneOf":[{"type":"object","properties":{"layerId":{"type":"string","minLength":1}},"required":["layerId"],"additionalProperties":false},{"type":"object","properties":{"path":{"type":"string","minLength":1},"crs":{"type":"string","enum":["EPSG:4326","EPSG:4490","EPSG:3857"]},"wktField":{"type":"string","minLength":1},"xField":{"type":"string","minLength":1},"yField":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}]});
    [("spatial_query","空间谓词查询；经纬度平面关系，禁止跨日期变更线"),("spatial_join","空间关联，保留源属性并附加匹配目标"),("nearest","按局部等距圆柱近似距离查找最近目标；非测地距离"),("topology_check","检查无效几何、重复几何及面重叠，返回有界报告"),("buffer","局部等距圆柱近似米制缓冲，限局部低中纬度数据"),("clip","面与面裁剪"),("dissolve","合并面几何，可按字段类型和值分组"),("layer_summary","图层几何、属性、范围摘要"),("intersection","面相交，逐对保留源属性与 target_ 前缀目标属性"),("difference","面差集，保留源属性"),("symmetric_difference","面对称差，分别保留两侧属性"),("centroid","每个要素的平面质心，可能位于面外"),("point_on_surface","每个要素的表面代表点"),("convex_hull","每个要素的凸包，退化结果为点或线"),("envelope","每个要素的轴对齐包络，退化结果为点或线"),("multipart_to_singleparts","多部件转单部件，保留属性并移除旧 ID"),("extract_vertices","提取顶点，面环不重复末尾闭合点，保留部件/环/节点索引"),("polygon_to_lines","面边界转多线，包含洞"),("simplify","Douglas–Peucker 近似米制简化；无效结果拒绝"),("geometry_attributes","添加近似平方米面积及米制长度（面包含洞周长），冲突字段加下划线"),("count_points","面内点计数，包含边界，多点按每个点计数"),("merge","合并两层要素，保留属性并移除旧 ID")].into_iter().map(|(name,description)| {
        let mut properties = json!({"source":reference.clone()});
        let mut required=vec!["source"];
        if matches!(name,"spatial_query"|"spatial_join"|"nearest"|"clip"|"intersection"|"difference"|"symmetric_difference"|"count_points"|"merge") { properties["target"]=reference.clone(); if name!="spatial_query" {required.push("target");} }
        if matches!(name,"spatial_query"|"spatial_join") {properties["predicate"]=json!({"type":"string","enum":["intersects","within","contains","touches","disjoint"],"default":"intersects"});}
        if name=="spatial_query" {properties["bbox"]=json!({"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4});}
        if name=="buffer" {properties["distanceMeters"]=json!({"type":"number","exclusiveMinimum":0,"maximum":100000});required.push("distanceMeters");}
        if name=="simplify" {properties["toleranceMeters"]=json!({"type":"number","exclusiveMinimum":0,"maximum":100000});required.push("toleranceMeters");}
        if name=="dissolve" {properties["groupBy"]=json!({"type":"string","minLength":1});}
        json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})
    }).collect()
}

fn decode(features: &[Value], allow_invalid: bool) -> Result<Vec<Geometry<f64>>, String> {
    if features.len() > MAX_FEATURES {
        return Err("图层超过 10000 个要素，请先缩小范围".into());
    }
    let mut vertices = 0;
    features
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let value = f
                .get("geometry")
                .ok_or_else(|| format!("要素 {i} 缺少 geometry"))?;
            validate_coordinates(value.get("coordinates").unwrap_or(&Value::Null))?;
            validate_rings(value)?;
            vertices += coordinate_count(&value["coordinates"]);
            if vertices > MAX_VERTICES {
                return Err("顶点总数超过 1000000".into());
            }
            let parsed: geojson::Geometry =
                serde_json::from_value(value.clone()).map_err(|e| format!("要素 {i}: {e}"))?;
            let geometry: Geometry<f64> =
                parsed.try_into().map_err(|e| format!("要素 {i}: {e}"))?;
            if matches!(geometry, Geometry::GeometryCollection(_)) {
                return Err("不支持 GeometryCollection".into());
            }
            let mut coords = geometry.coords_iter();
            let Some(first) = coords.next() else {
                return Err(format!("要素 {i} 为空几何"));
            };
            let (min, max) = coords.fold((first.x, first.x), |(min, max), c| {
                (min.min(c.x), max.max(c.x))
            });
            if max - min > 180.0 {
                return Err("不支持跨日期变更线或跨度超过 180 度的几何".into());
            }
            if !allow_invalid && !geometry.is_valid() {
                return Err(format!("要素 {i} 几何无效，请先执行 topology_check"));
            }
            Ok(geometry)
        })
        .collect()
}
fn validate_coordinates(v: &Value) -> Result<(), String> {
    validate_coordinate_tree(v, &mut None)
}
fn validate_coordinate_tree(v: &Value, dimension: &mut Option<usize>) -> Result<(), String> {
    let a = v.as_array().ok_or("坐标必须为 XY 或 XYZ 数组")?;
    if a.first().is_some_and(Value::is_number) {
        if !matches!(a.len(), 2 | 3) {
            return Err("仅支持 XY/XYZ 坐标，不支持 M/ZM".into());
        }
        if a.len() == 3 && !a[2].as_f64().is_some_and(f64::is_finite) {
            return Err("高程 Z 必须为有限数值".into());
        }
        if dimension.is_some_and(|d| d != a.len()) {
            return Err("同一几何不能混合 XY 与 XYZ 坐标".into());
        }
        *dimension = Some(a.len());
        let x = a[0].as_f64().ok_or("非法坐标")?;
        let y = a[1].as_f64().ok_or("非法坐标")?;
        if !x.is_finite() || !y.is_finite() || x.abs() > 180.0 || y.abs() > 90.0 {
            return Err("坐标必须是有效 WGS84 经纬度".into());
        }
    } else {
        for item in a {
            validate_coordinate_tree(item, dimension)?;
        }
    }
    Ok(())
}
fn validate_rings(geometry: &Value) -> Result<(), String> {
    fn polygon(value: &Value) -> Result<(), String> {
        let rings = value.as_array().ok_or("面坐标必须为数组")?;
        if rings.is_empty() {
            return Err("面缺少外环".into());
        }
        for ring in rings {
            let points = ring.as_array().ok_or("面环坐标必须为数组")?;
            if points.len() < 4
                || (0..points[0].as_array().map_or(0, Vec::len)).any(|axis| {
                    points.first().and_then(|p| p[axis].as_f64())
                        != points.last().and_then(|p| p[axis].as_f64())
                })
            {
                return Err("面环至少需要四个坐标且首尾必须相等".into());
            }
        }
        Ok(())
    }
    match geometry["type"].as_str() {
        Some("Polygon") => polygon(&geometry["coordinates"]),
        Some("MultiPolygon") => {
            for part in geometry["coordinates"]
                .as_array()
                .ok_or("多面坐标必须为数组")?
            {
                polygon(part)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn collection(features: Vec<Value>, metric: bool) -> Value {
    let mut v = json!({"type":"FeatureCollection","features":features});
    if metric {
        v["analysis"] = json!({"distanceModel":"local_equirectangular_approximation","units":"meters","geodesic":false});
    }
    v
}
fn feature(geometry: &Geometry<f64>, properties: Value) -> Value {
    json!({"type":"Feature","geometry":geojson::Geometry::new(geojson::Value::from(geometry)),"properties":properties})
}
fn derived_feature(source: &Value, geometry: Option<&Geometry<f64>>, properties: Value) -> Value {
    let elevations = geometry.map(|_| Elevations::from_geometry(&source["geometry"]));
    derived_with_elevations(source, geometry, properties, elevations.as_ref())
}
fn derived_with_elevations(
    source: &Value,
    geometry: Option<&Geometry<f64>>,
    properties: Value,
    elevations: Option<&Elevations>,
) -> Value {
    // Splitting a large source must not clone its entire geometry for each output.
    let mut result = Value::Object(
        source
            .as_object()
            .map(|o| {
                o.iter()
                    .filter(|(k, _)| {
                        k.as_str() != "properties"
                            && (geometry.is_none() || !matches!(k.as_str(), "geometry" | "bbox"))
                    })
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default(),
    );
    result["type"] = json!("Feature");
    result["properties"] = properties;
    if let Some(geometry) = geometry {
        result["geometry"] = json!(geojson::Geometry::new(geojson::Value::from(geometry)));
        if let Some(elevations) = elevations {
            elevations.apply(&mut result["geometry"]);
        }
        // An old feature bbox no longer describes the transformed geometry.
        if let Some(object) = result.as_object_mut() {
            object.remove("bbox");
        }
    }
    result
}

// Indexed by exact XY within this output's sources, never by unrelated layer features.
// Conflicting elevations at the same XY have no unique answer and become zero.
#[derive(Default)]
struct Elevations {
    xyz: bool,
    values: std::collections::HashMap<(u64, u64), Option<Value>>,
}
fn xy_key(x: f64, y: f64) -> (u64, u64) {
    // Treat negative and positive zero as the same horizontal coordinate.
    (
        (if x == 0.0 { 0.0 } else { x }).to_bits(),
        (if y == 0.0 { 0.0 } else { y }).to_bits(),
    )
}
fn promote_xyz(coordinates: &mut Value) {
    if let Some(a) = coordinates.as_array_mut() {
        if a.first().is_some_and(Value::is_number) {
            if a.len() == 2 {
                a.push(json!(0));
            }
        } else {
            for item in a {
                promote_xyz(item);
            }
        }
    }
}
impl Elevations {
    fn for_overlay(source: &Value, a: &MultiPolygon<f64>, b: &MultiPolygon<f64>) -> Self {
        let mut result = Self::from_geometry(&source["geometry"]);
        if result.xyz {
            result.quantize(a, b);
        }
        result
    }
    fn quantize(&mut self, a: &MultiPolygon<f64>, b: &MultiPolygon<f64>) {
        // Use the same pinned i_float adapter as geo's BooleanOps. Original
        // vertices may move to its integer grid; no arbitrary nearest-point Z lookup.
        let points: Vec<_> = a
            .coords_iter()
            .chain(b.coords_iter())
            .map(|c| [c.x, c.y])
            .collect();
        let adapter =
            i_float::adapter::FloatPointAdapter::<[f64; 2], f64>::with_iter(points.iter());
        let prior = std::mem::take(&mut self.values);
        for ((x, y), z) in prior {
            let raw = [f64::from_bits(x), f64::from_bits(y)];
            let xy = adapter.int_to_float(&adapter.float_to_int(&raw));
            self.values
                .entry(xy_key(xy[0], xy[1]))
                .and_modify(|v| {
                    if v.as_ref().and_then(Value::as_f64) != z.as_ref().and_then(Value::as_f64) {
                        *v = None;
                    }
                })
                .or_insert(z);
        }
    }
    fn from_geometry(geometry: &Value) -> Self {
        fn has_z(v: &Value) -> bool {
            v.as_array().is_some_and(|a| {
                if a.first().is_some_and(Value::is_number) {
                    a.len() == 3
                } else {
                    a.iter().any(has_z)
                }
            })
        }
        let mut result = Self::default();
        if has_z(&geometry["coordinates"]) {
            result.add(&geometry["coordinates"]);
        }
        result
    }
    fn add(&mut self, coordinates: &Value) {
        let Some(a) = coordinates.as_array() else {
            return;
        };
        if a.first().is_some_and(Value::is_number) {
            self.xyz |= a.len() == 3;
            if let (Some(x), Some(y)) = (a[0].as_f64(), a[1].as_f64()) {
                let z = a.get(2).cloned().unwrap_or(json!(0));
                self.values
                    .entry(xy_key(x, y))
                    .and_modify(|prior| {
                        if prior.as_ref().and_then(Value::as_f64) != z.as_f64() {
                            *prior = None;
                        }
                    })
                    .or_insert(Some(z));
            }
        } else {
            for item in a {
                self.add(item);
            }
        }
    }
    fn apply(&self, geometry: &mut Value) {
        if self.xyz {
            self.apply_coordinates(&mut geometry["coordinates"]);
        }
    }
    fn apply_coordinates(&self, coordinates: &mut Value) {
        let Some(a) = coordinates.as_array_mut() else {
            return;
        };
        if a.first().is_some_and(Value::is_number) {
            let z = self
                .values
                .get(&xy_key(a[0].as_f64().unwrap(), a[1].as_f64().unwrap()))
                .and_then(Option::as_ref)
                .cloned()
                .unwrap_or(json!(0));
            a.truncate(2);
            a.push(z);
        } else {
            for item in a {
                self.apply_coordinates(item);
            }
        }
    }
}
fn polygon(g: &Geometry<f64>) -> Result<MultiPolygon<f64>, String> {
    match g {
        Geometry::Polygon(p) => Ok(MultiPolygon(vec![p.clone()])),
        Geometry::MultiPolygon(p) => Ok(p.clone()),
        _ => Err("此工具仅支持 Polygon/MultiPolygon".into()),
    }
}
fn relation(a: &Geometry<f64>, b: &Geometry<f64>, p: &str) -> bool {
    let r = a.relate(b);
    match p {
        "within" => r.is_within(),
        "contains" => r.is_contains(),
        "touches" => r.is_touches(),
        "disjoint" => r.is_disjoint(),
        _ => r.is_intersects(),
    }
}
fn bounds_overlap(a: Option<geo::Rect<f64>>, b: Option<geo::Rect<f64>>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => {
            a.min().x <= b.max().x
                && a.max().x >= b.min().x
                && a.min().y <= b.max().y
                && a.max().y >= b.min().y
        }
        _ => false,
    }
}
fn bounded_relation(
    a: &Geometry<f64>,
    b: &Geometry<f64>,
    p: &str,
    ab: Option<geo::Rect<f64>>,
    bb: Option<geo::Rect<f64>>,
) -> bool {
    if !bounds_overlap(ab, bb) {
        return p == "disjoint";
    }
    relation(a, b, p)
}
fn properties(f: &Value, key: &str, value: Value) -> Value {
    let mut p = f
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut k = key.to_string();
    while p.contains_key(&k) {
        k.push('_');
    }
    p.insert(k, value);
    Value::Object(p)
}

fn without_id(mut f: Value) -> Value {
    if let Some(o) = f.as_object_mut() {
        o.remove("id");
    }
    f
}
// Compare numeric field values exactly across JSON spellings (1, 1.0, 1e0),
// without converting large integer identifiers through lossy f64.
fn group_key(value: &Value) -> Result<String, String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(v) => format!("bool:{v}"),
        Value::String(v) => format!("string:{}", serde_json::to_string(v).unwrap()),
        Value::Number(v) => {
            let text = v.to_string();
            let (sign, unsigned) = text
                .strip_prefix('-')
                .map(|s| ("-", s))
                .unwrap_or(("", text.as_str()));
            let mut pieces = unsigned.split(['e', 'E']);
            let coefficient = pieces.next().unwrap();
            let exponent: i64 = pieces
                .next()
                .unwrap_or("0")
                .parse()
                .map_err(|_| "分组字段数值指数超过支持范围")?;
            let decimals = coefficient
                .split_once('.')
                .map(|(_, s)| s.len())
                .unwrap_or(0);
            let digits = coefficient.replace('.', "");
            let digits = digits.trim_start_matches('0');
            if digits.is_empty() {
                "number:0".into()
            } else {
                let normalized = digits.trim_end_matches('0');
                let exponent = exponent
                    .checked_sub(decimals as i64)
                    .and_then(|e| e.checked_add((digits.len() - normalized.len()) as i64))
                    .ok_or("分组字段数值指数超过支持范围")?;
                format!("number:{sign}{normalized}e{exponent}")
            }
        }
        Value::Array(values) => format!(
            "array:{}",
            serde_json::to_string(
                &values
                    .iter()
                    .map(group_key)
                    .collect::<Result<Vec<_>, _>>()?
            )
            .unwrap()
        ),
        Value::Object(values) => format!(
            "object:{}",
            serde_json::to_string(
                &values
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), group_key(v)?)))
                    .collect::<Result<std::collections::BTreeMap<_, _>, String>>()?
            )
            .unwrap()
        ),
    })
}
fn push_bounded(out: &mut Vec<Value>, budget: &mut OutputBudget, f: Value) -> Result<(), String> {
    if out.len() >= MAX_FEATURES {
        return Err("结果超过 10000 个要素；未返回截断结果".into());
    }
    let vertices = budget
        .vertices
        .saturating_add(coordinate_count(&f["geometry"]["coordinates"]));
    if vertices > MAX_VERTICES {
        return Err("结果顶点总数超过 1000000；未返回截断结果".into());
    }
    let bytes = json_size(
        &f,
        budget.limit.saturating_sub(budget.bytes).saturating_sub(1),
    )?;
    budget.bytes = budget.bytes.saturating_add(bytes).saturating_add(1);
    budget.vertices = vertices;
    out.push(f);
    Ok(())
}
fn degenerate_hull(g: &Geometry<f64>) -> Geometry<f64> {
    let hull = g.convex_hull();
    if hull.unsigned_area() > 0.0 {
        Geometry::Polygon(hull)
    } else {
        let mut coords = hull.exterior().0.clone();
        coords.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
        coords.dedup();
        if coords.len() == 1 {
            Geometry::Point(geo::Point(coords[0]))
        } else {
            Geometry::LineString(geo::LineString(vec![coords[0], *coords.last().unwrap()]))
        }
    }
}
fn perimeter(g: &Geometry<f64>) -> f64 {
    match g {
        Geometry::LineString(l) => Euclidean.length(l),
        Geometry::MultiLineString(ls) => ls.0.iter().map(|l| Euclidean.length(l)).sum(),
        Geometry::Polygon(p) => {
            Euclidean.length(p.exterior())
                + p.interiors()
                    .iter()
                    .map(|r| Euclidean.length(r))
                    .sum::<f64>()
        }
        Geometry::MultiPolygon(ps) => {
            ps.0.iter()
                .map(|p| perimeter(&Geometry::Polygon(p.clone())))
                .sum()
        }
        _ => 0.0,
    }
}
fn unary(
    name: &str,
    args: &Value,
    source: &[Value],
    geometries: &[Geometry<f64>],
    output_limit: usize,
) -> Result<Value, String> {
    let metric = matches!(name, "simplify" | "geometry_attributes");
    let tolerance = if name == "simplify" {
        Some(
            args["toleranceMeters"]
                .as_f64()
                .filter(|d| d.is_finite() && *d > 0.0 && *d <= 100000.0)
                .ok_or("toleranceMeters 必须 > 0 且 <= 100000")?,
        )
    } else {
        None
    };
    let projection = if metric {
        Some(Projection::new(geometries)?)
    } else {
        None
    };
    let mut out = Vec::new();
    let mut output_budget = OutputBudget::new(output_limit);
    for (i, g) in geometries.iter().enumerate() {
        let f = &source[i];
        let elevations = Elevations::from_geometry(&f["geometry"]);
        let generated_count = match name {
            "multipart_to_singleparts" => match g {
                Geometry::MultiPoint(p) => p.0.len(),
                Geometry::MultiLineString(p) => p.0.len(),
                Geometry::MultiPolygon(p) => p.0.len(),
                _ => 1,
            },
            "extract_vertices" => match g {
                Geometry::Polygon(p) => g.coords_count().saturating_sub(1 + p.interiors().len()),
                Geometry::MultiPolygon(ps) => g
                    .coords_count()
                    .saturating_sub(ps.0.iter().map(|p| 1 + p.interiors().len()).sum()),
                _ => g.coords_count(),
            },
            _ => 1,
        };
        output_budget.repeated_properties(f, generated_count)?;
        let mut parts = Vec::new();
        match name {
            "centroid" => parts.push(Geometry::Point(g.centroid().ok_or("无法计算质心")?)),
            "point_on_surface" => {
                parts.push(Geometry::Point(g.interior_point().ok_or("无法计算表面点")?))
            }
            "convex_hull" => parts.push(degenerate_hull(g)),
            "envelope" => {
                let r = g.bounding_rect().ok_or("无法计算包络")?;
                parts.push(if r.min() == r.max() {
                    Geometry::Point(geo::Point(r.min()))
                } else if r.width() == 0.0 || r.height() == 0.0 {
                    Geometry::LineString(geo::LineString(vec![r.min(), r.max()]))
                } else {
                    Geometry::Polygon(r.to_polygon())
                });
            }
            "multipart_to_singleparts" => match g {
                Geometry::MultiPoint(ps) => parts.extend(ps.0.iter().copied().map(Geometry::Point)),
                Geometry::MultiLineString(ls) => {
                    parts.extend(ls.0.iter().cloned().map(Geometry::LineString))
                }
                Geometry::MultiPolygon(ps) => {
                    parts.extend(ps.0.iter().cloned().map(Geometry::Polygon))
                }
                _ => parts.push(g.clone()),
            },
            "polygon_to_lines" => {
                let ps = polygon(g)?;
                let lines =
                    ps.0.iter()
                        .flat_map(|p| std::iter::once(p.exterior()).chain(p.interiors().iter()))
                        .cloned()
                        .collect();
                parts.push(Geometry::MultiLineString(geo::MultiLineString(lines)));
            }
            "simplify" => {
                let projection = projection.as_ref().unwrap();
                let projected = projection.map(g, false);
                let tolerance = tolerance.unwrap();
                let simplified = match projected {
                    Geometry::LineString(l) => Geometry::LineString(l.simplify(tolerance)),
                    Geometry::MultiLineString(l) => {
                        Geometry::MultiLineString(l.simplify(tolerance))
                    }
                    Geometry::Polygon(p) => Geometry::Polygon(p.simplify(tolerance)),
                    Geometry::MultiPolygon(p) => Geometry::MultiPolygon(p.simplify(tolerance)),
                    _ => return Err("简化仅支持线或面几何".into()),
                };
                // Simplification retains input vertices. Recover their exact XY rather
                // than introducing round-trip projection noise that would lose their Z.
                use geo::MapCoords;
                let originals: std::collections::HashMap<_, _> = g
                    .coords_iter()
                    .zip(projection.map(g, false).coords_iter())
                    .map(|(raw, projected)| (xy_key(projected.x, projected.y), raw))
                    .collect();
                parts.push(simplified.map_coords(|c| originals[&xy_key(c.x, c.y)]));
            }
            "geometry_attributes" => {
                let projected = projection.as_ref().unwrap().map(g, false);
                let mut f = derived_feature(
                    f,
                    None,
                    properties(f, "_zgis_area_m2", json!(projected.unsigned_area())),
                );
                let p = properties(&f, "_zgis_length_m", json!(perimeter(&projected)));
                f["properties"] = p;
                push_bounded(&mut out, &mut output_budget, f)?;
                continue;
            }
            "extract_vertices" => {
                let rings: Vec<(usize, Option<usize>, Vec<geo::Coord<f64>>)> = match g {
                    Geometry::Polygon(p) => std::iter::once(p.exterior())
                        .chain(p.interiors().iter())
                        .enumerate()
                        .map(|(r, l)| (0, Some(r), l.0[..l.0.len() - 1].to_vec()))
                        .collect(),
                    Geometry::MultiPolygon(ps) => ps
                        .0
                        .iter()
                        .enumerate()
                        .flat_map(|(part, p)| {
                            std::iter::once(p.exterior())
                                .chain(p.interiors().iter())
                                .enumerate()
                                .map(move |(r, l)| (part, Some(r), l.0[..l.0.len() - 1].to_vec()))
                        })
                        .collect(),
                    Geometry::MultiLineString(ls) => {
                        ls.0.iter()
                            .enumerate()
                            .map(|(p, l)| (p, None, l.0.clone()))
                            .collect()
                    }
                    Geometry::MultiPoint(ps) => {
                        ps.0.iter()
                            .enumerate()
                            .map(|(p, v)| (p, None, vec![v.0]))
                            .collect()
                    }
                    _ => vec![(0, None, g.coords_iter().collect())],
                };
                for (part, ring, coords) in rings {
                    for (vertex, coord) in coords.into_iter().enumerate() {
                        let mut result = derived_with_elevations(
                            f,
                            Some(&Geometry::Point(geo::Point(coord))),
                            properties(f, "_zgis_part", json!(part)),
                            None,
                        );
                        let raw = &f["geometry"]["coordinates"];
                        let coordinates = match f["geometry"]["type"].as_str().unwrap() {
                            "Point" => raw,
                            "MultiPoint" => &raw[part],
                            "LineString" => &raw[vertex],
                            "MultiLineString" => &raw[part][vertex],
                            "Polygon" => &raw[ring.unwrap()][vertex],
                            "MultiPolygon" => &raw[part][ring.unwrap()][vertex],
                            _ => unreachable!(),
                        };
                        result["geometry"]["coordinates"] = coordinates.clone();
                        result["properties"] = properties(&result, "_zgis_ring", json!(ring));
                        result["properties"] = properties(&result, "_zgis_vertex", json!(vertex));
                        push_bounded(&mut out, &mut output_budget, without_id(result))?;
                    }
                }
                continue;
            }
            _ => return Err("未知单层工具".into()),
        }
        for (part_index, part) in parts.into_iter().enumerate() {
            let mut result =
                derived_with_elevations(f, Some(&part), f["properties"].clone(), Some(&elevations));
            let raw = &f["geometry"]["coordinates"];
            if name == "multipart_to_singleparts" {
                result["geometry"]["coordinates"] =
                    if f["geometry"]["type"].as_str().unwrap().starts_with("Multi") {
                        raw[part_index].clone()
                    } else {
                        raw.clone()
                    };
            } else if name == "polygon_to_lines" {
                result["geometry"]["coordinates"] = if f["geometry"]["type"] == "Polygon" {
                    raw.clone()
                } else {
                    Value::Array(
                        raw.as_array()
                            .unwrap()
                            .iter()
                            .flat_map(|p| p.as_array().unwrap().iter().cloned())
                            .collect(),
                    )
                };
            }
            push_bounded(
                &mut out,
                &mut output_budget,
                if name == "multipart_to_singleparts" {
                    without_id(result)
                } else {
                    result
                },
            )?;
        }
    }
    Ok(collection(out, metric))
}

pub fn analyze(
    name: &str,
    args: &Value,
    source: &[Value],
    target: Option<&[Value]>,
) -> Result<Value, String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        analyze_inner(name, args, source, target, MAX_OUTPUT_BYTES)
    }))
    .map_err(|_| "几何引擎拒绝此数据，分析未完成；请先检查几何有效性".to_string())??;
    json_size(&result, MAX_OUTPUT_BYTES)?;
    if let Some(features) = result.get("features").and_then(Value::as_array) {
        // Reject oversized generated geometry instead of returning a partial collection.
        decode(features, false).map_err(|e| {
            if name == "simplify" {
                format!("简化结果未通过校验，请降低容差: {e}")
            } else {
                format!("分析结果未通过校验: {e}")
            }
        })?;
    }
    Ok(result)
}

fn analyze_inner(
    name: &str,
    args: &Value,
    source: &[Value],
    target: Option<&[Value]>,
    output_limit: usize,
) -> Result<Value, String> {
    let schema = tool_definitions()
        .into_iter()
        .find(|t| t["name"] == name)
        .ok_or("未知空间工具")?;
    let obj = args.as_object().ok_or("参数必须为对象")?;
    for key in obj.keys() {
        if schema["inputSchema"]["properties"].get(key).is_none() {
            return Err(format!("未知参数: {key}"));
        }
    }
    let predicate = match args.get("predicate") {
        Some(v) => v.as_str().ok_or("predicate 必须为字符串")?,
        None => "intersects",
    };
    if !["intersects", "within", "contains", "touches", "disjoint"].contains(&predicate) {
        return Err("不支持的空间谓词".into());
    }
    if name == "topology_check" {
        return topology(source);
    }
    let s = decode(source, false)?;
    if matches!(
        name,
        "centroid"
            | "point_on_surface"
            | "convex_hull"
            | "envelope"
            | "multipart_to_singleparts"
            | "extract_vertices"
            | "polygon_to_lines"
            | "simplify"
            | "geometry_attributes"
    ) {
        return unary(name, args, source, &s, output_limit);
    }
    if name == "layer_summary" {
        let bounds = s.iter().filter_map(BoundingRect::bounding_rect).fold(
            None,
            |acc: Option<[f64; 4]>, r| {
                Some(match acc {
                    None => [r.min().x, r.min().y, r.max().x, r.max().y],
                    Some(a) => [
                        a[0].min(r.min().x),
                        a[1].min(r.min().y),
                        a[2].max(r.max().x),
                        a[3].max(r.max().y),
                    ],
                })
            },
        );
        let mut types = std::collections::BTreeMap::<String, usize>::new();
        let mut fields = std::collections::BTreeSet::new();
        for f in source {
            *types
                .entry(f["geometry"]["type"].as_str().unwrap_or("").into())
                .or_default() += 1;
            if let Some(p) = f["properties"].as_object() {
                fields.extend(p.keys().cloned());
            }
        }
        return Ok(
            json!({"featureCount":s.len(),"geometryTypes":types,"fields":fields,"bbox":bounds,"crs":"EPSG:4326"}),
        );
    }
    if name == "buffer" {
        let distance = args["distanceMeters"]
            .as_f64()
            .filter(|d| *d > 0.0 && *d <= 100000.0)
            .ok_or("distanceMeters 必须 > 0 且 <= 100000")?;
        let projection = Projection::new(&s)?;
        let mut out = Vec::new();
        let mut output_budget = OutputBudget::new(output_limit);
        for (i, g) in s.iter().enumerate() {
            let projected = projection.map(g, false);
            let result = Geometry::MultiPolygon(projected.buffer(distance));
            push_bounded(
                &mut out,
                &mut output_budget,
                derived_feature(
                    &source[i],
                    Some(&projection.map(&result, true)),
                    source[i]["properties"].clone(),
                ),
            )?;
        }
        return Ok(collection(out, true));
    }
    if name == "dissolve" {
        let group_by = match args.get("groupBy") {
            Some(v) => Some(
                v.as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or("groupBy 必须是非空字符串")?,
            ),
            None => None,
        };
        let mut groups = std::collections::BTreeMap::<
            String,
            (Value, MultiPolygon<f64>, usize, Elevations),
        >::new();
        for (i, g) in s.iter().enumerate() {
            let value = if let Some(field) = group_by {
                source[i]["properties"]
                    .get(field)
                    .cloned()
                    .ok_or_else(|| format!("要素 {i} 缺少分组字段 {field}"))?
            } else {
                Value::Null
            };
            let key = group_key(&value)?;
            let group = groups
                .entry(key)
                .or_insert_with(|| (value, MultiPolygon(vec![]), 0, Elevations::default()));
            let next = polygon(g)?;
            group.3.add(&source[i]["geometry"]["coordinates"]);
            group.3.quantize(&group.1, &next);
            group.1 = group.1.union(&next);
            group.2 += 1;
        }
        let mut out = Vec::new();
        let mut output_budget = OutputBudget::new(output_limit);
        for (_, (value, union, count, elevations)) in groups {
            if !union.0.is_empty() {
                let mut p = serde_json::Map::new();
                if let Some(field) = group_by {
                    p.insert(field.into(), value);
                }
                let mut f = feature(&Geometry::MultiPolygon(union), Value::Object(p));
                elevations.apply(&mut f["geometry"]);
                let p = properties(&f, "sourceCount", json!(count));
                push_bounded(&mut out, &mut output_budget, derived_feature(&f, None, p))?;
            }
        }
        return Ok(collection(out, false));
    }
    let mut t = decode(target.unwrap_or(&[]), false)?;
    if name == "merge" {
        if target.is_none() {
            return Err("需要 target".into());
        }
        if source.len().saturating_add(t.len()) > MAX_FEATURES {
            return Err("合并结果超过 10000 个要素".into());
        }
        let mut out = Vec::new();
        let mut output_budget = OutputBudget::new(output_limit);
        let xyz = source
            .iter()
            .chain(target.unwrap().iter())
            .any(|f| Elevations::from_geometry(&f["geometry"]).xyz);
        for f in source.iter().chain(target.unwrap().iter()) {
            output_budget.repeated_properties(f, 1)?;
            let mut result = without_id(f.clone());
            if xyz {
                promote_xyz(&mut result["geometry"]["coordinates"]);
            }
            push_bounded(&mut out, &mut output_budget, result)?;
        }
        return Ok(collection(out, false));
    }
    if name == "spatial_query" {
        if let Some(b) = args.get("bbox") {
            let a = b
                .as_array()
                .filter(|a| a.len() == 4)
                .ok_or("bbox 必须有四个数值")?;
            let n: Vec<f64> = a
                .iter()
                .map(|v| v.as_f64().ok_or("bbox 必须为数值"))
                .collect::<Result<_, _>>()?;
            if n[0] >= n[2]
                || n[1] >= n[3]
                || n[0] < -180.0
                || n[2] > 180.0
                || n[1] < -90.0
                || n[3] > 90.0
                || n[2] - n[0] > 180.0
            {
                return Err("bbox 范围无效".into());
            }
            t.push(Geometry::Polygon(
                geo::Rect::new((n[0], n[1]), (n[2], n[3])).to_polygon(),
            ));
        }
    }
    if t.is_empty() {
        return Err("需要非空 target 或 bbox".into());
    }
    if s.len().saturating_mul(t.len()) > MAX_PAIRS {
        return Err("候选对超过 1000000，请缩小输入范围".into());
    }
    let source_bounds: Vec<_> = s.iter().map(BoundingRect::bounding_rect).collect();
    let target_bounds: Vec<_> = t.iter().map(BoundingRect::bounding_rect).collect();
    let mut out = Vec::new();
    let mut output_budget = OutputBudget::new(output_limit);
    if name == "count_points" {
        let mut points = Vec::new();
        for g in &t {
            match g {
                Geometry::Point(p) => points.push(*p),
                Geometry::MultiPoint(ps) => points.extend(ps.0.iter().copied()),
                _ => return Err("目标图层仅支持 Point/MultiPoint".into()),
            }
        }
        if s.len().saturating_mul(points.len()) > MAX_PAIRS {
            return Err("点计数候选对超过 1000000".into());
        }
        for (i, g) in s.iter().enumerate() {
            polygon(g)?;
            let count = points
                .iter()
                .filter(|p| {
                    bounded_relation(
                        g, &Geometry::Point(**p), "intersects",
                        source_bounds[i],
                        Some(p.bounding_rect()),
                    )
                })
                .count();
            push_bounded(
                &mut out,
                &mut output_budget,
                derived_feature(
                    &source[i],
                    None,
                    properties(&source[i], "_zgis_point_count", json!(count)),
                ),
            )?;
        }
        return Ok(collection(out, false));
    }
    if matches!(name, "intersection" | "difference" | "symmetric_difference") {
        let sp = s.iter().map(polygon).collect::<Result<Vec<_>, _>>()?;
        let tp = t.iter().map(polygon).collect::<Result<Vec<_>, _>>()?;
        if name == "intersection" {
            for (i, a) in sp.iter().enumerate() {
                for (j, b) in tp.iter().enumerate() {
                    if !bounds_overlap(source_bounds[i], target_bounds[j]) {
                        continue;
                    }
                    let result = a.intersection(b);
                    if result.0.is_empty() {
                        continue;
                    }
                    let elevations = Elevations::for_overlay(&source[i], a, b);
                    let mut f = derived_with_elevations(
                        &source[i],
                        Some(&Geometry::MultiPolygon(result)),
                        source[i]["properties"].clone(),
                        Some(&elevations),
                    );
                    if let Some(p) = target.unwrap()[j]["properties"].as_object() {
                        for (key, value) in p {
                            f["properties"] =
                                properties(&f, &format!("target_{key}"), value.clone());
                        }
                    }
                    push_bounded(&mut out, &mut output_budget, without_id(f))?;
                }
            }
        } else {
            let target_union = tp.iter().fold(MultiPolygon(vec![]), |a, b| a.union(b));
            for (i, a) in sp.iter().enumerate() {
                let result = a.difference(&target_union);
                let elevations = Elevations::for_overlay(&source[i], a, &target_union);
                if !result.0.is_empty() {
                    push_bounded(
                        &mut out,
                        &mut output_budget,
                        derived_with_elevations(
                            &source[i],
                            Some(&Geometry::MultiPolygon(result)),
                            source[i]["properties"].clone(),
                            Some(&elevations),
                        ),
                    )?;
                }
            }
            if name == "symmetric_difference" {
                let source_union = sp.iter().fold(MultiPolygon(vec![]), |a, b| a.union(b));
                for (i, b) in tp.iter().enumerate() {
                    let result = b.difference(&source_union);
                    let elevations = Elevations::for_overlay(&target.unwrap()[i], b, &source_union);
                    if !result.0.is_empty() {
                        push_bounded(
                            &mut out,
                            &mut output_budget,
                            without_id(derived_with_elevations(
                                &target.unwrap()[i],
                                Some(&Geometry::MultiPolygon(result)),
                                target.unwrap()[i]["properties"].clone(),
                                Some(&elevations),
                            )),
                        )?;
                    }
                }
                out = out.into_iter().map(without_id).collect();
            }
        }
        return Ok(collection(out, false));
    }
    if name == "nearest" {
        let projection = Projection::from_geometries(s.iter().chain(t.iter()))?;
        use geo::{Distance, Euclidean};
        let projected: Vec<_> = t.iter().map(|g| projection.map(g, false)).collect();
        for (i, g) in s.iter().enumerate() {
            let a = projection.map(g, false);
            let (index, distance) = projected
                .iter()
                .enumerate()
                .map(|(j, b)| (j, Euclidean.distance(&a, b)))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .ok_or("目标为空")?;
            push_bounded(
                &mut out,
                &mut output_budget,
                derived_feature(
                    &source[i],
                    None,
                    properties(
                        &source[i],
                        "_zgis_nearest",
                        json!({"targetIndex":index,"distanceMeters":distance}),
                    ),
                ),
            )?;
        }
        return Ok(collection(out, true));
    }
    if name == "clip" {
        let mut mask = MultiPolygon(vec![]);
        for g in &t {
            mask = mask.union(&polygon(g)?);
        }
        for (i, g) in s.iter().enumerate() {
            let input = polygon(g)?;
            let clipped = input.intersection(&mask);
            let elevations = Elevations::for_overlay(&source[i], &input, &mask);
            if !clipped.0.is_empty() {
                push_bounded(
                    &mut out,
                    &mut output_budget,
                    derived_with_elevations(
                        &source[i],
                        Some(&Geometry::MultiPolygon(clipped)),
                        source[i]["properties"].clone(),
                        Some(&elevations),
                    ),
                )?;
            }
        }
        return Ok(collection(out, false));
    }
    for (i, g) in s.iter().enumerate() {
        if name == "spatial_query" {
            let mut matches = t.iter().enumerate().map(|(j, b)| {
                bounded_relation(g, b, predicate, source_bounds[i], target_bounds[j])
            });
            if if predicate == "disjoint" {
                matches.all(|matched| matched)
            } else {
                matches.any(|matched| matched)
            } {
                push_bounded(&mut out, &mut output_budget, source[i].clone())?;
            }
        } else {
            let matches: Vec<_> = t
                .iter()
                .enumerate()
                .filter(|(j, b)| {
                    bounded_relation(g, b, predicate, source_bounds[i], target_bounds[*j])
                })
                .map(|(j, _)| j)
                .collect();
            push_bounded(
                &mut out,
                &mut output_budget,
                derived_feature(
                    &source[i],
                    None,
                    properties(
                        &source[i],
                        "_zgis_join",
                        json!({"count":matches.len(),"targetIndices":matches}),
                    ),
                ),
            )?;
        }
    }
    Ok(collection(out, false))
}

struct Projection {
    lon: f64,
    lat: f64,
    cos: f64,
}
impl Projection {
    fn new(gs: &[Geometry<f64>]) -> Result<Self, String> {
        Self::from_geometries(gs.iter())
    }
    fn from_geometries<'a>(gs: impl Iterator<Item = &'a Geometry<f64>>) -> Result<Self, String> {
        let mut coords = gs.flat_map(CoordsIter::coords_iter);
        let Some(first) = coords.next() else {
            return Err("没有可计算坐标".into());
        };
        let (xmin, xmax, ymin, ymax) = coords.fold(
            (first.x, first.x, first.y, first.y),
            |(xmin, xmax, ymin, ymax), c| {
                (xmin.min(c.x), xmax.max(c.x), ymin.min(c.y), ymax.max(c.y))
            },
        );
        if ymin.abs() > 75.0 || ymax.abs() > 75.0 || xmax - xmin > 5.0 || ymax - ymin > 5.0 {
            return Err("米制近似仅支持纬度 ±75° 内、经纬跨度不超过 5° 的局部数据".into());
        }
        let lat = (ymin + ymax) / 2.0;
        Ok(Self {
            lon: (xmin + xmax) / 2.0,
            lat,
            cos: lat.to_radians().cos(),
        })
    }
    fn map(&self, g: &Geometry<f64>, inverse: bool) -> Geometry<f64> {
        use geo::MapCoords;
        let scale = 6371008.8 * std::f64::consts::PI / 180.0;
        g.map_coords(|c| {
            if inverse {
                geo::Coord {
                    x: c.x / (scale * self.cos) + self.lon,
                    y: c.y / scale + self.lat,
                }
            } else {
                geo::Coord {
                    x: (c.x - self.lon) * scale * self.cos,
                    y: (c.y - self.lat) * scale,
                }
            }
        })
    }
}
fn topology(source: &[Value]) -> Result<Value, String> {
    if source.len() > MAX_FEATURES
        || source.len().saturating_mul(source.len().saturating_sub(1)) / 2 > MAX_PAIRS
    {
        return Err("拓扑检查规模超过上限，请缩小输入范围".into());
    }
    topology_preflight(source, MAX_VERTICES)?;
    let mut issues = Vec::new();
    let mut geometries = Vec::new();
    for (i, f) in source.iter().enumerate() {
        match decode(std::slice::from_ref(f), true) {
            Ok(mut gs) => {
                let g = gs.remove(0);
                if !g.is_valid() {
                    issues.push(json!({"kind":"invalid_geometry","featureIndex":i}));
                    geometries.push(None);
                } else {
                    geometries.push(Some(g));
                }
            }
            Err(e) => {
                issues.push(json!({"kind":"invalid_geometry","featureIndex":i,"message":e}));
                geometries.push(None);
            }
        }
    }
    let bounds: Vec<_> = geometries
        .iter()
        .map(|g| g.as_ref().and_then(BoundingRect::bounding_rect))
        .collect();
    for i in 0..source.len() {
        for j in i + 1..source.len() {
            if source[i]["geometry"] == source[j]["geometry"] {
                issues.push(json!({"kind":"duplicate_geometry","featureIndices":[i,j]}));
            } else if let (Some(a), Some(b)) = (&geometries[i], &geometries[j]) {
                if !bounds_overlap(bounds[i], bounds[j]) {
                    continue;
                }
                if let (Ok(a), Ok(b)) = (polygon(a), polygon(b)) {
                    use geo::Area;
                    if a.intersection(&b).unsigned_area() > 0.0 {
                        issues.push(json!({"kind":"polygon_overlap","featureIndices":[i,j]}));
                    }
                }
            }
            if issues.len() > MAX_FEATURES {
                return Err("拓扑问题超过 10000，请缩小输入范围；未返回截断报告".into());
            }
        }
    }
    Ok(
        json!({"featureCount":source.len(),"issues":issues,"valid":issues.is_empty(),"relationModel":"WGS84 planar","checks":["geometry_validity","exact_geometry_duplicates","polygon_overlap"]}),
    )
}

fn topology_preflight(source: &[Value], vertex_limit: usize) -> Result<(), String> {
    fn dimensions(v: &Value) -> Result<(), String> {
        if let Some(a) = v.as_array() {
            if !a.is_empty() && a.iter().all(|v| !v.is_array()) {
                if a.len() > 3 {
                    return Err("仅支持 XY/XYZ 坐标，不支持 M/ZM".into());
                }
                if a.len() == 3 && !a[2].as_f64().is_some_and(f64::is_finite) {
                    return Err("高程 Z 必须为有限数值".into());
                }
            } else {
                for item in a {
                    dimensions(item)?;
                }
            }
        }
        Ok(())
    }
    let mut vertices = 0usize;
    for f in source {
        if let Some(kind) = f["geometry"]["type"].as_str() {
            if ![
                "Point",
                "MultiPoint",
                "LineString",
                "MultiLineString",
                "Polygon",
                "MultiPolygon",
            ]
            .contains(&kind)
            {
                return Err(format!("不支持几何类型 {kind}"));
            }
        }
        let coords = &f["geometry"]["coordinates"];
        vertices = vertices.saturating_add(coordinate_count(coords));
        if vertices > vertex_limit {
            return Err("拓扑检查顶点总数超过上限；未返回截断报告".into());
        }
        dimensions(coords)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn add_z(f: &mut Value, z: f64) {
        promote_xyz(&mut f["geometry"]["coordinates"]);
        fn set(v: &mut Value, z: f64) {
            let a = v.as_array_mut().unwrap();
            if a[0].is_number() {
                a[2] = json!(z);
            } else {
                for item in a {
                    set(item, z);
                }
            }
        }
        set(&mut f["geometry"]["coordinates"], z);
    }
    fn all_xyz(v: &Value) -> bool {
        let a = v.as_array().unwrap();
        if a.is_empty() {
            return true;
        }
        if a[0].is_number() {
            a.len() == 3 && a[2].as_f64().is_some_and(f64::is_finite)
        } else {
            a.iter().all(all_xyz)
        }
    }
    #[test]
    fn every_analysis_accepts_xyz_and_preserves_output_dimension() {
        let mut a = square(0., 0., 0.01);
        let mut b = square(0.005, 0.005, 0.01);
        add_z(&mut a, 17.);
        add_z(&mut b, 91.);
        let mut pt = point(0.007, 0.007);
        add_z(&mut pt, 5.);
        for tool in tool_definitions() {
            let name = tool["name"].as_str().unwrap();
            let args = match name {
                "buffer" => json!({"distanceMeters":10}),
                "simplify" => json!({"toleranceMeters":1}),
                _ => json!({}),
            };
            let target = if name == "count_points" {
                vec![pt.clone()]
            } else {
                vec![b.clone()]
            };
            let result = analyze(name, &args, &[a.clone()], Some(&target))
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            if let Some(features) = result["features"].as_array() {
                assert!(!features.is_empty(), "{name}");
                for f in features {
                    assert!(all_xyz(&f["geometry"]["coordinates"]), "{name}: {f}");
                }
            }
        }
        let centroid = analyze("centroid", &json!({}), &[a.clone()], None).unwrap();
        assert_eq!(centroid["features"][0]["geometry"]["coordinates"][2], 0);
        let buffer = analyze("buffer", &json!({"distanceMeters":10}), &[pt], None).unwrap();
        assert!(buffer["features"][0]["geometry"]["coordinates"][0][0]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c[2] == 0));
        let overlay = analyze("intersection", &json!({}), &[a], Some(&[b])).unwrap();
        let vertices = overlay["features"][0]["geometry"]["coordinates"][0][0]
            .as_array()
            .unwrap();
        assert!(
            vertices
                .iter()
                .any(|c| (c[0].as_f64().unwrap() - 0.01).abs() < 1e-10
                    && (c[1].as_f64().unwrap() - 0.01).abs() < 1e-10
                    && c[2] == 17.0),
            "{vertices:?}"
        );
        assert!(vertices.iter().any(|c| c[2] == 0));
    }
    #[test]
    fn structural_operations_keep_distinct_z_at_same_xy_and_holes() {
        let f = json!({"type":"Feature","geometry":{"type":"MultiPoint","coordinates":[[0,0,11],[0,0,22]]},"properties":{}});
        for name in ["extract_vertices", "multipart_to_singleparts"] {
            let r = analyze(name, &json!({}), &[f.clone()], None).unwrap();
            assert_eq!(
                r["features"][0]["geometry"]["coordinates"],
                json!([0, 0, 11])
            );
            assert_eq!(
                r["features"][1]["geometry"]["coordinates"],
                json!([0, 0, 22])
            );
        }
        let mut hole = hole_polygon();
        add_z(&mut hole, 47.);
        let lines = analyze("polygon_to_lines", &json!({}), &[hole.clone()], None).unwrap();
        assert_eq!(
            lines["features"][0]["geometry"]["coordinates"],
            hole["geometry"]["coordinates"]
        );
        let vertices = analyze("extract_vertices", &json!({}), &[hole], None).unwrap();
        assert_eq!(vertices["features"].as_array().unwrap().len(), 8);
        assert!(vertices["features"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f["geometry"]["coordinates"][2] == 47.0));
    }
    #[test]
    fn simplify_preserves_z_and_merge_promotes_only_missing_z() {
        let line = json!({"type":"Feature","geometry":{"type":"LineString","coordinates":[[116.01,40.01,11],[116.015,40.015,22],[116.02,40.02,33]]},"properties":{}});
        let result = analyze("simplify", &json!({"toleranceMeters":1}), &[line], None).unwrap();
        assert_eq!(
            result["features"][0]["geometry"]["coordinates"],
            json!([[116.01, 40.01, 11], [116.02, 40.02, 33]])
        );
        let mut p = point(0., 0.);
        add_z(&mut p, 12.);
        let merged = analyze("merge", &json!({}), &[p.clone()], Some(&[point(1., 1.)])).unwrap();
        assert_eq!(merged["features"][0]["geometry"], p["geometry"]);
        assert_eq!(
            merged["features"][1]["geometry"]["coordinates"],
            json!([1., 1., 0])
        );
        let two_d = analyze("centroid", &json!({}), &[point(0., 0.)], None).unwrap();
        assert_eq!(
            two_d["features"][0]["geometry"]["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn elevation_is_feature_local_and_conflicts_are_zero() {
        let mut a = square(0., 0., 0.01);
        let mut b = a.clone();
        add_z(&mut a, 11.);
        add_z(&mut b, 22.);
        let hulls = analyze("convex_hull", &json!({}), &[a.clone(), b.clone()], None).unwrap();
        for (i, z) in [11., 22.].into_iter().enumerate() {
            assert!(hulls["features"][i]["geometry"]["coordinates"][0]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c[2] == z));
        }
        let dissolved = analyze("dissolve", &json!({}), &[a, b], None).unwrap();
        assert!(dissolved["features"][0]["geometry"]["coordinates"][0][0]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c[2] == 0));
        let malformed = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[0,0,"bad"]},"properties":{}});
        assert!(analyze("centroid", &json!({}), &[malformed.clone()], None).is_err());
        assert!(analyze("topology_check", &json!({}), &[malformed], None).is_err());
        let unclosed_z = json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0,1],[1,0,1],[1,1,1],[0,0,2]]]},"properties":{}});
        assert!(analyze("layer_summary", &json!({}), &[unclosed_z], None).is_err());
        let numeric_closed = json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0,1],[1,0,1],[1,1,1],[0.0,0.0,1.0]]]},"properties":{}});
        assert!(analyze("layer_summary", &json!({}), &[numeric_closed], None).is_ok());
        let mixed = json!({"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,0,1],[1,1]]},"properties":{}});
        assert!(analyze("centroid", &json!({}), &[mixed], None).is_err());
    }
    #[test]
    fn output_byte_budget_checks_every_collection_algorithm() {
        let mut p = square(0., 0., 0.001);
        p["properties"]["large"] = json!("属性内容".repeat(100));
        let src = vec![p.clone(); 4];
        let target = vec![p.clone()];
        for (name, args, target) in [
            ("buffer", json!({"distanceMeters":10}), None),
            ("clip", json!({}), Some(target.as_slice())),
            ("dissolve", json!({"groupBy":"large"}), None),
            ("nearest", json!({}), Some(target.as_slice())),
            ("spatial_join", json!({}), Some(target.as_slice())),
            ("spatial_query", json!({}), Some(target.as_slice())),
            ("centroid", json!({}), None),
            ("point_on_surface", json!({}), None),
            ("convex_hull", json!({}), None),
            ("envelope", json!({}), None),
            ("multipart_to_singleparts", json!({}), None),
            ("extract_vertices", json!({}), None),
            ("polygon_to_lines", json!({}), None),
            ("simplify", json!({"toleranceMeters":10}), None),
            ("geometry_attributes", json!({}), None),
            ("intersection", json!({}), Some(target.as_slice())),
            ("merge", json!({}), Some(target.as_slice())),
        ] {
            let error = analyze_inner(name, &args, &src, target, 1024).unwrap_err();
            assert!(error.contains("100 MiB"), "{name}: {error}");
        }
        let far = vec![square(0.002, 0., 0.001)];
        for name in ["difference", "symmetric_difference"] {
            assert!(analyze_inner(name, &json!({}), &src, Some(&far), 1024)
                .unwrap_err()
                .contains("100 MiB"));
        }
        assert!(analyze_inner(
            "count_points",
            &json!({}),
            &src,
            Some(&[point(0., 0.)]),
            1024
        )
        .unwrap_err()
        .contains("100 MiB"));
    }
    #[test]
    fn streaming_byte_counter_and_attribute_replication_preflight() {
        let f = json!({"geometry":{"type":"Point","coordinates":[0,0]},"properties":{"text":"中文 \"\\\n".repeat(20)}});
        let bytes = serde_json::to_vec(&f).unwrap().len();
        assert_eq!(json_size(&f, bytes).unwrap(), bytes);
        assert!(json_size(&f, bytes - 1).is_err());
        let mut budget = OutputBudget::new(1024);
        assert!(budget.repeated_properties(&f, 10000).is_err());
        let mut out = Vec::new();
        push_bounded(&mut out, &mut budget, f.clone()).unwrap();
        let before = out.len();
        let prior_bytes = budget.bytes;
        while push_bounded(&mut out, &mut budget, f.clone()).is_ok() {}
        assert!(out.len() >= before && budget.bytes >= prior_bytes && budget.bytes <= budget.limit);
        let before = (out.len(), budget.bytes, budget.vertices);
        assert!(push_bounded(&mut out, &mut budget, f).is_err());
        assert_eq!(before, (out.len(), budget.bytes, budget.vertices));
    }
    #[test]
    fn topology_preflight_counts_invalid_rings_and_rejects_unsupported_dimensions() {
        let invalid = json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]},"properties":{}});
        assert!(topology_preflight(&[invalid.clone()], 4).is_ok());
        assert!(topology_preflight(&[invalid.clone()], 3)
            .unwrap_err()
            .contains("顶点总数"));
        assert!(topology_preflight(&[invalid.clone(), invalid], 7)
            .unwrap_err()
            .contains("顶点总数"));
        let z = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[0,0,5,1]},"properties":{}});
        assert!(analyze("topology_check", &json!({}), &[z], None)
            .unwrap_err()
            .contains("M/ZM"));
        let collection = json!({"type":"Feature","geometry":{"type":"GeometryCollection","geometries":[]},"properties":{}});
        assert!(analyze("topology_check", &json!({}), &[collection], None)
            .unwrap_err()
            .contains("不支持"));
    }
    fn hole_polygon() -> Value {
        json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,3],[3,3],[3,1],[1,1]]]},"properties":{"name":"donut"},"id":"original"})
    }
    fn total_area(result: &Value) -> f64 {
        decode(result["features"].as_array().unwrap(), false)
            .unwrap()
            .iter()
            .map(Area::unsigned_area)
            .sum()
    }
    #[test]
    fn extended_overlay_preserves_holes_and_both_attributes() {
        let mut a = hole_polygon();
        a["properties"]["target_name"] = json!("keep");
        let mut b = square(2., 0., 2.);
        b["properties"]["name"] = json!("target");
        b["id"] = json!("original");
        let intersection =
            analyze("intersection", &json!({}), &[a.clone()], Some(&[b.clone()])).unwrap();
        assert!((total_area(&intersection) - 3.).abs() < 1e-9);
        assert_eq!(intersection["features"][0]["properties"]["name"], "donut");
        assert_eq!(
            intersection["features"][0]["properties"]["target_name"],
            "keep"
        );
        assert_eq!(
            intersection["features"][0]["properties"]["target_name_"],
            "target"
        );
        assert!(intersection["features"][0].get("id").is_none());
        let difference =
            analyze("difference", &json!({}), &[a.clone()], Some(&[b.clone()])).unwrap();
        assert!((total_area(&difference) - 9.).abs() < 1e-9);
        assert_eq!(difference["features"][0]["id"], "original");
        let symmetric = analyze("symmetric_difference", &json!({}), &[a], Some(&[b])).unwrap();
        assert!((total_area(&symmetric) - 10.).abs() < 1e-9);
        assert_eq!(symmetric["features"].as_array().unwrap().len(), 2);
        assert_eq!(symmetric["features"][1]["properties"]["name"], "target");
        assert!(symmetric["features"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f.get("id").is_none()));
    }
    #[test]
    fn dissolve_group_type_value_and_missing_field() {
        let mut features: Vec<_> = (0..5).map(|i| square(i as f64, 0., 2.)).collect();
        for (f, v) in
            features
                .iter_mut()
                .zip([json!(1), json!(1.0), json!("1"), json!(true), Value::Null])
        {
            f["properties"]["group"] = v;
        }
        let result = analyze("dissolve", &json!({"groupBy":"group"}), &features, None).unwrap();
        let fs = result["features"].as_array().unwrap();
        assert_eq!(fs.len(), 4);
        let numeric = fs
            .iter()
            .find(|f| f["properties"]["group"].is_number())
            .unwrap();
        assert_eq!(numeric["properties"]["sourceCount"], 2);
        assert!((total_area(&result) - 18.).abs() < 1e-9);
        assert!(
            analyze("dissolve", &json!({"groupBy":"missing"}), &features, None)
                .unwrap_err()
                .contains("缺少分组字段")
        );
        for value in [json!(""), json!(1), Value::Null] {
            assert!(analyze("dissolve", &json!({"groupBy":value}), &features, None).is_err());
        }
        let mut f = square(0., 0., 1.);
        f["properties"]["sourceCount"] = json!("group value");
        let result = analyze("dissolve", &json!({"groupBy":"sourceCount"}), &[f], None).unwrap();
        assert_eq!(
            result["features"][0]["properties"]["sourceCount"],
            "group value"
        );
        assert_eq!(result["features"][0]["properties"]["sourceCount_"], 1);
        assert_eq!(
            group_key(&json!(-0.0)).unwrap(),
            group_key(&json!(0)).unwrap()
        );
        assert_eq!(
            group_key(&serde_json::from_str::<Value>("1e0").unwrap()).unwrap(),
            group_key(&json!(1)).unwrap()
        );
        assert_ne!(
            group_key(&json!(9007199254740992u64)).unwrap(),
            group_key(&json!(9007199254740993u64)).unwrap()
        );
    }
    #[test]
    fn representative_points_hulls_and_degenerate_envelopes() {
        let p = hole_polygon();
        let centroid = analyze("centroid", &json!({}), &[p.clone()], None).unwrap();
        assert_eq!(
            centroid["features"][0]["geometry"]["coordinates"],
            json!([2., 2.])
        );
        let surface = analyze("point_on_surface", &json!({}), &[p.clone()], None).unwrap();
        let surface = decode(surface["features"].as_array().unwrap(), false).unwrap();
        assert!(relation(
            &surface[0],
            &decode(&[p.clone()], false).unwrap()[0],
            "within"
        ));
        for tool in ["convex_hull", "envelope"] {
            assert!(
                (total_area(&analyze(tool, &json!({}), &[p.clone()], None).unwrap()) - 16.).abs()
                    < 1e-9
            );
            let result = analyze(tool, &json!({}), &[point(1., 1.)], None).unwrap();
            assert_eq!(result["features"][0]["geometry"]["type"], "Point");
            let line = json!({"type":"Feature","geometry":{"type":"LineString","coordinates":[[1,1],[1,2],[1,3]]},"properties":{}});
            let result = analyze(tool, &json!({}), &[line], None).unwrap();
            assert_eq!(result["features"][0]["geometry"]["type"], "LineString");
        }
    }
    #[test]
    fn part_vertex_and_boundary_conversion_preserves_semantics() {
        let p = hole_polygon();
        let lines = analyze("polygon_to_lines", &json!({}), &[p.clone()], None).unwrap();
        assert_eq!(lines["features"][0]["geometry"]["type"], "MultiLineString");
        assert_eq!(
            lines["features"][0]["geometry"]["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let vertices = analyze("extract_vertices", &json!({}), &[p.clone()], None).unwrap();
        let fs = vertices["features"].as_array().unwrap();
        assert_eq!(fs.len(), 8);
        assert_eq!(fs[4]["properties"]["_zgis_ring"], 1);
        assert_eq!(fs[4]["properties"]["_zgis_vertex"], 0);
        assert!(fs
            .iter()
            .all(|f| f.get("id").is_none() && f["properties"]["name"] == "donut"));
        let mut multi = p.clone();
        multi["geometry"] = json!({"type":"MultiPolygon","coordinates":[p["geometry"]["coordinates"],square(10.,0.,1.)["geometry"]["coordinates"]]});
        let single = analyze("multipart_to_singleparts", &json!({}), &[multi], None).unwrap();
        assert_eq!(single["features"].as_array().unwrap().len(), 2);
        assert!((total_area(&single) - 13.).abs() < 1e-9);
        assert!(single["features"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f.get("id").is_none()));
        assert!(analyze("polygon_to_lines", &json!({}), &[point(0., 0.)], None).is_err());
    }
    #[test]
    fn count_points_includes_boundary_and_multi_points_but_excludes_holes() {
        let target = json!({"type":"Feature","geometry":{"type":"MultiPoint","coordinates":[[0.5,0.5],[2,2],[0,2],[1,2],[5,5]]},"properties":{}});
        let result = analyze(
            "count_points",
            &json!({}),
            &[hole_polygon()],
            Some(&[target]),
        )
        .unwrap();
        assert_eq!(result["features"][0]["properties"]["_zgis_point_count"], 3);
        assert_eq!(result["features"][0]["id"], "original");
        assert!(analyze(
            "count_points",
            &json!({}),
            &[point(0., 0.)],
            Some(&[point(0., 0.)])
        )
        .is_err());
        assert!(analyze(
            "count_points",
            &json!({}),
            &[hole_polygon()],
            Some(&[square(0., 0., 1.)])
        )
        .is_err());
    }
    #[test]
    fn metric_attributes_area_length_and_field_collisions() {
        let mut p = square(0., 0., 0.001);
        p["properties"]["_zgis_area_m2"] = json!("original");
        let result = analyze("geometry_attributes", &json!({}), &[p], None).unwrap();
        let props = &result["features"][0]["properties"];
        assert_eq!(props["_zgis_area_m2"], "original");
        assert!((props["_zgis_area_m2_"].as_f64().unwrap() - 12364.35).abs() < 1.);
        assert!((props["_zgis_length_m"].as_f64().unwrap() - 444.78).abs() < 0.1);
        assert_eq!(result["analysis"]["geodesic"], false);
        let result = analyze("geometry_attributes", &json!({}), &[hole_polygon()], None).unwrap();
        let props = &result["features"][0]["properties"];
        let scale = 6371008.8 * std::f64::consts::PI / 180.;
        assert!(
            (props["_zgis_area_m2"].as_f64().unwrap()
                - 12. * scale * scale * 2f64.to_radians().cos())
            .abs()
                < 0.001
        );
        assert!(
            (props["_zgis_length_m"].as_f64().unwrap()
                - 12. * scale * (1. + 2f64.to_radians().cos()))
            .abs()
                < 0.001
        );
    }
    #[test]
    fn simplify_metric_limits_and_geometry_validity() {
        let line = json!({"type":"Feature","geometry":{"type":"LineString","coordinates":[[0,0],[0.001,0.000001],[0.002,0]]},"properties":{"keep":1}});
        let result = analyze(
            "simplify",
            &json!({"toleranceMeters":10}),
            &[line.clone()],
            None,
        )
        .unwrap();
        assert_eq!(
            result["features"][0]["geometry"]["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(result["features"][0]["properties"]["keep"], 1);
        for args in [
            json!({}),
            json!({"toleranceMeters":0}),
            json!({"toleranceMeters":100001}),
            json!({"toleranceMeters":"10"}),
        ] {
            assert!(analyze("simplify", &args, &[line.clone()], None).is_err());
        }
        assert!(analyze(
            "simplify",
            &json!({"toleranceMeters":10}),
            &[point(0., 0.)],
            None
        )
        .is_err());
        assert!(analyze(
            "simplify",
            &json!({"toleranceMeters":10}),
            &[square(0., 80., 0.1)],
            None
        )
        .is_err());
        assert!(analyze(
            "geometry_attributes",
            &json!({}),
            &[square(0., 80., 0.1)],
            None
        )
        .is_err());
        assert!(analyze(
            "geometry_attributes",
            &json!({}),
            &[square(0., 0., 6.)],
            None
        )
        .is_err());
        // Independent ring simplification can move a hole outside the simplified shell.
        use geo::MapCoords;
        let hole = decode(&[hole_polygon()], false)
            .unwrap()
            .remove(0)
            .map_coords(|c| geo::Coord {
                x: c.x * 0.001,
                y: c.y * 0.001,
            });
        let error = analyze(
            "simplify",
            &json!({"toleranceMeters":350}),
            &[feature(&hole, json!({}))],
            None,
        )
        .unwrap_err();
        assert!(error.contains("简化结果未通过校验") && error.contains("降低容差"));
    }
    #[test]
    fn generated_outputs_and_merged_ids_are_bounded() {
        let mut a = point(0., 0.);
        a["id"] = json!("shared");
        let result = analyze("merge", &json!({}), &[a.clone()], Some(&[a.clone()])).unwrap();
        assert_eq!(result["features"].as_array().unwrap().len(), 2);
        assert!(result["features"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| f.get("id").is_none()));
        assert!(analyze(
            "merge",
            &json!({}),
            &vec![a.clone(); 6000],
            Some(&vec![a.clone(); 5000])
        )
        .unwrap_err()
        .contains("10000"));
        let mut large = a.clone();
        large["geometry"] = json!({"type":"MultiPoint","coordinates":vec![json!([0,0]);10001]});
        for name in ["multipart_to_singleparts", "extract_vertices"] {
            assert!(analyze(name, &json!({}), &[large.clone()], None)
                .unwrap_err()
                .contains("10000"));
        }
        let mut z = a;
        z["geometry"]["coordinates"] = json!([0, 0, 5, 1]);
        for name in [
            "centroid",
            "geometry_attributes",
            "extract_vertices",
            "convex_hull",
        ] {
            assert!(analyze(name, &json!({}), &[z.clone()], None)
                .unwrap_err()
                .contains("M/ZM"));
        }
    }
    #[test]
    fn rejects_unclosed_and_short_rings_before_conversion() {
        for coordinates in [
            json!([[[0, 0], [1, 0], [1, 1], [0, 1]]]),
            json!([[[0, 0], [1, 0], [0, 0]]]),
        ] {
            for (kind, coordinates) in [
                ("Polygon", coordinates.clone()),
                ("MultiPolygon", json!([coordinates])),
            ] {
                let source = json!({"type":"Feature","geometry":{"type":kind,"coordinates":coordinates},"properties":{}});
                assert!(analyze("layer_summary", &json!({}), &[source.clone()], None).is_err());
                let report = analyze("topology_check", &json!({}), &[source], None).unwrap();
                assert_eq!(report["issues"][0]["kind"], "invalid_geometry");
            }
        }
    }
    #[test]
    fn identity_preserved_and_modified_bbox_removed() {
        let mut source = point(0.5, 0.5);
        source["id"] = json!("original-id");
        source["bbox"] = json!([0.5, 0.5, 0.5, 0.5]);
        for name in ["spatial_join", "nearest"] {
            let result = analyze(
                name,
                &json!({}),
                &[source.clone()],
                Some(&[square(0., 0., 1.)]),
            )
            .unwrap();
            assert_eq!(result["features"][0]["id"], "original-id");
            assert_eq!(result["features"][0]["geometry"], source["geometry"]);
            assert_eq!(result["features"][0]["bbox"], source["bbox"]);
        }
        let result = analyze("buffer", &json!({"distanceMeters":10}), &[source], None).unwrap();
        assert_eq!(result["features"][0]["id"], "original-id");
        assert!(result["features"][0].get("bbox").is_none());
        let mut source = square(0., 0., 2.);
        source["id"] = json!(42);
        source["bbox"] = json!([0, 0, 2, 2]);
        let result = analyze("clip", &json!({}), &[source], Some(&[square(1., 1., 2.)])).unwrap();
        assert_eq!(result["features"][0]["id"], 42);
        assert!(result["features"][0].get("bbox").is_none());
    }
    #[test]
    fn disjoint_query_requires_disjoint_from_all_targets() {
        let source = vec![point(0.5, 0.5), point(3., 3.)];
        let target = vec![square(0., 0., 1.), square(5., 5., 1.)];
        let result = analyze(
            "spatial_query",
            &json!({"predicate":"disjoint"}),
            &source,
            Some(&target),
        )
        .unwrap();
        assert_eq!(result["features"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["features"][0]["geometry"]["coordinates"],
            json!([3., 3.])
        );
        let join = analyze(
            "spatial_join",
            &json!({"predicate":"disjoint"}),
            &source,
            Some(&target),
        )
        .unwrap();
        assert_eq!(join["features"][0]["properties"]["_zgis_join_"]["count"], 1);
    }
    #[test]
    fn envelope_prefilter_matches_exact_predicates_including_boundary() {
        let sources = decode(
            &[
                point(0., 0.),
                point(1., 0.5),
                point(3., 3.),
                square(0., 0., 1.),
            ],
            false,
        )
        .unwrap();
        let targets = decode(
            &[
                point(0., 0.),
                square(0., 0., 1.),
                square(1., 0., 1.),
                square(10., 10., 1.),
            ],
            false,
        )
        .unwrap();
        for a in &sources {
            for b in &targets {
                for predicate in ["intersects", "within", "contains", "touches", "disjoint"] {
                    assert_eq!(
                        bounded_relation(a, b, predicate, a.bounding_rect(), b.bounding_rect()),
                        relation(a, b, predicate)
                    );
                }
            }
        }
        let distant = analyze(
            "intersection",
            &json!({}),
            &[square(0., 0., 1.)],
            Some(&[square(10., 10., 1.)]),
        )
        .unwrap();
        assert!(distant["features"].as_array().unwrap().is_empty());
        let report = analyze(
            "topology_check",
            &json!({}),
            &[square(0., 0., 1.), square(10., 10., 1.)],
            None,
        )
        .unwrap();
        assert_eq!(report["valid"], true);
    }
    #[test]
    fn sparse_polygon_prefilter_keeps_results_and_reports_candidate_reduction() {
        let source: Vec<_> = (0..50)
            .map(|i| square(i as f64 * 0.02, 0., 0.001))
            .collect();
        let mut target: Vec<_> = (0..50)
            .map(|i| square(i as f64 * 0.02, 1., 0.001))
            .collect();
        target[0] = square(0.001, 0., 0.001); // 一个恰好接触边界的候选。
        let source = decode(&source, false).unwrap();
        let target = decode(&target, false).unwrap();
        let start = std::time::Instant::now();
        let mut exact = Vec::new();
        for (i, a) in source.iter().enumerate() {
            for (j, b) in target.iter().enumerate() {
                if relation(a, b, "intersects") {
                    exact.push((i, j));
                }
            }
        }
        let baseline = start.elapsed();
        let start = std::time::Instant::now();
        let sb: Vec<_> = source.iter().map(BoundingRect::bounding_rect).collect();
        let tb: Vec<_> = target.iter().map(BoundingRect::bounding_rect).collect();
        let mut candidates = 0;
        let mut filtered = Vec::new();
        for (i, a) in source.iter().enumerate() {
            for (j, b) in target.iter().enumerate() {
                if bounds_overlap(sb[i], tb[j]) {
                    candidates += 1;
                }
                if bounded_relation(a, b, "intersects", sb[i], tb[j]) {
                    filtered.push((i, j));
                }
            }
        }
        let optimized = start.elapsed();
        assert_eq!(filtered, exact);
        assert_eq!(filtered, vec![(0, 0)]);
        assert_eq!(candidates, 1);
        eprintln!("稀疏面 fixture: 2500 对，完整关系计算候选 {candidates}；baseline={baseline:?}, prefiltered={optimized:?}");
    }
    fn point(x: f64, y: f64) -> Value {
        json!({"type":"Feature","geometry":{"type":"Point","coordinates":[x,y]},"properties":{"name":"keep","_zgis_join":"original"}})
    }
    fn square(x: f64, y: f64, size: f64) -> Value {
        json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]]]},"properties":{}})
    }
    #[test]
    fn predicates_holes_and_boundary() {
        let polygon = json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,3],[3,3],[3,1],[1,1]]]},"properties":{}});
        let source = vec![point(0.5, 0.5), point(2., 2.), point(0., 2.)];
        let out = analyze(
            "spatial_query",
            &json!({"predicate":"within"}),
            &source,
            Some(&[polygon.clone()]),
        )
        .unwrap();
        assert_eq!(out["features"].as_array().unwrap().len(), 1);
        let out = analyze(
            "spatial_query",
            &json!({"predicate":"touches"}),
            &source,
            Some(&[polygon]),
        )
        .unwrap();
        assert_eq!(
            out["features"][0]["geometry"]["coordinates"],
            json!([0., 2.])
        );
    }
    #[test]
    fn join_preserves_existing_properties() {
        let out = analyze(
            "spatial_join",
            &json!({}),
            &[point(0.5, 0.5)],
            Some(&[square(0., 0., 1.)]),
        )
        .unwrap();
        assert_eq!(out["features"][0]["properties"]["_zgis_join"], "original");
        assert_eq!(out["features"][0]["properties"]["_zgis_join_"]["count"], 1);
    }
    #[test]
    fn nearest_latitude_and_meters() {
        let out = analyze(
            "nearest",
            &json!({}),
            &[point(0., 60.)],
            Some(&[point(0.01, 60.), point(0., 60.01)]),
        )
        .unwrap();
        let info = &out["features"][0]["properties"]["_zgis_nearest"];
        assert_eq!(info["targetIndex"], 0);
        let distance = info["distanceMeters"].as_f64().unwrap();
        assert!((distance - 556.).abs() < 2.);
        assert_eq!(out["analysis"]["geodesic"], false);
        assert!(analyze(
            "nearest",
            &json!({}),
            &[point(0., 80.)],
            Some(&[point(0.01, 80.)])
        )
        .is_err());
    }
    #[test]
    fn topology_reports_bowtie_without_running_overlay() {
        let bad = json!({"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,1],[0,1],[1,0],[0,0]]]},"properties":{}});
        let out = analyze("topology_check", &json!({}), &[bad.clone()], None).unwrap();
        assert_eq!(out["issues"][0]["kind"], "invalid_geometry");
        assert!(analyze("buffer", &json!({"distanceMeters":10}), &[bad], None).is_err());
    }
    #[test]
    fn buffer_has_expected_extent() {
        let out = analyze(
            "buffer",
            &json!({"distanceMeters":1000}),
            &[point(0., 0.)],
            None,
        )
        .unwrap();
        let geometries = decode(out["features"].as_array().unwrap(), false).unwrap();
        let rect = geometries[0].bounding_rect().unwrap();
        assert!((rect.max().x - 0.008993).abs() < 0.00002);
    }
    #[test]
    fn overlay_clip_and_dissolve_area() {
        use geo::Area;
        let source = vec![square(0., 0., 2.), square(1., 0., 2.)];
        let out = analyze("dissolve", &json!({}), &source, None).unwrap();
        let g = decode(out["features"].as_array().unwrap(), false).unwrap();
        assert!((polygon(&g[0]).unwrap().unsigned_area() - 6.).abs() < 1e-9);
        let out = analyze(
            "clip",
            &json!({}),
            &source[..1],
            Some(&[square(1., 1., 2.)]),
        )
        .unwrap();
        let g = decode(out["features"].as_array().unwrap(), false).unwrap();
        assert!((polygon(&g[0]).unwrap().unsigned_area() - 1.).abs() < 1e-9);
    }
    #[test]
    fn rejects_unsafe_dimension_and_parameters() {
        let mut p = point(0., 0.);
        p["geometry"]["coordinates"] = json!([0, 0, 1, 2]);
        assert!(analyze("layer_summary", &json!({}), &[p], None).is_err());
        assert!(analyze("layer_summary", &json!({"unknown":true}), &[], None).is_err());
        assert!(analyze(
            "spatial_query",
            &json!({"bbox":[170,-5,-170,5]}),
            &[point(0., 0.)],
            None
        )
        .is_err());
    }
}
