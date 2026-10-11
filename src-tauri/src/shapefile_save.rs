//! 桌面来源回写；不通过 MCP 暴露文件覆盖能力。
use super::{
    atomic_write, atomic_write_new, fingerprint, hash_text, io_error, move_file_new, FileHandle,
    SavedFile, MAX_FILE,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const CORE: [&str; 5] = ["shp", "shx", "dbf", "prj", "cpg"];
// 编辑后这些索引/统计元数据失效，必须一并参与冲突检测并在成功回写时移除。
const AUXILIARY: [&str; 14] = [
    "sbn", "sbx", "fbn", "fbx", "qix", "ain", "aih", "ixs", "mxs", "atx", "fix", "idm", "ind",
    "shp.xml",
];

fn component_suffix(name: &str, stem: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    let prefix = format!("{}.", stem.to_ascii_lowercase());
    let suffix = name.strip_prefix(&prefix)?;
    (CORE.contains(&suffix) || AUXILIARY.contains(&suffix) || suffix.ends_with(".atx"))
        .then(|| suffix.to_string())
}

fn group_entries(path: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let directory = path.parent().ok_or("来源目录无效")?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("来源文件名无效")?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(directory).map_err(io_error)? {
        let candidate = entry.map_err(io_error)?.path();
        if let Some(suffix) = candidate
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| component_suffix(n, stem))
        {
            if !candidate.is_file() {
                return Err("SHP 配套路径不是文件".into());
            }
            entries.push((suffix, candidate));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    if entries.windows(2).any(|p| p[0].0 == p[1].0) {
        return Err("SHP 包含重复配套文件".into());
    }
    if !entries.iter().any(|(ext, _)| ext == "shp") {
        return Err("来源 SHP 已不存在".into());
    }
    Ok(entries)
}

pub(super) fn group_paths(path: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = group_entries(path)?;
    Ok(std::iter::once(path.to_path_buf())
        .chain(entries.into_iter().map(|(_, p)| p).filter(|p| p != path))
        .collect())
}

pub(super) fn group_fingerprint(path: &Path) -> Result<Vec<u8>, String> {
    let mut hash = Sha256::new();
    hash.update(b"zgis-shapefile-group-v1\0");
    let mut total = 0u64;
    for (suffix, component) in group_entries(path)? {
        let size = fs::metadata(&component).map_err(io_error)?.len();
        total = total.checked_add(size).ok_or("文件过大")?;
        if total > MAX_FILE {
            return Err("SHP 文件组超过 100 MB".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&component)
            .map_err(io_error)?
            .take(MAX_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 != size {
            return Err("读取时文件发生变化，请重试".into());
        }
        hash.update(suffix.as_bytes());
        hash.update([0]);
        hash.update(size.to_le_bytes());
        hash.update(Sha256::digest(&bytes));
    }
    Ok(hash.finalize().to_vec())
}

fn valid_member(member: &str) -> Result<String, String> {
    let member = member.replace('\\', "/");
    if member.is_empty()
        || member.starts_with('/')
        || member.contains(':')
        || member.contains('\0')
        || member
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("ZIP 图层成员路径无效".into());
    }
    let stem = if member.to_ascii_lowercase().ends_with(".shp") {
        &member[..member.len() - 4]
    } else {
        &member
    };
    if stem.is_empty() || stem.ends_with('/') {
        return Err("ZIP 图层成员路径无效".into());
    }
    Ok(stem.to_string())
}

type Components = Vec<(&'static str, Vec<u8>)>;

fn validate_components(components: &Components, count: usize) -> Result<(), String> {
    let get = |extension: &str| {
        components
            .iter()
            .find(|(ext, _)| *ext == extension)
            .map(|(_, bytes)| bytes.as_slice())
            .ok_or("缺少 SHP 配套文件")
    };
    let shapes =
        shapefile::ShapeReader::with_shx(Cursor::new(get("shp")?), Cursor::new(get("shx")?))
            .map_err(io_error)?;
    let records = shapefile::dbase::Reader::new(Cursor::new(get("dbf")?)).map_err(io_error)?;
    let mut reader = shapefile::Reader::new(shapes, records);
    if reader.read().map_err(io_error)?.len() != count {
        return Err("生成 SHP 记录核验失败".into());
    }
    Ok(())
}

fn build_components(
    features: &[Value],
    crs: Option<&str>,
    old: &HashMap<String, Vec<u8>>,
) -> Result<Components, String> {
    let source_crs = crs.unwrap_or("EPSG:4326");
    let code = if source_crs.starts_with("EPSG:") {
        source_crs
    } else {
        super::vector_files::identify_prj(source_crs)?
    };
    let components = if features.is_empty() {
        // 清空图层保留原几何类型、字段定义和来源 CRS，避免删除最后一个要素后无法保存。
        let mut components = Vec::new();
        for extension in CORE {
            let bytes = old.get(extension);
            let value = match extension {
                "shp" | "shx" => {
                    let source = bytes.ok_or("缺少 SHP/SHX，不能清空来源图层")?;
                    if source.len() < 100 {
                        return Err("无效 SHP/SHX 头部".into());
                    }
                    let mut header = source[..100].to_vec();
                    header[24..28].copy_from_slice(&50i32.to_be_bytes());
                    header[36..100].fill(0);
                    header
                }
                "dbf" => {
                    let source = bytes.ok_or("缺少 DBF，不能清空来源图层")?;
                    if source.len() < 32 {
                        return Err("无效 DBF 头部".into());
                    }
                    let length = u16::from_le_bytes([source[8], source[9]]) as usize;
                    if length < 33 || length > source.len() {
                        return Err("无效 DBF 字段定义".into());
                    }
                    let mut header = source[..length].to_vec();
                    header[4..8].fill(0);
                    header.push(0x1a);
                    header
                }
                "cpg" => bytes.cloned().unwrap_or_else(|| b"UTF-8".to_vec()),
                "prj" => bytes.cloned().unwrap_or_default(),
                _ => unreachable!(),
            };
            components.push((extension, value));
        }
        components
    } else {
        super::shapefile_export::build_components_crs(features, code)?
    };
    validate_components(&components, features.len())?;
    Ok(components)
}

fn replace_zip(
    bytes: Vec<u8>,
    member: Option<&str>,
    features: &[Value],
    crs: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(io_error)?;
    if archive.len() > 1000 {
        return Err("ZIP 文件数量超过 1000".into());
    }
    let mut stems = Vec::new();
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(io_error)?;
        if file.enclosed_name().is_none() || file.name().contains('\\') || file.name().contains(':')
        {
            return Err("ZIP 含无效或越界路径".into());
        }
        if !names.insert(file.name().to_ascii_lowercase()) {
            return Err("ZIP 含重复成员路径".into());
        }
        total = total
            .checked_add(file.size())
            .ok_or("ZIP 解压大小超过 100 MB")?;
        if total > MAX_FILE {
            return Err("ZIP 解压大小超过 100 MB".into());
        }
        if file.name().to_ascii_lowercase().ends_with(".shp") {
            stems.push(file.name()[..file.name().len() - 4].to_string());
        }
    }
    let stem = if let Some(member) = member {
        valid_member(member)?
    } else if stems.len() == 1 {
        stems[0].clone()
    } else {
        return Err("多图层 ZIP 必须指定来源图层成员".into());
    };
    if !stems
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&stem))
    {
        return Err("ZIP 来源图层成员不存在".into());
    }
    let mut original = HashMap::new();
    let mut original_names = HashMap::new();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(io_error)?;
        if let Some(suffix) = component_suffix(file.name(), &stem) {
            original_names.insert(suffix.clone(), file.name().to_string());
            if CORE.contains(&suffix.as_str()) {
                let mut bytes = Vec::new();
                file.by_ref()
                    .take(MAX_FILE + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_error)?;
                if bytes.len() as u64 > MAX_FILE {
                    return Err("ZIP 解压大小超过 100 MB".into());
                }
                original.insert(suffix, bytes);
            }
        }
    }
    let components = build_components(features, crs, &original)?;
    let old_selected_size: u64 = original.values().map(|bytes| bytes.len() as u64).sum();
    let new_selected_size: u64 = components.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    if total
        .saturating_sub(old_selected_size)
        .saturating_add(new_selected_size)
        > MAX_FILE
    {
        return Err("ZIP 输出解压大小超过 100 MB".into());
    }
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    writer.set_raw_comment(archive.comment().to_vec().into());
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(io_error)?;
        if component_suffix(file.name(), &stem).is_none() {
            writer.raw_copy_file(file).map_err(io_error)?;
        }
    }
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (suffix, content) in components {
        let name = original_names
            .get(suffix)
            .cloned()
            .unwrap_or_else(|| format!("{stem}.{suffix}"));
        writer.start_file(name, options).map_err(io_error)?;
        writer.write_all(&content).map_err(io_error)?;
    }
    let result = writer.finish().map_err(io_error)?.into_inner();
    if result.len() as u64 > MAX_FILE {
        return Err("ZIP 输出超过 100 MB".into());
    }
    zip::ZipArchive::new(Cursor::new(&result)).map_err(io_error)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn point(x: f64, label: &str) -> Value {
        json!({"type":"Feature","geometry":{"type":"Point","coordinates":[x,39.9]},"properties":{"name":label}})
    }
    fn source_group(dir: &Path) -> PathBuf {
        let components = super::super::shapefile_export::build_components_crs(
            &[point(116.4, "原件")],
            "EPSG:4326",
        )
        .unwrap();
        super::super::write_shapefile_group(dir, "points", &components).unwrap()
    }
    fn snapshot(path: &Path) -> HashMap<String, Vec<u8>> {
        group_entries(path)
            .unwrap()
            .into_iter()
            .map(|(ext, p)| (ext, fs::read(p).unwrap()))
            .collect()
    }

    #[test]
    fn writes_source_group_and_updates_all_native_handles() {
        let directory = tempfile::tempdir().unwrap();
        let path = source_group(directory.path());
        fs::write(path.with_extension("qix"), b"stale index").unwrap();
        let handles = Mutex::new(HashMap::new());
        let opened = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        let saved = save_source(
            &handles,
            &[point(117.0, "已编辑")],
            Some(&opened[0].source_id),
            None,
            Some(&opened[0].source_hash),
            Some("EPSG:4326"),
            None,
        )
        .unwrap();
        assert_ne!(opened[0].source_hash, saved.source_hash);
        assert!(!path.with_extension("qix").exists());
        let mut reader = shapefile::Reader::from_path(&path).unwrap();
        let records = reader.read().unwrap();
        assert!(matches!(&records[0].0, shapefile::Shape::Point(p) if p.x == 117.0));
        assert_eq!(
            records[0].1.get("name"),
            Some(&shapefile::dbase::FieldValue::Character(Some(
                "已编辑".into()
            )))
        );
        for handle in handles.lock().unwrap().values() {
            assert_eq!(fingerprint(&handle.path).unwrap(), handle.hash);
        }
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".zgis-")));
    }

    #[test]
    fn restored_source_rejects_sidecar_external_change() {
        let directory = tempfile::tempdir().unwrap();
        let path = source_group(directory.path());
        let old_hash = hash_text(&fingerprint(&path).unwrap());
        fs::write(path.with_extension("prj"), b"external edit").unwrap();
        let before = snapshot(&path);
        let handles = Mutex::new(HashMap::new());
        assert!(save_source(
            &handles,
            &[point(117.0, "编辑")],
            None,
            path.to_str(),
            Some(&old_hash),
            None,
            None
        )
        .err()
        .unwrap()
        .contains("外部修改"));
        assert_eq!(snapshot(&path), before);
    }

    #[test]
    fn restored_source_accepts_matching_group_hash_and_can_save_twice() {
        let directory = tempfile::tempdir().unwrap();
        let path = source_group(directory.path());
        let old_hash = hash_text(&fingerprint(&path).unwrap());
        let handles = Mutex::new(HashMap::new());
        let saved = save_source(
            &handles,
            &[point(117.0, "编辑")],
            None,
            path.to_str(),
            Some(&old_hash),
            None,
            None,
        )
        .unwrap();
        save_source(
            &handles,
            &[point(118.0, "继续编辑")],
            Some(&saved.source_id),
            None,
            Some(&saved.source_hash),
            None,
            None,
        )
        .unwrap();
        assert_eq!(handles.lock().unwrap().len(), 1);
    }

    #[test]
    fn failed_group_publication_restores_every_component() {
        let directory = tempfile::tempdir().unwrap();
        let path = source_group(directory.path());
        fs::write(path.with_extension("qix"), b"old index").unwrap();
        let before = snapshot(&path);
        let hash = fingerprint(&path).unwrap();
        let components = build_components(&[point(117.0, "编辑")], None, &before).unwrap();
        let mut calls = 0;
        let result = replace_group(&path, &hash, &components, |temp, target| {
            calls += 1;
            if calls == 2 {
                return Err("simulated publication failure".into());
            }
            move_file_new(temp, target)
        });
        assert!(result.is_err());
        assert_eq!(snapshot(&path), before);
        assert!(fs::read_dir(directory.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".zgis-")));
    }

    fn multi_layer_zip(path: &Path) -> HashMap<String, Vec<u8>> {
        let mut entries = HashMap::new();
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.set_comment("archive metadata");
        for stem in ["folder/points", "another/points"] {
            for (ext, bytes) in super::super::shapefile_export::build_components_crs(
                &[point(116.4, "原件")],
                "EPSG:4326",
            )
            .unwrap()
            {
                let name = format!("{stem}.{ext}");
                writer
                    .start_file(&name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(&bytes).unwrap();
                entries.insert(name, bytes);
            }
        }
        writer
            .start_file("readme.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"unrelated member").unwrap();
        entries.insert("readme.txt".into(), b"unrelated member".to_vec());
        fs::write(path, writer.finish().unwrap().into_inner()).unwrap();
        entries
    }

    #[test]
    fn zip_writeback_preserves_other_layers_and_unrelated_members() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("layers.zip");
        let original = multi_layer_zip(&path);
        let handles = Mutex::new(HashMap::new());
        let opened = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        save_source(
            &handles,
            &[point(117.0, "编辑")],
            Some(&opened[0].source_id),
            None,
            Some(&opened[0].source_hash),
            None,
            Some("folder/points"),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(fs::read(&path).unwrap())).unwrap();
        assert_eq!(archive.len(), original.len());
        assert_eq!(archive.comment(), b"archive metadata");
        for (name, bytes) in &original {
            if name.starts_with("folder/points.") {
                continue;
            }
            let mut actual = Vec::new();
            archive
                .by_name(name)
                .unwrap()
                .read_to_end(&mut actual)
                .unwrap();
            assert_eq!(&actual, bytes, "{name}");
        }
        let mut shapes = Vec::new();
        archive
            .by_name("folder/points.shp")
            .unwrap()
            .read_to_end(&mut shapes)
            .unwrap();
        let points = shapefile::ShapeReader::new(Cursor::new(shapes))
            .unwrap()
            .read()
            .unwrap();
        assert!(matches!(&points[0], shapefile::Shape::Point(p) if p.x == 117.0));
    }

    #[test]
    fn unsafe_or_missing_zip_selection_and_invalid_features_leave_source_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("layers.zip");
        multi_layer_zip(&path);
        let before = fs::read(&path).unwrap();
        let handles = Mutex::new(HashMap::new());
        let opened = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        for member in [None, Some("../points"), Some("missing/points")] {
            assert!(save_source(
                &handles,
                &[point(117.0, "编辑")],
                Some(&opened[0].source_id),
                None,
                Some(&opened[0].source_hash),
                None,
                member
            )
            .is_err());
            assert_eq!(fs::read(&path).unwrap(), before);
        }
        let bad = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[1,2,3]},"properties":{}});
        assert!(save_source(
            &handles,
            &[bad],
            Some(&opened[0].source_id),
            None,
            Some(&opened[0].source_hash),
            None,
            Some("folder/points")
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn deleting_all_features_preserves_field_schema_and_geometry_type() {
        let directory = tempfile::tempdir().unwrap();
        let path = source_group(directory.path());
        let handles = Mutex::new(HashMap::new());
        let opened = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        save_source(
            &handles,
            &[],
            Some(&opened[0].source_id),
            None,
            Some(&opened[0].source_hash),
            None,
            None,
        )
        .unwrap();
        let mut reader = shapefile::Reader::from_path(&path).unwrap();
        assert_eq!(reader.header().shape_type, shapefile::ShapeType::Point);
        assert!(reader.read().unwrap().is_empty());
        let dbf = shapefile::dbase::Reader::from_path(path.with_extension("dbf")).unwrap();
        assert_eq!(dbf.fields()[0].name(), "name");
    }

    #[test]
    fn duplicated_shp_working_copy_must_supply_its_own_unchanged_source_hash() {
        let directory = tempfile::tempdir().unwrap();
        let path = source_group(directory.path());
        let handles = Mutex::new(HashMap::new());
        let first = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        let second = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        save_source(
            &handles,
            &[point(117.0, "第一稿已保存")],
            Some(&first[0].source_id),
            None,
            Some(&first[0].source_hash),
            None,
            None,
        )
        .unwrap();
        let saved_bytes = snapshot(&path);
        assert!(save_source(
            &handles,
            &[point(118.0, "旧第二稿")],
            Some(&second[0].source_id),
            None,
            Some(&second[0].source_hash),
            None,
            None
        )
        .is_err());
        assert!(save_source(
            &handles,
            &[point(118.0, "无指纹")],
            Some(&second[0].source_id),
            None,
            None,
            None,
            None
        )
        .is_err());
        assert_eq!(snapshot(&path), saved_bytes);
    }

    #[test]
    fn duplicated_zip_member_rejects_stale_hash_but_other_member_accepts_current_archive_hash() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("layers.zip");
        multi_layer_zip(&path);
        let handles = Mutex::new(HashMap::new());
        let first = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        let second = super::super::read_selected_files(vec![path.clone()], &handles).unwrap();
        let saved = save_source(
            &handles,
            &[point(117.0, "已保存")],
            Some(&first[0].source_id),
            None,
            Some(&first[0].source_hash),
            None,
            Some("folder/points"),
        )
        .unwrap();
        let saved_bytes = fs::read(&path).unwrap();
        assert!(save_source(
            &handles,
            &[point(118.0, "旧同成员")],
            Some(&second[0].source_id),
            None,
            Some(&second[0].source_hash),
            None,
            Some("folder/points")
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), saved_bytes);
        save_source(
            &handles,
            &[point(119.0, "另一成员")],
            Some(&second[0].source_id),
            None,
            Some(&saved.source_hash),
            None,
            Some("another/points"),
        )
        .unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(fs::read(&path).unwrap())).unwrap();
        for (member, expected_x) in [("folder/points.shp", 117.0), ("another/points.shp", 119.0)] {
            let mut bytes = Vec::new();
            archive
                .by_name(member)
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            let shapes = shapefile::ShapeReader::new(Cursor::new(bytes))
                .unwrap()
                .read()
                .unwrap();
            assert!(matches!(&shapes[0], shapefile::Shape::Point(point) if point.x == expected_x));
        }
    }
}

fn replace_group(
    path: &Path,
    expected_hash: &[u8],
    components: &Components,
    mut publish: impl FnMut(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let originals = group_entries(path)?;
    let parent = path.parent().ok_or("来源目录无效")?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("来源文件名无效")?;
    let mut staged = Vec::new();
    let mut backups = Vec::new();
    let mut installed = Vec::new();
    let result = (|| {
        // 全部生成内容先落盘核验；此阶段的任何失败不移动来源组件。
        for (suffix, content) in components {
            let target = originals
                .iter()
                .find(|(ext, _)| ext == suffix)
                .map(|(_, p)| p.clone())
                .unwrap_or_else(|| parent.join(format!("{stem}.{suffix}")));
            let temp = parent.join(format!(".zgis-{}.tmp", uuid::Uuid::new_v4()));
            atomic_write_new(&temp, content)?;
            staged.push((temp, target));
        }
        if group_fingerprint(path)? != expected_hash {
            return Err("源文件组已被外部修改，请重新打开".into());
        }
        for (_, original) in &originals {
            let backup = parent.join(format!(".zgis-{}.backup", uuid::Uuid::new_v4()));
            move_file_new(original, &backup)?;
            backups.push((backup, original.clone()));
        }
        for (temp, target) in &staged {
            publish(temp, target)?;
            installed.push(target.clone());
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        for target in installed.iter().rev() {
            if let Err(err) = fs::remove_file(target) {
                rollback_errors.push(io_error(err));
            }
        }
        for (backup, original) in backups.iter().rev() {
            if let Err(err) = move_file_new(backup, original) {
                rollback_errors.push(err);
            }
        }
        for (temp, _) in &staged {
            let _ = fs::remove_file(temp);
        }
        if !rollback_errors.is_empty() {
            return Err(format!(
                "{error}；还原文件组失败，保留 .zgis-*.backup：{}",
                rollback_errors.join("；")
            ));
        }
        return Err(error);
    }
    for (backup, _) in backups {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn save_source(
    files: &Mutex<HashMap<String, FileHandle>>,
    features: &[Value],
    source_id: Option<&str>,
    source_path: Option<&str>,
    source_hash: Option<&str>,
    crs: Option<&str>,
    member: Option<&str>,
) -> Result<SavedFile, String> {
    super::bounded_json_size(&features, MAX_FILE as usize)?;
    let mut handles = files.lock().map_err(io_error)?;
    // 原生句柄可以共享同一个来源，但每个工作稿有独立的读入基线。
    // 其它工作稿的保存会刷新句柄，不能据此替当前工作稿接受新版本。
    let expected_hash = source_hash.ok_or("来源指纹缺失，请重新打开图层")?;
    let path = if let Some(handle) = source_id.and_then(|id| handles.get(id)) {
        handle.path.clone()
    } else {
        PathBuf::from(source_path.ok_or("文件句柄失效，请重新打开图层")?)
    };
    let path = fs::canonicalize(path).map_err(io_error)?;
    if !path.is_file()
        || path.components().any(|c| {
            c.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("_credentials")
        })
    {
        return Err("来源路径不可保存".into());
    }
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !["shp", "zip"].contains(&extension.as_str()) {
        return Err("此保存入口仅支持来源 SHP 或 ZIP".into());
    }
    let current = fingerprint(&path)?;
    if hash_text(&current) != expected_hash {
        return Err("源文件已被外部修改，请另存或重新打开".into());
    }
    if extension == "zip" {
        if fs::metadata(&path).map_err(io_error)?.len() > MAX_FILE {
            return Err("来源 ZIP 超过 100 MB".into());
        }
        let output = replace_zip(fs::read(&path).map_err(io_error)?, member, features, crs)?;
        if fingerprint(&path)? != current {
            return Err("源文件已被外部修改，请重新打开".into());
        }
        atomic_write(&path, &output)?;
    } else {
        let original = group_entries(&path)?
            .into_iter()
            .filter(|(ext, _)| CORE.contains(&ext.as_str()))
            .map(|(ext, p)| fs::read(p).map(|bytes| (ext, bytes)).map_err(io_error))
            .collect::<Result<HashMap<_, _>, _>>()?;
        let components = build_components(features, crs, &original)?;
        replace_group(&path, &current, &components, move_file_new)?;
    }
    let changed_group = if extension == "shp" {
        group_paths(&path)?
    } else {
        vec![path.clone()]
    };
    // 同一文件/文件组可能被多个图层共享；本次受控保存刷新它们的原生句柄。
    for handle in handles.values_mut() {
        if changed_group.contains(&handle.path) {
            handle.hash = fingerprint(&handle.path)?;
        }
    }
    let id = source_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let hash = fingerprint(&path)?;
    handles.insert(
        id.clone(),
        FileHandle {
            path: path.clone(),
            hash: hash.clone(),
        },
    );
    Ok(SavedFile {
        source_id: id,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
        source_hash: hash_text(&hash),
    })
}
