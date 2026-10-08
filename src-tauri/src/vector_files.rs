//! 只读矢量加载；文件访问授权由调用方负责，输出统一为 WGS84 GeoJSON，保留 XYZ 高程。
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Cursor, Read},
    path::Path,
};
const MAX_BYTES: u64 = 100 * 1024 * 1024;
fn wkt_geometry(g: &wkt::Wkt<f64>) -> Result<Value, String> {
    fn coord(c: &wkt::types::Coord<f64>) -> Result<Value, String> {
        if c.m.is_some() { return Err("不支持 WKT M/ZM".into()); }
        Ok(if let Some(z) = c.z { json!([c.x,c.y,z]) } else { json!([c.x,c.y]) })
    }
    fn point(p: &wkt::types::Point<f64>) -> Result<Value,String> { coord(p.coord().ok_or("不支持空WKT")?) }
    fn line(l: &wkt::types::LineString<f64>) -> Result<Value,String> { Ok(Value::Array(l.coords().iter().map(coord).collect::<Result<_,_>>()?)) }
    fn polygon(p: &wkt::types::Polygon<f64>) -> Result<Value,String> { Ok(Value::Array(p.rings().iter().map(line).collect::<Result<_,_>>()?)) }
    let (kind, coordinates) = match g {
        wkt::Wkt::Point(p) => ("Point",point(p)?),
        wkt::Wkt::LineString(l) => ("LineString",line(l)?),
        wkt::Wkt::Polygon(p) => ("Polygon",polygon(p)?),
        wkt::Wkt::MultiPoint(p) => ("MultiPoint",Value::Array(p.points().iter().map(point).collect::<Result<_,_>>()?)),
        wkt::Wkt::MultiLineString(l) => ("MultiLineString",Value::Array(l.line_strings().iter().map(line).collect::<Result<_,_>>()?)),
        wkt::Wkt::MultiPolygon(p) => ("MultiPolygon",Value::Array(p.polygons().iter().map(polygon).collect::<Result<_,_>>()?)),
        _ => return Err("不支持WKT几何集合".into()),
    };
    Ok(json!({"type":kind,"coordinates":coordinates}))
}

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
                if let Some(properties) = f.get_mut("properties") {
                    walk(properties);
                }
                if let Some(id) = f.get_mut("id") {
                    walk(id);
                }
            }
        }
    } else if v["type"] == "Feature" {
        if let Some(properties) = v.get_mut("properties") {
            walk(properties);
        }
        if let Some(id) = v.get_mut("id") {
            walk(id);
        }
    }
}
pub(crate) fn identify_prj(prj: &str) -> Result<&'static str, String> {
    let p = prj
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    let known="GEOGCS[\"WGS84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS84\",6378137,298.257223563]],PRIMEM[\"GREENWICH\",0],UNIT[\"DEGREE\",0.0174532925199433]]";
    if p == known {
        return Ok("EPSG:4326");
    }
    if p.starts_with("GEOGCS[")
        && (p.contains("DATUM[\"CHINA_2000\",") || p.contains("DATUM[\"D_CHINA_2000\","))
        && p.contains("298.257222101")
        && p.contains("PRIMEM[\"GREENWICH\",0")
        && (p.ends_with("AUTHORITY[\"EPSG\",\"4490\"]]") || !p.contains("AUTHORITY[")) {
        return Ok("EPSG:4490");
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
    Err("PRJ无法严格识别为EPSG:4326/4490/3857，请明确指定已核实的crs或预先转换".into())
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|_| "读取元数据失败")?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("文件必须小于100MB".into());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("文件必须小于100MB".into());
    }
    Ok(bytes)
}
pub fn load(path: &str, args: &Value) -> Result<Vec<Value>, String> {
    // 解析实际文件位置，使 SHP 符号链接仍能找到目标文件组的配套文件。
    let p = Path::new(path).canonicalize().map_err(|_| "文件不存在或不可访问")?;
    let bytes = read(&p)?;
    let mut features = match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "json" | "geojson" => {
            let mut v: Value = serde_json::from_slice(&bytes).map_err(|_| "无效GeoJSON")?;
            preserve_property_numbers(&mut v);
            let declared = if let Some(crs) = v.get("crs") {
                let name = if crs["type"] == "name" { crs["properties"]["name"].as_str() } else { None };
                let name = name.ok_or("GeoJSON坐标系标记无效或不支持")?.to_ascii_uppercase();
                let code = name.strip_prefix("EPSG:")
                    .or_else(|| name.strip_prefix("URN:OGC:DEF:CRS:EPSG:").and_then(|tail| tail.split_once(':').filter(|(_, code)| !code.contains(':')).map(|(_, code)| code)))
                    .or_else(|| name.strip_prefix("HTTP://WWW.OPENGIS.NET/DEF/CRS/EPSG/0/"))
                    .or_else(|| name.strip_prefix("HTTPS://WWW.OPENGIS.NET/DEF/CRS/EPSG/0/"));
                Some(match code {
                    Some("4326") => "EPSG:4326", Some("4490") => "EPSG:4490", Some("3857") => "EPSG:3857",
                    _ if name == "URN:OGC:DEF:CRS:OGC:1.3:CRS84" || name == "OGC:CRS84" => "EPSG:4326",
                    _ => return Err("GeoJSON坐标系标记无效或不支持".into()),
                })
            } else { None };
            if let (Some(explicit), Some(declared)) = (args["crs"].as_str(), declared) {
                if explicit != declared { return Err("指定坐标系与GeoJSON crs标记冲突".into()); }
            }
            let crs = args["crs"].as_str().or(declared).unwrap_or("EPSG:4326");
            let crs = crs.to_owned();
            let mut out = match v["type"].as_str() {
                Some("FeatureCollection") => {
                    let features = v["features"].as_array().ok_or("缺少features")?;
                    if features.len() > 100_000 {
                        return Err("最多100000要素".into());
                    }
                    match v["features"].take() {
                        Value::Array(features) => features,
                        _ => unreachable!(),
                    }
                }
                Some("Feature") => vec![v],
                _ => return Err("需要Feature或FeatureCollection".into()),
            };
            transform(&mut out, &crs)?;
            out
        }
        "csv" => csv_features(&bytes, args)?,
        "shp" => {
            let mut parts = HashMap::new();
            let mut total = 0;
            let mut source = Some(bytes);
            for ext in ["shp", "shx", "dbf", "prj", "cpg"] {
                let q = p.with_extension(ext);
                if q.exists() {
                    let part = if ext == "shp" {
                        source.take().ok_or("缺少SHP")?
                    } else {
                        read(&q)?
                    };
                    total += part.len() as u64;
                    if total > MAX_BYTES {
                        return Err("SHP文件组大小超过100MB".into());
                    }
                    parts.insert(ext.into(), part);
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
                    total = total.checked_add(f.size()).ok_or("解压大小超过100MB")?;
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
        if f.get("geometry").is_none() {
            return Err("Feature缺少geometry".into());
        }
        if !f
            .get("properties")
            .is_some_and(|p| p.is_null() || p.is_object())
        {
            return Err("Feature属性必须为对象或null".into());
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
            wkt_geometry(&parsed)?
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
    if !["EPSG:4326", "EPSG:4490", "EPSG:3857"].contains(&crs) {
        return Err("仅支持EPSG:4326/4490/3857".into());
    }
    if crs == "EPSG:3857" {
        fn walk(v: &mut Value) -> Result<(), String> {
            let a = v.as_array_mut().ok_or("坐标必须为数组")?;
            if a.first().is_some_and(Value::is_number) {
                if ![2, 3].contains(&a.len()) {
                    return Err("仅支持二维或带高程XYZ坐标，不支持M/ZM".into());
                }
                if a.iter().any(|v| !v.as_f64().is_some_and(f64::is_finite)) {
                    return Err("坐标分量必须为有限数值".into());
                }
                let x = a[0].as_f64().ok_or("无效X")?;
                let y = a[1].as_f64().ok_or("无效Y")?;
                a[0] = json!(x / 6378137.0 * 180.0 / std::f64::consts::PI);
                a[1] = json!(
                    (2.0 * (y / 6378137.0).exp().atan() - std::f64::consts::FRAC_PI_2) * 180.0
                        / std::f64::consts::PI
                );
            } else {
                for child in a {
                    walk(child)?;
                }
            }
            Ok(())
        }
        for f in features {
            let geometry = f.get_mut("geometry").ok_or("Feature缺少geometry")?;
            if !geometry.is_null() {
                walk(
                    geometry
                        .get_mut("coordinates")
                        .ok_or("几何缺少coordinates")?,
                )?;
            }
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
            if ![2, 3].contains(&a.len()) {
                return Err("仅支持二维或带高程XYZ坐标，不支持M/ZM".into());
            }
            if a.iter().any(|v| !v.as_f64().is_some_and(f64::is_finite)) { return Err("坐标分量必须为有限数值".into()); }
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
    use std::io::Write;

    fn zip_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            archive.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    fn write_shp_group(dir: &Path) -> std::path::PathBuf {
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"name":"北京","value":12.125}});
        let bytes = crate::shapefile_export::build_zip(&[feature], "points").unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        for ext in ["shp", "shx", "dbf", "prj", "cpg"] {
            let name = format!("points.{ext}");
            let mut bytes = Vec::new();
            archive.by_name(&name).unwrap().read_to_end(&mut bytes).unwrap();
            fs::write(dir.join(name), bytes).unwrap();
        }
        dir.join("points.shp")
    }

    #[test]
    fn geojson_crs_metadata_and_override() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("point.geojson");
        for crs in ["EPSG:4326", "EPSG:4490", "EPSG:3857"] {
            let xy = if crs == "EPSG:3857" { json!([111319.49079327357,0]) } else { json!([1,0]) };
            let mut document = json!({"type":"Feature","geometry":{"type":"Point","coordinates":xy},"properties":{},"crs":{"type":"name","properties":{"name":format!("urn:ogc:def:crs:EPSG::{}", &crs[5..])}}});
            fs::write(&path, document.to_string()).unwrap();
            let out = load(path.to_str().unwrap(), &json!({})).unwrap();
            assert!((out[0]["geometry"]["coordinates"][0].as_f64().unwrap() - 1.0).abs() < 1e-8);
            if crs != "EPSG:4326" { assert!(load(path.to_str().unwrap(), &json!({"crs":"EPSG:4326"})).is_err()); }
            document.as_object_mut().unwrap().remove("crs");
            fs::write(&path, document.to_string()).unwrap();
            assert!((load(path.to_str().unwrap(), &json!({"crs":crs})).unwrap()[0]["geometry"]["coordinates"][0].as_f64().unwrap() - 1.0).abs() < 1e-8);
        }
        fs::write(&path, r#"{"type":"FeatureCollection","features":[],"crs":{"type":"name","properties":{"name":"EPSG:9999"}}}"#).unwrap();
        assert!(load(path.to_str().unwrap(), &json!({})).is_err());
    }
    #[test]
    fn projected_geojson_rejects_malformed_coordinates_without_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("projected.geojson");
        for coordinates in [
            json!([1, "invalid"]),
            json!([1]),
            json!([1, 2, null]),
            json!([1, 2, 3, 4]),
            serde_json::from_str("[1,1e999]").unwrap(),
        ] {
            let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":coordinates},"properties":{}});
            fs::write(&path, feature.to_string()).unwrap();
            assert!(load(path.to_str().unwrap(), &json!({"crs":"EPSG:3857"})).is_err());
        }
        let feature = json!({"type":"Feature","geometry":null,"properties":{}});
        fs::write(&path, feature.to_string()).unwrap();
        assert_eq!(
            load(path.to_str().unwrap(), &json!({"crs":"EPSG:3857"})).unwrap(),
            vec![feature]
        );
        for document in [
            json!({"type":"FeatureCollection","features":[1]}),
            json!({"type":"Feature","geometry":"invalid","properties":{}}),
            json!({"type":"Feature","properties":{}}),
            json!({"type":"Feature","geometry":null,"properties":1}),
        ] {
            fs::write(&path, document.to_string()).unwrap();
            for crs in ["EPSG:4326", "EPSG:3857"] {
                assert!(load(path.to_str().unwrap(), &json!({"crs":crs})).is_err());
            }
        }
    }
    #[test]
    fn rejects_combined_oversized_shapefile_group() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.shp");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES / 2 + 1)
            .unwrap();
        fs::File::create(path.with_extension("shx"))
            .unwrap()
            .set_len(MAX_BYTES / 2)
            .unwrap();
        assert_eq!(
            load(path.to_str().unwrap(), &json!({})).unwrap_err(),
            "SHP文件组大小超过100MB"
        );
    }
    #[test]
    fn three_crs_shapefile_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"name":"北京"}});
        for crs in ["EPSG:4326", "EPSG:4490", "EPSG:3857"] {
            let bytes = crate::shapefile_export::build_zip_crs(&[feature.clone()], "points", crs).unwrap();
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            let mut prj = String::new();
            archive.by_name("points.prj").unwrap().read_to_string(&mut prj).unwrap();
            assert_eq!(identify_prj(&prj).unwrap(), crs);
            let mut shape_bytes = Vec::new();
            archive.by_name("points.shp").unwrap().read_to_end(&mut shape_bytes).unwrap();
            let shapes = shapefile::ShapeReader::new(std::io::Cursor::new(shape_bytes)).unwrap().read().unwrap();
            if let shapefile::Shape::Point(point) = &shapes[0] {
                if crs == "EPSG:3857" {
                    assert!((point.x - 12957588.728337).abs() < 0.001);
                    assert!((point.y - 4851421.175183).abs() < 0.001);
                } else { assert_eq!((point.x, point.y), (116.4, 39.9)); }
            } else { panic!("Expected point"); }
            let path = dir.path().join("points.zip");
            fs::write(&path, bytes).unwrap();
            let out = load(path.to_str().unwrap(), &json!({})).unwrap();
            let xy = &out[0]["geometry"]["coordinates"];
            assert!((xy[0].as_f64().unwrap() - 116.4).abs() < 1e-8);
            assert!((xy[1].as_f64().unwrap() - 39.9).abs() < 1e-8);
        }
        assert!(crate::shapefile_export::build_zip_crs(&[feature], "points", "EPSG:9999").is_err());
        let polar = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[0,90]},"properties":{}});
        assert!(crate::shapefile_export::build_zip_crs(&[polar], "points", "EPSG:3857").is_err());
        assert_eq!(csv_features(b"x,y\n116.4,39.9", &json!({"crs":"EPSG:4490"})).unwrap()[0]["geometry"]["coordinates"], json!([116.4,39.9]));
    }
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
            &json!({"crs":"EPSG:9999"})
        )
        .is_err());
    }
    #[test]
    fn preserves_high_precision_nested_properties() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.geojson");
        fs::write(&p,r#"{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"id":9007199254740993,"decimal":1.1234567890123456789,"nested":[9007199254740993],"normal":1.25}}"#).unwrap();
        let f = load(p.to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(f[0]["properties"]["id"], "9007199254740993");
        assert_eq!(f[0]["properties"]["decimal"], "1.1234567890123456789");
        assert_eq!(f[0]["properties"]["normal"], 1.25);
    }
    #[test]
    fn loads_csv_custom_fields_and_projection() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("points.csv");
        fs::write(&p, "east,north,name\n111319.49079327357,0,北京\n").unwrap();
        let f = load(
            p.to_str().unwrap(),
            &json!({"xField":"east","yField":"north","crs":"EPSG:3857"}),
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
        let out = load(p.to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(out[0]["properties"]["name"], "北京");
        assert_eq!(out[0]["properties"]["value"], 12.125);
        assert_eq!(out[0]["geometry"]["coordinates"], json!([116.4, 39.9]));
    }
    #[test]
    fn loads_external_geojson_without_path_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{"name":"external"}});
        let p = dir.path().join("a.geojson");
        fs::write(&p, feature.to_string()).unwrap();
        assert_eq!(load(p.to_str().unwrap(), &json!({})).unwrap(), vec![feature.clone()]);
        let named_dir = dir.path().join("_credentials");
        fs::create_dir(&named_dir).unwrap();
        let p = named_dir.join("a.geojson");
        fs::write(&p, feature.to_string()).unwrap();
        assert_eq!(load(p.to_str().unwrap(), &json!({})).unwrap(), vec![feature]);
    }
    #[test]
    fn loads_external_wkt_csv_without_grants() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("points.csv");
        fs::write(&path, "label,shape\norigin,POINT Z (1 2 3)\n").unwrap();
        let out = load(path.to_str().unwrap(), &json!({"wktField":"shape"})).unwrap();
        assert_eq!(out[0]["geometry"]["coordinates"], json!([1.0, 2.0, 3.0]));
        assert_eq!(out[0]["properties"], json!({"label":"origin"}));
    }
    #[test]
    fn loads_external_shp_file_group_without_grants() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_shp_group(dir.path());
        let out = load(path.to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(out[0]["geometry"]["coordinates"], json!([116.4, 39.9]));
        assert_eq!(out[0]["properties"]["name"], "北京");
        assert_eq!(out[0]["properties"]["value"], 12.125);
        fs::remove_file(path.with_extension("dbf")).unwrap();
        assert_eq!(load(path.to_str().unwrap(), &json!({})).unwrap_err(), "缺少DBF");
    }
    #[cfg(any(windows, unix))]
    #[test]
    fn symbolic_links_load_external_geojson_and_shp_file_group() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("data.geojson");
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{}});
        fs::write(&target, feature.to_string()).unwrap();
        let link = dir.path().join("data.geojson");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &link);
        if let Err(error) = linked {
            eprintln!("当前环境不能创建符号链接，跳过此用例：{error}");
            return;
        }
        assert_eq!(load(link.to_str().unwrap(), &json!({})).unwrap(), vec![feature]);

        let target = write_shp_group(outside.path());
        let link = dir.path().join("linked.shp");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let out = load(link.to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(out[0]["geometry"]["coordinates"], json!([116.4, 39.9]));
        assert_eq!(out[0]["properties"]["name"], "北京");
    }
    #[test]
    fn rejects_unsupported_invalid_and_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.txt");
        fs::write(&path, "{}").unwrap();
        assert_eq!(load(path.to_str().unwrap(), &json!({})).unwrap_err(), "仅支持GeoJSON、CSV、SHP及SHP ZIP");
        let path = dir.path().join("invalid.geojson");
        fs::write(&path, "not json").unwrap();
        assert_eq!(load(path.to_str().unwrap(), &json!({})).unwrap_err(), "无效GeoJSON");
        let path = dir.path().join("oversized.geojson");
        fs::File::create(&path).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert_eq!(load(path.to_str().unwrap(), &json!({})).unwrap_err(), "文件必须小于100MB");
    }
    #[test]
    fn loads_shp_zip_with_policy_neutral_directory_names() {
        let dir = tempfile::tempdir().unwrap();
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"name":"北京"}});
        let source = crate::shapefile_export::build_zip(&[feature], "points").unwrap();
        let mut source = zip::ZipArchive::new(Cursor::new(source)).unwrap();
        let mut entries = Vec::new();
        for ext in ["shp", "shx", "dbf", "prj", "cpg"] {
            let mut bytes = Vec::new();
            source.by_name(&format!("points.{ext}")).unwrap().read_to_end(&mut bytes).unwrap();
            entries.push((format!("_credentials/points.{ext}"), bytes));
        }
        let entries: Vec<_> = entries.iter().map(|(name, bytes)| (name.as_str(), bytes.as_slice())).collect();
        let path = dir.path().join("points.zip");
        fs::write(&path, zip_entries(&entries)).unwrap();
        let out = load(path.to_str().unwrap(), &json!({})).unwrap();
        assert_eq!(out[0]["geometry"]["coordinates"], json!([116.4, 39.9]));
        assert_eq!(out[0]["properties"]["name"], "北京");
    }
    #[test]
    fn rejects_zip_traversal_and_oversized_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unsafe.zip");
        fs::write(&path, zip_entries(&[("../points.shp", b"untrusted")])).unwrap();
        assert_eq!(load(path.to_str().unwrap(), &json!({})).unwrap_err(), "ZIP含越界路径");

        let mut bytes = zip_entries(&[("points.shp", b"untrusted")]);
        let central = bytes.windows(4).position(|part| part == b"PK\x01\x02").unwrap();
        // 在 ZIP 目录中声明超限解压大小，确认读取内容前就会拒绝。
        bytes[central + 24..central + 28].copy_from_slice(&((MAX_BYTES + 1) as u32).to_le_bytes());
        fs::write(&path, bytes).unwrap();
        assert_eq!(load(path.to_str().unwrap(), &json!({})).unwrap_err(), "解压大小超过100MB");
    }
    #[test]
    fn accepts_z_rejects_extra_and_outside() {
        let z: wkt::Wkt<f64> = "LINESTRING Z (1 2 5,3 4 7)".parse().unwrap();
        assert_eq!(wkt_geometry(&z).unwrap()["coordinates"], json!([[1.0,2.0,5.0],[3.0,4.0,7.0]]));
        let m: wkt::Wkt<f64> = "POINT M (1 2 7)".parse().unwrap();
        assert!(wkt_geometry(&m).is_err());
        assert!(validate_geometry(&json!({"type":"Point","coordinates":[1,2,3]})).is_ok());
        assert!(validate_geometry(&json!({"type":"Point","coordinates":[1,2,3,4]})).is_err());
        assert!(validate_geometry(&json!({"type":"Point","coordinates":[181,2]})).is_err());
    }
}
