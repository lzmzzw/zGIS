use serde_json::Value;
use shapefile::{dbase, Multipoint, Point, Polygon, PolygonRing, Polyline, ShapeWriter, Writer};
use std::{
    collections::BTreeSet,
    io::{Cursor, Write},
};

const PRJ: &str = "GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]]";
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn array(v: &Value) -> Result<&Vec<Value>, String> {
    v.as_array().ok_or_else(|| "无效坐标数组".into())
}
fn point(v: &Value, crs: &str) -> Result<Point, String> {
    let p = array(v)?;
    if p.len() != 2 {
        return Err("仅支持二维坐标，不允许静默丢弃 Z/M".into());
    }
    let x = p[0].as_f64().ok_or("无效经度")?;
    let y = p[1].as_f64().ok_or("无效纬度")?;
    if !x.is_finite()
        || !y.is_finite()
        || !(-180.0..=180.0).contains(&x)
        || !(-90.0..=90.0).contains(&y)
    {
        return Err("坐标必须为有效 WGS84 经纬度".into());
    }
    if crs == "EPSG:3857" {
        if y.abs() > 85.0511287798066 { return Err("EPSG:3857 不支持超出 ±85.05112878° 的纬度".into()); }
        return Ok(Point::new(6378137.0 * x.to_radians(), 6378137.0 * (std::f64::consts::FRAC_PI_4 + y.to_radians() / 2.0).tan().ln()));
    }
    Ok(Point::new(x, y))
}
fn points(v: &Value, ring: bool, crs: &str) -> Result<Vec<Point>, String> {
    let p = array(v)?.iter().map(|v| point(v, crs)).collect::<Result<Vec<_>, _>>()?;
    if p.len() < if ring { 4 } else { 2 } {
        return Err("线至少两点，面环至少四点".into());
    }
    if ring && p.first() != p.last() {
        return Err("面环必须闭合".into());
    }
    if ring {
        let area: f64 = p
            .windows(2)
            .map(|w| w[0].x * w[1].y - w[1].x * w[0].y)
            .sum();
        if area == 0.0 {
            return Err("面环面积不能为零".into());
        }
    }
    Ok(p)
}
enum Geometry {
    Single(Point),
    Points(Multipoint),
    Lines(Polyline),
    Areas(Polygon),
}
fn geometry(v: &Value, crs: &str) -> Result<Geometry, String> {
    let c = &v["coordinates"];
    Ok(match v["type"].as_str().ok_or("缺少几何类型")? {
        "Point" => Geometry::Single(point(c, crs)?),
        "MultiPoint" => {
            let p = array(c)?.iter().map(|v| point(v, crs)).collect::<Result<Vec<_>, _>>()?;
            if p.is_empty() {
                return Err("不支持空几何".into());
            }
            Geometry::Points(Multipoint::new(p))
        }
        "LineString" => Geometry::Lines(Polyline::new(points(c, false, crs)?)),
        "MultiLineString" => {
            let p = array(c)?
                .iter()
                .map(|v| points(v, false, crs))
                .collect::<Result<Vec<_>, _>>()?;
            if p.is_empty() {
                return Err("不支持空几何".into());
            }
            Geometry::Lines(Polyline::with_parts(p))
        }
        kind @ ("Polygon" | "MultiPolygon") => {
            let polygons: Vec<&Value> = if kind == "Polygon" {
                vec![c]
            } else {
                array(c)?.iter().collect()
            };
            let mut rings = Vec::new();
            for p in polygons {
                let r = array(p)?;
                if r.is_empty() {
                    return Err("不支持空面".into());
                }
                for (i, v) in r.iter().enumerate() {
                    let pts = points(v, true, crs)?;
                    rings.push(if i == 0 {
                        PolygonRing::Outer(pts)
                    } else {
                        PolygonRing::Inner(pts)
                    });
                }
            }
            if rings.is_empty() {
                return Err("不支持空几何".into());
            }
            Geometry::Areas(Polygon::with_rings(rings))
        }
        _ => {
            return Err(
                "仅支持 Point、MultiPoint、LineString、MultiLineString、Polygon、MultiPolygon"
                    .into(),
            )
        }
    })
}
#[derive(Clone)]
enum Field {
    Text(u8),
    Number(u8),
    Bool,
}
fn decimal(n: f64) -> Result<u8, String> {
    if !n.is_finite() || n.abs() >= 1e15 {
        return Err("数值超出 DBF 安全精度范围（绝对值必须小于 10^15）".into());
    }
    for d in 0..=8 {
        let text = format!("{:.*}", d, n);
        if text.parse::<f64>().ok() == Some(n) {
            if text
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .trim_start_matches('0')
                .len()
                > 15
            {
                return Err("数值不能超过 15 位有效数字".into());
            }
            return Ok(d as u8);
        }
    }
    Err("数值需要超过 8 位小数，不能无损导出 DBF".into())
}
/// Validate before opening the save dialog; never truncate or coerce attribute data.
#[cfg(test)]
pub fn build_zip(features: &[Value], stem: &str) -> Result<Vec<u8>, String> {
    build_zip_crs(features, stem, "EPSG:4326")
}
pub fn build_components_crs(features: &[Value], crs: &str) -> Result<Vec<(&'static str, Vec<u8>)>, String> {
    let prj = match crs {
        "EPSG:4326" => PRJ,
        "EPSG:4490" => r#"GEOGCS["China Geodetic Coordinate System 2000",DATUM["China_2000",SPHEROID["CGCS2000",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4490"]]"#,
        "EPSG:3857" => r#"PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],EXTENSION["PROJ4","+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs"],AUTHORITY["EPSG","3857"]]"#,
        _ => return Err("仅支持 EPSG:4326/4490/3857".into()),
    };
    if features.is_empty() {
        return Err("没有可导出的要素".into());
    }
    let mut names = BTreeSet::new();
    for f in features {
        if f["type"] != "Feature" {
            return Err("输入必须是 GeoJSON Feature".into());
        }
        let p = f["properties"].as_object().ok_or("要素属性必须为对象")?;
        names.extend(p.keys().cloned());
    }
    let mut folded = BTreeSet::new();
    let mut fields = Vec::new();
    let mut builder = dbase::TableWriterBuilder::new();
    for name in names {
        if name.is_empty()
            || name.len() > 10
            || !name
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
            || !folded.insert(name.to_ascii_uppercase())
        {
            return Err(format!(
                "字段 {name}：名称必须为 1–10 位 ASCII 字母/数字/下划线，不能数字开头或大小写重名"
            ));
        }
        let mut kind: Option<Field> = None;
        for f in features {
            let v = &f["properties"][&name];
            let next = match v {
                Value::String(s) if !s.is_empty() && !s.starts_with(' ') && !s.ends_with(' ') && !s.contains('\0') && s.len() <= 254 => {
                    Field::Text(s.len().max(1) as u8)
                }
                Value::Number(n) => Field::Number(decimal(n.as_f64().ok_or("无效数值")?)?),
                Value::Bool(_) => Field::Bool,
                _ => return Err(format!(
                    "字段 {name}：不支持 null、缺失值、对象/数组、空文本、首尾空格、NUL 或超过 254 UTF-8 字节的文本"
                )),
            };
            kind = Some(match (kind, next) {
                (None, k) => k,
                (Some(Field::Text(a)), Field::Text(b)) => Field::Text(a.max(b)),
                (Some(Field::Number(a)), Field::Number(b)) => Field::Number(a.max(b)),
                (Some(Field::Bool), Field::Bool) => Field::Bool,
                _ => return Err(format!("字段 {name}：属性类型不一致")),
            });
        }
        let kind = kind.unwrap();
        let key = name.as_str().try_into().map_err(error)?;
        builder = match kind {
            Field::Text(n) => builder.add_character_field(key, n),
            Field::Number(d) => builder.add_numeric_field(key, 25, d),
            Field::Bool => builder.add_logical_field(key),
        };
        fields.push((name, kind));
    }
    if fields.len() > 255 {
        return Err("DBF 字段不能超过 255 个".into());
    }
    let row_size: usize = 1 + fields
        .iter()
        .map(|(_, f)| match f {
            Field::Text(n) => *n as usize,
            Field::Number(_) => 25,
            Field::Bool => 1,
        })
        .sum::<usize>();
    if row_size > 4000 {
        return Err("DBF 单条属性记录不能超过 4000 字节，请减少字段或文本长度".into());
    }
    // Empty property tables get a documented row number, since interoperable DBF requires a field.
    if fields.is_empty() {
        builder = builder.add_numeric_field("ZG_ROW".try_into().map_err(error)?, 12, 0);
    }
    let shapes = features
        .iter()
        .map(|f| geometry(&f["geometry"], crs))
        .collect::<Result<Vec<_>, _>>()?;
    let family = |g: &Geometry| match g {
        Geometry::Single(_) => 0,
        Geometry::Points(_) => 3,
        Geometry::Lines(_) => 1,
        Geometry::Areas(_) => 2,
    };
    if shapes.iter().any(|g| family(g) != family(&shapes[0])) {
        return Err("SHP 不支持混合 Point/MultiPoint/线/面，请分图层导出".into());
    }
    let (mut shp, mut shx, mut dbf) = (Vec::new(), Vec::new(), Vec::new());
    {
        let sw = ShapeWriter::with_shx(Cursor::new(&mut shp), Cursor::new(&mut shx));
        let mut writer = Writer::new(sw, builder.build_with_dest(Cursor::new(&mut dbf)));
        for (i, (f, g)) in features.iter().zip(shapes.iter()).enumerate() {
            let mut r = dbase::Record::default();
            if fields.is_empty() {
                r.insert(
                    "ZG_ROW".into(),
                    dbase::FieldValue::Numeric(Some((i + 1) as f64)),
                );
            }
            for (name, kind) in &fields {
                let v = &f["properties"][name];
                r.insert(
                    name.clone(),
                    match kind {
                        Field::Text(_) => {
                            dbase::FieldValue::Character(Some(v.as_str().unwrap().into()))
                        }
                        Field::Number(_) => dbase::FieldValue::Numeric(v.as_f64()),
                        Field::Bool => dbase::FieldValue::Logical(v.as_bool()),
                    },
                );
            }
            match g {
                Geometry::Single(s) => writer.write_shape_and_record(s, &r),
                Geometry::Points(s) => writer.write_shape_and_record(s, &r),
                Geometry::Lines(s) => writer.write_shape_and_record(s, &r),
                Geometry::Areas(s) => writer.write_shape_and_record(s, &r),
            }
            .map_err(error)?;
        }
    }
    let components = vec![
        ("shp", shp), ("shx", shx), ("dbf", dbf),
        ("prj", prj.as_bytes().to_vec()), ("cpg", b"UTF-8".to_vec()),
    ];
    if components.iter().map(|(_, bytes)| bytes.len() as u64).sum::<u64>() > super::MAX_FILE {
        return Err("输出超过 100 MB".into());
    }
    Ok(components)
}

pub fn build_zip_crs(features: &[Value], stem: &str, crs: &str) -> Result<Vec<u8>, String> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (ext, data) in build_components_crs(features, crs)? {
        zip.start_file(format!("{stem}.{ext}"), opts).map_err(error)?;
        zip.write_all(&data).map_err(error)?;
    }
    let bytes = zip.finish().map_err(error)?.into_inner();
    if bytes.len() as u64 > super::MAX_FILE { return Err("输出超过 100 MB".into()); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn feature(g: Value, p: Value) -> Value {
        json!({"type":"Feature","geometry":g,"properties":p})
    }
    #[test]
    fn chinese_point_roundtrip() {
        let f = feature(
            json!({"type":"Point","coordinates":[116.4,39.9]}),
            json!({"name":"北京","value":12.125,"flag":true}),
        );
        let b = build_zip(&[f], "layer").unwrap();
        let mut z = zip::ZipArchive::new(Cursor::new(b)).unwrap();
        assert_eq!(z.len(), 5);
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut z.by_name("layer.dbf").unwrap(), &mut data).unwrap();
        let records = dbase::Reader::new(Cursor::new(data))
            .unwrap()
            .read()
            .unwrap();
        assert_eq!(
            records[0].get("name"),
            Some(&dbase::FieldValue::Character(Some("北京".into())))
        );
        assert_eq!(
            records[0].get("value"),
            Some(&dbase::FieldValue::Numeric(Some(12.125)))
        );
        let mut shp = Vec::new();
        std::io::Read::read_to_end(&mut z.by_name("layer.shp").unwrap(), &mut shp).unwrap();
        let shapes = shapefile::ShapeReader::new(Cursor::new(shp))
            .unwrap()
            .read()
            .unwrap();
        assert!(matches!(&shapes[0], shapefile::Shape::Point(p) if p.x == 116.4 && p.y == 39.9));
    }
    #[test]
    fn polygon_holes_and_multi() {
        let f = feature(
            json!({"type":"MultiPolygon","coordinates":[[[[0,0],[0,5],[5,5],[5,0],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]]],[[[10,10],[10,11],[11,11],[11,10],[10,10]]]]}),
            json!({}),
        );
        let b = build_zip(&[f], "a").unwrap();
        let mut z = zip::ZipArchive::new(Cursor::new(b)).unwrap();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut z.by_name("a.shp").unwrap(), &mut data).unwrap();
        let shapes = shapefile::ShapeReader::new(Cursor::new(data))
            .unwrap()
            .read()
            .unwrap();
        if let shapefile::Shape::Polygon(p) = &shapes[0] {
            assert_eq!(p.rings().len(), 3);
            assert!(matches!(p.rings()[1], PolygonRing::Inner(_)));
        } else {
            panic!("wrong shape")
        }
    }
    #[test]
    fn rejects_loss() {
        for p in [
            json!({"long_field_name":1}),
            json!({"x":null}),
            json!({"x":[1]}),
            json!({"x":0.123456789}),
            json!({"x":"a".repeat(255)}),
            json!({"x":1,"X":2}),
            json!({"x":""}),
            json!({"x":"abc "}),
            json!({"x":12345678901234.12}),
        ] {
            assert!(build_zip(
                &[feature(json!({"type":"Point","coordinates":[0,0]}), p)],
                "x"
            )
            .is_err());
        }
        assert!(build_zip(
            &[feature(
                json!({"type":"Point","coordinates":[0,0,1]}),
                json!({})
            )],
            "x"
        )
        .is_err());
    }
    #[test]
    fn lines_and_mixed() {
        let l = feature(
            json!({"type":"MultiLineString","coordinates":[[[0,0],[1,1]],[[2,2],[3,3]]]}),
            json!({}),
        );
        assert!(build_zip(&[l.clone()], "x").is_ok());
        assert!(build_zip(
            &[
                l,
                feature(json!({"type":"Point","coordinates":[0,0]}), json!({}))
            ],
            "x"
        )
        .is_err());
    }
}
