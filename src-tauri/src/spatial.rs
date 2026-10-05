//! Bounded, two-dimensional spatial operations. Relations use longitude/latitude
//! coordinates; metric operations use a local equirectangular approximation.
use geo::{
    BooleanOps, BoundingRect, Buffer, CoordsIter, Geometry, MultiPolygon, Relate, Validation,
};
use serde_json::{json, Value};

const MAX_FEATURES: usize = 10_000;
const MAX_VERTICES: usize = 1_000_000;
const MAX_PAIRS: usize = 1_000_000;

pub fn tool_definitions() -> Vec<Value> {
    let reference = json!({"oneOf":[{"type":"object","properties":{"layerId":{"type":"string","minLength":1}},"required":["layerId"],"additionalProperties":false},{"type":"object","properties":{"path":{"type":"string","minLength":1},"crs":{"type":"string","enum":["EPSG:4326","EPSG:4490","EPSG:3857"]},"wktField":{"type":"string","minLength":1},"xField":{"type":"string","minLength":1},"yField":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}]});
    [("spatial_query","空间谓词查询；经纬度平面关系，禁止跨日期变更线"),("spatial_join","空间关联，保留源属性并附加匹配目标"),("nearest","按局部等距圆柱近似距离查找最近目标；非测地距离"),("topology_check","检查无效几何、重复几何及面重叠，返回有界报告"),("buffer","局部等距圆柱近似米制缓冲，限局部低中纬度数据"),("clip","面与面裁剪"),("dissolve","合并面几何"),("layer_summary","图层几何、属性、范围摘要")].into_iter().map(|(name,description)| {
        let mut properties = json!({"source":reference.clone()});
        let mut required=vec!["source"];
        if matches!(name,"spatial_query"|"spatial_join"|"nearest"|"clip") { properties["target"]=reference.clone(); if name!="spatial_query" {required.push("target");} }
        if matches!(name,"spatial_query"|"spatial_join") {properties["predicate"]=json!({"type":"string","enum":["intersects","within","contains","touches","disjoint"],"default":"intersects"});}
        if name=="spatial_query" {properties["bbox"]=json!({"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4});}
        if name=="buffer" {properties["distanceMeters"]=json!({"type":"number","exclusiveMinimum":0,"maximum":100000});required.push("distanceMeters");}
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
            let parsed: geojson::Geometry =
                serde_json::from_value(value.clone()).map_err(|e| format!("要素 {i}: {e}"))?;
            let geometry: Geometry<f64> =
                parsed.try_into().map_err(|e| format!("要素 {i}: {e}"))?;
            if matches!(geometry, Geometry::GeometryCollection(_)) {
                return Err("不支持 GeometryCollection".into());
            }
            let coords: Vec<_> = geometry.coords_iter().collect();
            vertices += coords.len();
            if vertices > MAX_VERTICES {
                return Err("顶点总数超过 1000000".into());
            }
            if coords.is_empty() {
                return Err(format!("要素 {i} 为空几何"));
            }
            let min = coords.iter().map(|c| c.x).fold(f64::INFINITY, f64::min);
            let max = coords.iter().map(|c| c.x).fold(f64::NEG_INFINITY, f64::max);
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
    let a = v.as_array().ok_or("坐标必须为二维数组")?;
    if a.first().is_some_and(Value::is_number) {
        if a.len() != 2 {
            return Err("仅支持二维坐标，不支持 Z/M".into());
        }
        let x = a[0].as_f64().ok_or("非法坐标")?;
        let y = a[1].as_f64().ok_or("非法坐标")?;
        if !x.is_finite() || !y.is_finite() || x.abs() > 180.0 || y.abs() > 90.0 {
            return Err("坐标必须是有效 WGS84 经纬度".into());
        }
    } else {
        for item in a {
            validate_coordinates(item)?;
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
                || (0..2).any(|axis| {
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
    let mut result = source.clone();
    result["type"] = json!("Feature");
    result["properties"] = properties;
    if let Some(geometry) = geometry {
        result["geometry"] = json!(geojson::Geometry::new(geojson::Value::from(geometry)));
        // An old feature bbox no longer describes the transformed geometry.
        if let Some(object) = result.as_object_mut() {
            object.remove("bbox");
        }
    }
    result
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

pub fn analyze(
    name: &str,
    args: &Value,
    source: &[Value],
    target: Option<&[Value]>,
) -> Result<Value, String> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        analyze_inner(name, args, source, target)
    }))
    .map_err(|_| "几何引擎拒绝此数据，分析未完成；请先检查几何有效性".to_string())??;
    if let Some(features) = result.get("features").and_then(Value::as_array) {
        // Reject oversized generated geometry instead of returning a partial collection.
        decode(features, false)?;
    }
    Ok(result)
}

fn analyze_inner(
    name: &str,
    args: &Value,
    source: &[Value],
    target: Option<&[Value]>,
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
        for (i, g) in s.iter().enumerate() {
            let projected = projection.map(g, false);
            let result = Geometry::MultiPolygon(projected.buffer(distance));
            out.push(derived_feature(
                &source[i],
                Some(&projection.map(&result, true)),
                source[i]["properties"].clone(),
            ));
        }
        return Ok(collection(out, true));
    }
    if name == "dissolve" {
        let mut union = MultiPolygon(vec![]);
        for g in &s {
            union = union.union(&polygon(g)?);
        }
        return Ok(collection(
            if union.0.is_empty() {
                vec![]
            } else {
                vec![feature(
                    &Geometry::MultiPolygon(union),
                    json!({"sourceCount":s.len()}),
                )]
            },
            false,
        ));
    }
    let mut t = decode(target.unwrap_or(&[]), false)?;
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
    let mut out = Vec::new();
    if name == "nearest" {
        let all: Vec<_> = s.iter().chain(t.iter()).cloned().collect();
        let projection = Projection::new(&all)?;
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
            out.push(derived_feature(
                &source[i],
                None,
                properties(
                    &source[i],
                    "_zgis_nearest",
                    json!({"targetIndex":index,"distanceMeters":distance}),
                ),
            ));
        }
        return Ok(collection(out, true));
    }
    if name == "clip" {
        let mut mask = MultiPolygon(vec![]);
        for g in &t {
            mask = mask.union(&polygon(g)?);
        }
        for (i, g) in s.iter().enumerate() {
            let clipped = polygon(g)?.intersection(&mask);
            if !clipped.0.is_empty() {
                out.push(derived_feature(
                    &source[i],
                    Some(&Geometry::MultiPolygon(clipped)),
                    source[i]["properties"].clone(),
                ));
            }
        }
        return Ok(collection(out, false));
    }
    for (i, g) in s.iter().enumerate() {
        let matches: Vec<_> = t
            .iter()
            .enumerate()
            .filter(|(_, b)| relation(g, b, predicate))
            .map(|(j, _)| j)
            .collect();
        if name == "spatial_query" {
            if if predicate == "disjoint" {
                matches.len() == t.len()
            } else {
                !matches.is_empty()
            } {
                out.push(source[i].clone());
            }
        } else {
            out.push(derived_feature(
                &source[i],
                None,
                properties(
                    &source[i],
                    "_zgis_join",
                    json!({"count":matches.len(),"targetIndices":matches}),
                ),
            ));
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
        let coords: Vec<_> = gs.iter().flat_map(CoordsIter::coords_iter).collect();
        if coords.is_empty() {
            return Err("没有可计算坐标".into());
        }
        let xmin = coords.iter().map(|c| c.x).fold(f64::INFINITY, f64::min);
        let xmax = coords.iter().map(|c| c.x).fold(f64::NEG_INFINITY, f64::max);
        let ymin = coords.iter().map(|c| c.y).fold(f64::INFINITY, f64::min);
        let ymax = coords.iter().map(|c| c.y).fold(f64::NEG_INFINITY, f64::max);
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
    let mut issues = Vec::new();
    let mut geometries = Vec::new();
    let mut vertices = 0;
    for (i, f) in source.iter().enumerate() {
        match decode(std::slice::from_ref(f), true) {
            Ok(mut gs) => {
                let g = gs.remove(0);
                vertices += g.coords_count();
                if vertices > MAX_VERTICES {
                    return Err("顶点总数超过上限".into());
                }
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
    for i in 0..source.len() {
        for j in i + 1..source.len() {
            if source[i]["geometry"] == source[j]["geometry"] {
                issues.push(json!({"kind":"duplicate_geometry","featureIndices":[i,j]}));
            } else if let (Some(a), Some(b)) = (&geometries[i], &geometries[j]) {
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

#[cfg(test)]
mod tests {
    use super::*;
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
        p["geometry"]["coordinates"] = json!([0, 0, 1]);
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
