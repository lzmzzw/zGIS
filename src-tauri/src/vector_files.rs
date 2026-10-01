//! 会话授权范围内的只读矢量加载；所有输出统一为二维 WGS84 GeoJSON。
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 100 * 1024 * 1024;
fn preserve_property_numbers(v: &mut Value) {
    fn walk(v: &mut Value) {
        match v {
            Value::Number(n) => {
                let text = n.to_string();
                let digits = text
                    .split(['e', 'E'])
                    .next()
                    .unwrap_or("")
                    .chars()
                    .filter(|c| c.is_ascii_digit())
                    .collect::<String>();
                let unsafe_integer = n
                    .as_i64()
                    .is_some_and(|i| i.unsigned_abs() > 9_007_199_254_740_991)
                    || n.as_u64().is_some_and(|i| i > 9_007_199_254_740_991);
                let scientific_large = n
                    .as_f64()
                    .is_some_and(|x| x.fract() == 0.0 && x.abs() > 9_007_199_254_740_991.0);
                if unsafe_integer || scientific_large || digits.trim_start_matches('0').len() > 15 {
                    *v = Value::String(text);
                }
            }
            Value::Array(a) => {
                for v in a {
                    walk(v)
                }
            }
            Value::Object(o) => {
                for v in o.values_mut() {
                    walk(v)
                }
            }
            _ => {}
        }
    }
    if v["type"] == "FeatureCollection" {
        if let Some(a) = v["features"].as_array_mut() {
            for f in a {
                walk(&mut f["properties"]);
                if f.get("id").is_some() {
                    walk(&mut f["id"]);
                }
            }
        }
    } else if v["type"] == "Feature" {
        walk(&mut v["properties"]);
        if v.get("id").is_some() {
            walk(&mut v["id"]);
        }
    }
}
fn identify_prj(prj: &str) -> Result<&'static str, String> {
    let p = prj
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    let known="GEOGCS[\"WGS84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS84\",6378137,298.257223563]],PRIMEM[\"GREENWICH\",0],UNIT[\"DEGREE\",0.0174532925199433]]";
    if p == known {
        return Ok("EPSG:4326");
    }
    // 只接受顶层 authority；内嵌地理坐标系的4326不能代表投影坐标系。
    let authority = if p.ends_with("AUTHORITY[\"EPSG\",\"4326\"]]") {
        Some("EPSG:4326")
    } else if p.ends_with("AUTHORITY[\"EPSG\",\"3857\"]]") {
        Some("EPSG:3857")
    } else {
        None
    };
    let wgs = p.contains("DATUM[\"WGS_1984\",")
        || p.contains("DATUM[\"WGS84\",")
        || p.contains("DATUM[\"WORLDGEODETICSYSTEM1984\",");
    if wgs {
        if let Some(code) = authority {
            if (code == "EPSG:4326" && p.starts_with("GEOGCS["))
                || (code == "EPSG:3857" && p.starts_with("PROJCS["))
            {
                return Ok(code);
            }
        }
    }
    Err("PRJ无法严格识别为EPSG:4326/3857，请明确指定已核实的crs或预先转换".into())
}
pub fn authorized(path: &Path, grants: &[PathBuf]) -> Result<PathBuf, String> {
    if path.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("_credentials")
    }) {
        return Err("凭据目录不可读取".into());
    }
    let p = path.canonicalize().map_err(|_| "文件不存在或不可访问")?;
    if p.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("_credentials")
    }) {
        return Err("凭据目录不可读取".into());
    }
    if !grants
        .iter()
        .any(|g| p == *g || (g.is_dir() && p.starts_with(g)))
    {
        return Err("文件未获当前会话授权，请在 zGIS 授权文件或目录".into());
    }
    if !p.is_file() || fs::metadata(&p).map_err(|_| "读取元数据失败")?.len() > MAX_BYTES {
        return Err("文件必须小于100MB".into());
    }
    Ok(p)
}
fn read(path: &Path, grants: &[PathBuf]) -> Result<Vec<u8>, String> {
    let p = authorized(path, grants)?;
    fs::read(p).map_err(|e| e.to_string())
}
pub fn load(path: &str, args: &Value, grants: &[PathBuf]) -> Result<Vec<Value>, String> {
    let p = authorized(Path::new(path), grants)?;
    let bytes = read(&p, grants)?;
    let mut features = match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "json" | "geojson" => {
            if args["crs"].as_str().is_some_and(|c| c != "EPSG:4326") {
                return Err("GeoJSON固定为RFC7946 WGS84，不能指定EPSG:3857".into());
            }
            let mut v: Value = serde_json::from_slice(&bytes).map_err(|_| "无效GeoJSON")?;
            preserve_property_numbers(&mut v);
            if v.get("crs").is_some() {
                return Err("GeoJSON必须是RFC7946 WGS84，不支持crs成员".into());
            }
            match v["type"].as_str() {
                Some("FeatureCollection") => {
                    v["features"].as_array().ok_or("缺少features")?.clone()
                }
                Some("Feature") => vec![v],
                _ => return Err("需要Feature或FeatureCollection".into()),
            }
        }
        "csv" => csv_features(&bytes, args)?,
        "shp" => {
            let mut parts = HashMap::new();
            for ext in ["shp", "shx", "dbf", "prj", "cpg"] {
                let q = p.with_extension(ext);
                if q.exists() {
                    parts.insert(ext.into(), read(&q, grants)?);
                }
            }
            shp_features(parts, args)?
        }
        "zip" => {
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "无效ZIP")?;
            let mut parts = HashMap::new();
            let mut stem = None;
            let mut total = 0u64;
            for i in 0..zip.len() {
                let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
                let Some(q) = f.enclosed_name() else {
                    return Err("ZIP含越界路径".into());
                };
                if q.components().any(|c| {
                    c.as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("_credentials")
                }) {
                    return Err("ZIP含凭据目录".into());
                }
                let ext = q
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ["shp", "shx", "dbf", "prj", "cpg"].contains(&ext.as_str()) {
                    let key = q.with_extension("");
                    if let Some(s) = &stem {
                        if *s != key {
                            return Err("ZIP只能包含一组SHP".into());
                        }
                    } else {
                        stem = Some(key)
                    }
                    total += f.size();
                    if total > MAX_BYTES {
                        return Err("解压大小超过100MB".into());
                    }
                    let mut b = Vec::new();
                    f.by_ref()
                        .take(MAX_BYTES + 1)
                        .read_to_end(&mut b)
                        .map_err(|e| e.to_string())?;
                    if b.len() as u64 > MAX_BYTES {
                        return Err("解压大小超过100MB".into());
                    }
                    if parts.insert(ext, b).is_some() {
                        return Err("ZIP包含重复配套文件".into());
                    }
                }
            }
            shp_features(parts, args)?
        }
        _ => return Err("仅支持GeoJSON、CSV、SHP及SHP ZIP".into()),
    };
    if features.len() > 100_000 {
        return Err("最多100000要素".into());
    }
    for f in &mut features {
        if f["type"] != "Feature" {
            return Err("无效Feature".into());
        }
        validate_geometry(&f["geometry"])?;
    }
    Ok(features)
}
fn csv_features(bytes: &[u8], args: &Value) -> Result<Vec<Value>, String> {
    let mut r = csv::Reader::from_reader(bytes);
    let headers = r.headers().map_err(|e| e.to_string())?.clone();
    let mut names = std::collections::HashSet::new();
    for h in &headers {
        if h.is_empty() || !names.insert(h) {
            return Err("CSV列名为空或重复，无法可靠映射".into());
        }
    }
    for key in ["wktField", "xField", "yField"] {
        if let Some(name) = args[key].as_str() {
            if !headers.iter().any(|h| h == name) {
                return Err(format!("指定的{key}列不存在"));
            }
        }
    }
    if args["wktField"].is_string() && (args["xField"].is_string() || args["yField"].is_string()) {
        return Err("wktField不能与xField/yField同时指定".into());
    }
    let find = |key: &str, names: &[&str]| {
        args[key]
            .as_str()
            .and_then(|n| headers.iter().position(|h| h == n))
            .or_else(|| {
                headers
                    .iter()
                    .position(|h| names.contains(&h.to_ascii_lowercase().as_str()))
            })
    };
    let w = if args["xField"].is_string() || args["yField"].is_string() {
        None
    } else {
        find("wktField", &["wkt", "geometry"])
    };
    let x = find("xField", &["x", "lon", "longitude"]);
    let y = find("yField", &["y", "lat", "latitude"]);
    let mut out = Vec::new();
    for row in r.records() {
        let row = row.map_err(|e| e.to_string())?;
        let g = if let Some(i) = w {
            let parsed: wkt::Wkt<f64> = row[i].parse().map_err(|_| "无效WKT")?;
            let geo: geo::Geometry<f64> = parsed.try_into().map_err(|_| "不支持WKT")?;
            serde_json::to_value(geojson::Geometry::new(geojson::Value::from(&geo)))
                .map_err(|e| e.to_string())?
        } else {
            let (i, j) = (
                x.ok_or("CSV缺少xField或wktField")?,
                y.ok_or("CSV缺少yField")?,
            );
            json!({"type":"Point","coordinates":[row[i].parse::<f64>().map_err(|_|"无效X")?,row[j].parse::<f64>().map_err(|_|"无效Y")?]})
        };
        let props: serde_json::Map<String, Value> = headers
            .iter()
            .zip(row.iter())
            .filter(|(h, _)| Some(*h) != w.map(|i| &headers[i]))
            .map(|(h, v)| (h.into(), json!(v)))
            .collect();
        out.push(json!({"type":"Feature","geometry":g,"properties":props}));
        if out.len() > 100_000 {
            return Err("最多100000要素".into());
        }
    }
    transform(&mut out, args["crs"].as_str().unwrap_or("EPSG:4326"))?;
    Ok(out)
}
fn shp_features(mut parts: HashMap<String, Vec<u8>>, args: &Value) -> Result<Vec<Value>, String> {
    let crs = if let Some(c) = args["crs"].as_str() {
        c.to_string()
    } else {
        let prj = String::from_utf8(parts.remove("prj").ok_or("SHP缺少PRJ，请明确提供crs")?)
            .map_err(|_| "无效PRJ")?;
        identify_prj(&prj)?.into()
    };
    let shp = parts.remove("shp").ok_or("缺少SHP")?;
    let dbf = parts.remove("dbf").ok_or("缺少DBF")?;
    reject_lossy_dbf_numbers(&dbf)?;
    let cpg = parts
        .remove("cpg")
        .map(|b| String::from_utf8_lossy(&b).trim().to_ascii_uppercase());
    let encoding = match cpg.as_deref() {
        Some("UTF-8" | "UTF8" | "65001") => Some(dbase::encoding_rs::UTF_8),
        Some("GBK" | "936" | "GB2312" | "GB18030") => Some(dbase::encoding_rs::GBK),
        Some(_) => return Err("不支持的CPG编码".into()),
        None => None,
    };
    let d = if let Some(e) = encoding {
        dbase::Reader::new_with_encoding(Cursor::new(dbf), dbase::encoding::EncodingRs::from(e))
    } else {
        dbase::Reader::new(Cursor::new(dbf))
    }
    .map_err(|e| e.to_string())?;
    let mut r = shapefile::Reader::new(
        shapefile::ShapeReader::new(Cursor::new(shp)).map_err(|e| e.to_string())?,
        d,
    );
    let mut out = Vec::new();
    for record in r.iter_shapes_and_records() {
        let (s, props) = record.map_err(|e| e.to_string())?;
        if props
            .as_ref()
            .values()
            .any(|v| matches!(v, dbase::FieldValue::DateTime(_)))
        {
            return Err("暂不支持DBF DateTime字段，请先转换".into());
        }
        if !matches!(
            s,
            shapefile::Shape::NullShape
                | shapefile::Shape::Point(_)
                | shapefile::Shape::Polyline(_)
                | shapefile::Shape::Polygon(_)
                | shapefile::Shape::Multipoint(_)
        ) {
            return Err("不支持Z/M或特殊几何".into());
        }
        let geom = if matches!(s, shapefile::Shape::NullShape) {
            Value::Null
        } else {
            let g: geo::Geometry<f64> = s.try_into().map_err(|_| "几何转换失败")?;
            serde_json::to_value(geojson::Geometry::new(geojson::Value::from(&g)))
                .map_err(|e| e.to_string())?
        };
        let properties: serde_json::Map<String, Value> = props
            .into_iter()
            .map(|(k, v)| {
                use dbase::FieldValue::*;
                let value = match v {
                    Character(v) => json!(v),
                    Numeric(v) => json!(v),
                    Logical(v) => json!(v),
                    Float(v) => json!(v),
                    Integer(v) => json!(v),
                    Currency(v) | Double(v) => json!(v),
                    Date(v) => v.map(|d| json!(d.to_string())).unwrap_or(Value::Null),
                    Memo(v) => json!(v),
                    DateTime(v) => json!(format!("{v:?}")),
                };
                (k, value)
            })
            .collect();
        out.push(json!({"type":"Feature","geometry":geom,"properties":properties}));
        if out.len() > 100_000 {
            return Err("最多100000要素".into());
        }
    }
    transform(&mut out, &crs)?;
    Ok(out)
}
fn reject_lossy_dbf_numbers(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 32 {
        return Err("DBF头不完整".into());
    }
    let header = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let record = u16::from_le_bytes([bytes[10], bytes[11]]) as usize;
    if header > bytes.len() || record == 0 {
        return Err("无效DBF头".into());
    }
    let mut offset = 1;
    let mut fields = vec![];
    let mut pos = 32;
    while pos + 32 <= header && bytes[pos] != 0x0d {
        let length = bytes[pos + 16] as usize;
        if matches!(bytes[pos + 11], b'N' | b'F') {
            fields.push((offset, length));
        }
        offset += length;
        pos += 32;
    }
    for row in bytes[header..].chunks(record) {
        if row.len() != record {
            break;
        }
        for (o, len) in &fields {
            let raw = row.get(*o..o + len).ok_or("无效DBF字段长度")?;
            let text = std::str::from_utf8(raw).map_err(|_| "无效数值字段")?.trim();
            if text.is_empty() || text.chars().all(|c| c == '*') {
                continue;
            }
            let mantissa = text.split(['e', 'E']).next().unwrap_or("");
            let significant = if mantissa.contains('.') {
                mantissa.trim_end_matches('0')
            } else {
                mantissa
            }
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>();
            if significant.trim_start_matches('0').len() > 15
                || text
                    .parse::<f64>()
                    .ok()
                    .is_some_and(|n| n.fract() == 0.0 && n.abs() > 9_007_199_254_740_991.0)
            {
                return Err("DBF包含超出安全精度的数值，请将该字段转换为文本再加载".into());
            }
        }
    }
    Ok(())
}
fn transform(features: &mut [Value], crs: &str) -> Result<(), String> {
    if !["EPSG:4326", "EPSG:3857"].contains(&crs) {
        return Err("仅支持EPSG:4326/3857".into());
    }
    if crs == "EPSG:3857" {
        fn walk(v: &mut Value) {
            if let Some(a) = v.as_array_mut() {
                if a.len() >= 2 && a[0].is_number() {
                    let x = a[0].as_f64().unwrap();
                    let y = a[1].as_f64().unwrap();
                    a[0] = json!(x / 6378137.0 * 180.0 / std::f64::consts::PI);
                    a[1] = json!(
                        (2.0 * (y / 6378137.0).exp().atan() - std::f64::consts::FRAC_PI_2) * 180.0
                            / std::f64::consts::PI
                    );
                } else {
                    for child in a {
                        walk(child)
                    }
                }
            }
        }
        for f in features {
            walk(&mut f["geometry"]["coordinates"]);
        }
    }
    Ok(())
}
pub fn validate_geometry(g: &Value) -> Result<(), String> {
    if g.is_null() {
        return Ok(());
    }
    if g["type"] == "GeometryCollection" {
        return Err("暂不支持GeometryCollection".into());
    }
    fn walk(v: &Value) -> Result<(), String> {
        let a = v.as_array().ok_or("坐标必须为数组")?;
        if a.first().is_some_and(Value::is_number) {
            if a.len() != 2 {
                return Err("只支持二维坐标".into());
            }
            let x = a[0].as_f64().ok_or("无效坐标")?;
            let y = a[1].as_f64().ok_or("无效坐标")?;
            if !x.is_finite() || !y.is_finite() || x.abs() > 180.0 || y.abs() > 90.0 {
                return Err("坐标超出WGS84范围".into());
            }
        } else {
            for c in a {
                walk(c)?
            }
        }
        Ok(())
    }
    walk(&g["coordinates"])?;
    let _: geojson::Geometry = serde_json::from_value(g.clone()).map_err(|_| "无效几何")?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ambiguous_prj_csv_and_geojson_crs() {
        assert!(identify_prj(
            "GEOGCS[\"custom3857\",DATUM[\"NAD83\",SPHEROID[\"GRS80\",6378137,298.257222101]]]"
        )
        .is_err());
        assert!(identify_prj("PROJCS[\"custom\",GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS84\",6378137,298.257223563]],AUTHORITY[\"EPSG\",\"4326\"]]]").is_err());
        assert!(csv_features(b"x,y,x\n1,2,3", &json!({})).is_err());
        assert!(csv_features(b"x,y\n1,2", &json!({"xField":"missing"})).is_err());
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.geojson");
        fs::write(&p, r#"{"type":"FeatureCollection","features":[]}"#).unwrap();
        assert!(load(
            p.to_str().unwrap(),
            &json!({"crs":"EPSG:3857"}),
            &[p.canonicalize().unwrap()]
        )
        .is_err());
    }
    #[test]
    fn preserves_high_precision_nested_properties() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.geojson");
        fs::write(&p,r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":9007199254740993,"decimal":1.1234567890123456789,"nested":[9007199254740993],"normal":1.25}}"#).unwrap();
        let f = load(
            p.to_str().unwrap(),
            &json!({}),
            &[p.canonicalize().unwrap()],
        )
        .unwrap();
        assert_eq!(f[0]["properties"]["id"], "9007199254740993");
        assert_eq!(f[0]["properties"]["decimal"], "1.1234567890123456789");
        assert_eq!(f[0]["properties"]["normal"], 1.25);
    }
    #[test]
    fn loads_csv_custom_fields_and_projection() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("points.csv");
        fs::write(&p, "east,north,name\n111319.49079327357,0,北京\n").unwrap();
        let grants = vec![dir.path().canonicalize().unwrap()];
        let f = load(
            p.to_str().unwrap(),
            &json!({"xField":"east","yField":"north","crs":"EPSG:3857"}),
            &grants,
        )
        .unwrap();
        assert!((f[0]["geometry"]["coordinates"][0].as_f64().unwrap() - 1.).abs() < 1e-9);
        assert_eq!(f[0]["properties"]["name"], "北京");
    }
    #[test]
    fn reads_chinese_shp_zip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("points.zip");
        let f = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"name":"北京","value":12.125}});
        let bytes = crate::shapefile_export::build_zip(&[f], "points").unwrap();
        fs::write(&p, bytes).unwrap();
        let out = load(
            p.to_str().unwrap(),
            &json!({}),
            &[p.canonicalize().unwrap()],
        )
        .unwrap();
        assert_eq!(out[0]["properties"]["name"], "北京");
        assert_eq!(out[0]["properties"]["value"], 12.125);
        assert_eq!(out[0]["geometry"]["coordinates"], json!([116.4, 39.9]));
    }
    #[cfg(windows)]
    #[test]
    fn canonical_symlink_cannot_escape_grant() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("data.json");
        fs::write(&target, "{}").unwrap();
        let link = dir.path().join("data.json");
        if std::os::windows::fs::symlink_file(&target, &link).is_ok() {
            assert!(authorized(&link, &[dir.path().canonicalize().unwrap()]).is_err());
        }
    }
    #[test]
    fn denies_ungranted_and_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.geojson");
        fs::write(&p, b"{}").unwrap();
        assert!(authorized(&p, &[]).is_err());
        assert!(authorized(&p, &[dir.path().canonicalize().unwrap()]).is_ok());
        let secret = dir.path().join("_credentials");
        fs::create_dir(&secret).unwrap();
        let p = secret.join("a.json");
        fs::write(&p, b"{}").unwrap();
        assert!(authorized(&p, &[dir.path().canonicalize().unwrap()]).is_err());
    }
    #[test]
    fn rejects_z_and_outside() {
        assert!(validate_geometry(&json!({"type":"Point","coordinates":[1,2,3]})).is_err());
        assert!(validate_geometry(&json!({"type":"Point","coordinates":[181,2]})).is_err());
    }
}
