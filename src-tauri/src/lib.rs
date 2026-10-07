use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use tokio_postgres::{Client, NoTls};
mod shapefile_export;
mod spatial;
mod gis_mcp;
mod mcp_credentials;
mod vector_files;
mod preferences;
mod codex_agent;
mod basemap_preview;

#[tauri::command]
async fn export_shapefile(
    state: State<'_, Backend>,
    features: Vec<Value>,
    suggested_name: String,
    crs: Option<String>,
) -> Result<Option<SavedFile>, String> {
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let stem = Path::new(&suggested_name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let stem = if stem.is_empty() {
            "layer".to_string()
        } else {
            stem
        };
        let bytes = shapefile_export::build_zip_crs(&features, &stem, crs.as_deref().unwrap_or("EPSG:4326"))?;
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Shapefile ZIP", &["zip"])
            .set_file_name(format!("{stem}.zip"))
            .save_file()
        else {
            return Ok(None);
        };
        if !path
            .extension()
            .is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case("zip"))
        {
            return Err("SHP 另存仅允许 ZIP 文件；不会覆盖原 SHP 文件组".into());
        }
        let handles = files.lock().map_err(io_error)?;
        let target = fs::canonicalize(&path).ok();
        if handles.values().any(|h| {
            h.path == path
                || target
                    .as_ref()
                    .is_some_and(|t| fs::canonicalize(&h.path).ok().as_ref() == Some(t))
        }) {
            return Err("目标是已打开的来源文件，请选择新的 ZIP 文件名".into());
        }
        atomic_write_new(&path, &bytes)?;
        let id = uuid::Uuid::new_v4().to_string();
        Ok(Some(SavedFile {
            source_id: id,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            path: path.to_string_lossy().into(),
        }))
    })
    .await
    .map_err(io_error)?
}

const MAX_FILE: u64 = 100 * 1024 * 1024;
#[derive(Default)]
pub struct Backend {
    files: Arc<Mutex<HashMap<String, FileHandle>>>,
    databases: AsyncMutex<HashMap<String, Client>>,
}
struct FileHandle {
    path: PathBuf,
    hash: Vec<u8>,
}
fn fingerprint(path: &Path) -> Result<Vec<u8>, String> {
    Ok(Sha256::digest(fs::read(path).map_err(|e| e.to_string())?).to_vec())
}
fn ident(s: &str) -> Result<String, String> {
    if s.is_empty() || s.contains('\0') {
        return Err("无效 SQL 标识".into());
    }
    Ok(format!("\"{}\"", s.replace('"', "\"\"")))
}
fn table_sql(schema: &str, table: &str) -> Result<String, String> {
    Ok(format!("{}.{}", ident(schema)?, ident(table)?))
}
fn io_error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFile {
    name: String,
    bytes: Vec<u8>,
    source_id: String,
}
#[tauri::command]
async fn open_files(state: State<'_, Backend>) -> Result<Vec<OpenFile>, String> {
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || open_files_blocking(&files))
        .await
        .map_err(io_error)?
}
fn shapefile_group(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    let mut result = paths.clone();
    for path in paths {
        if path
            .extension()
            .is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("shp"))
        {
            let parent = path.parent().ok_or("来源目录无效")?;
            let stem = path.file_stem().unwrap_or_default().to_string_lossy();
            for entry in fs::read_dir(parent).map_err(io_error)? {
                let sibling = entry.map_err(io_error)?.path();
                if sibling.is_file()
                    && sibling
                        .file_stem()
                        .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(&stem))
                    && sibling.extension().is_some_and(|e| {
                        ["dbf", "prj", "cpg", "shx"]
                            .contains(&e.to_string_lossy().to_ascii_lowercase().as_str())
                    })
                    && !result.contains(&sibling)
                {
                    result.push(sibling);
                }
            }
        }
    }
    Ok(result)
}
fn open_files_blocking(
    files: &Mutex<HashMap<String, FileHandle>>,
) -> Result<Vec<OpenFile>, String> {
    let paths = rfd::FileDialog::new()
        .add_filter(
            "GIS",
            &[
                "geojson", "json", "csv", "shp", "shx", "dbf", "prj", "cpg", "zip",
            ],
        )
        .pick_files()
        .unwrap_or_default();
    read_selected_files(paths, files)
}
// Paths come only from a native dialog or the window's OS drag/drop callback.
fn read_selected_files(
    paths: Vec<PathBuf>,
    files: &Mutex<HashMap<String, FileHandle>>,
) -> Result<Vec<OpenFile>, String> {
    if paths.len() > 100 { return Err("每次最多导入 100 个文件".into()); }
    let mut unique = Vec::new();
    for path in paths {
        let path = fs::canonicalize(path).map_err(io_error)?;
        if !path.is_file() { return Err("请拖入矢量文件，不支持目录".into()); }
        if path.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("_credentials")) {
            return Err("不能导入凭据目录中的文件".into());
        }
        let extension = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        if !["geojson", "json", "csv", "shp", "shx", "dbf", "prj", "cpg", "zip"].contains(&extension.as_str()) {
            return Err("仅支持 GeoJSON、CSV、SHP 文件组和 ZIP".into());
        }
        if !unique.contains(&path) { unique.push(path); }
    }
    let mut out = Vec::new();
    let mut pending = Vec::new();
    let mut total = 0u64;
    for path in shapefile_group(unique)? {
        let size = fs::metadata(&path).map_err(io_error)?.len();
        total = total.checked_add(size).ok_or("文件过大")?;
        if size > MAX_FILE || total > MAX_FILE {
            return Err("单次导入文件总大小不能超过 100 MB".into());
        }
        let bytes = fs::read(&path).map_err(io_error)?;
        if bytes.len() as u64 > MAX_FILE || bytes.len() as u64 > size {
            return Err("读取时文件发生变化，请重试".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        pending.push((id.clone(), FileHandle { path: path.clone(), hash: Sha256::digest(&bytes).to_vec() }));
        out.push(OpenFile {
            name: path.file_name().unwrap_or_default().to_string_lossy().into(),
            bytes,
            source_id: id,
        });
    }
    files.lock().map_err(io_error)?.extend(pending);
    Ok(out)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DroppedFiles {
    files: Vec<OpenFile>,
    error: Option<String>,
}
fn handle_drop(window: &tauri::Window, paths: Vec<PathBuf>) {
    let handles = window.state::<Backend>().files.clone();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || read_selected_files(paths, &handles)).await;
        let payload = match result {
            Ok(Ok(files)) => DroppedFiles { files, error: None },
            Ok(Err(error)) => DroppedFiles { files: vec![], error: Some(error) },
            Err(error) => DroppedFiles { files: vec![], error: Some(io_error(error)) },
        };
        let _ = window.emit("gis-files-dropped", payload);
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedFile {
    source_id: String,
    name: String,
    path: String,
}
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_file_name(format!(".zgis-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(io_error)?;
        file.write_all(content).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        if fs::read(&temp).map_err(io_error)? != content {
            return Err("写入核验失败".into());
        }
        replace_file(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
/// Publish a new export without replacing an existing file, including races after the dialog.
fn atomic_write_new(path: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if path.exists() {
        return Err("SHP 另存必须使用新 ZIP 文件名，不能覆盖已有文件".into());
    }
    let temp = path.with_file_name(format!(".zgis-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(io_error)?;
        file.write_all(content).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        if fs::read(&temp).map_err(io_error)? != content {
            return Err("写入核验失败".into());
        }
        publish_new(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    result
}
fn publish_new(temp: &Path, path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // No MOVEFILE_REPLACE_EXISTING: a target created after validation must survive.
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                0,
            )
        };
        if result == 0 {
            return Err(format!(
                "新文件保存失败（目标可能已存在）：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(windows))]
    fs::hard_link(&temp, path).map_err(|e| format!("新文件保存失败（目标可能已存在）：{e}"))?;
    Ok(())
}
#[cfg(windows)]
fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    if !path.exists() {
        return fs::rename(temp, path).map_err(io_error);
    }
    let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
            target.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    fs::rename(temp, path).map_err(io_error)
}
#[tauri::command]
fn save_file(
    state: State<Backend>,
    source_id: Option<String>,
    suggested_name: String,
    content: String,
    overwrite: bool,
) -> Result<Option<SavedFile>, String> {
    if content.len() as u64 > MAX_FILE {
        return Err("输出超过 100 MB".into());
    }
    let mut handles = state.files.lock().map_err(io_error)?;
    let path = if overwrite {
        let handle = handles
            .get(source_id.as_deref().unwrap_or(""))
            .ok_or("文件句柄失效")?;
        if fingerprint(&handle.path)? != handle.hash {
            return Err("源文件已被外部修改，请另存或重新打开".into());
        }
        handle.path.clone()
    } else {
        let selection = rfd::FileDialog::new()
            .set_file_name(
                Path::new(&suggested_name)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
            )
            .save_file();
        match selection {
            Some(path) => path,
            None => return Ok(None),
        }
    };
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !["csv", "geojson", "json"].contains(&extension.as_str()) {
        return Err("只允许保存 CSV、GeoJSON 或 JSON；SHP 文件组只读".into());
    }
    atomic_write(&path, content.as_bytes())?;
    let id = source_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    handles.insert(
        id.clone(),
        FileHandle {
            path: path.clone(),
            hash: fingerprint(&path)?,
        },
    );
    Ok(Some(SavedFile {
        source_id: id,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        path: path.to_string_lossy().into(),
    }))
}
#[tauri::command]
fn save_recovery(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let _: Value = serde_json::from_str(&content).map_err(io_error)?;
    if content.len() as u64 > MAX_FILE {
        return Err("恢复数据过大".into());
    }
    let dir = app.path().app_local_data_dir().map_err(io_error)?;
    fs::create_dir_all(&dir).map_err(io_error)?;
    atomic_write(&dir.join("recovery.json"), content.as_bytes())
}
#[tauri::command]
fn load_recovery(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(io_error)?
        .join("recovery.json");
    if !path.exists() {
        return Ok(None);
    }
    if fs::metadata(&path).map_err(io_error)?.len() > MAX_FILE {
        return Err("恢复数据过大".into());
    }
    Ok(Some(fs::read_to_string(path).map_err(io_error)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionConfig {
    host: String,
    port: u16,
    database: String,
    user: String,
    password: String,
    ssl_mode: String,
}
#[tauri::command]
async fn connect_database(
    state: State<'_, Backend>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&config.host)
        .port(config.port)
        .dbname(&config.database)
        .user(&config.user)
        .password(&config.password)
        .connect_timeout(Duration::from_secs(10));
    let client = match config.ssl_mode.as_str() {
        "disable" => {
            let (c, connection) = cfg
                .connect(NoTls)
                .await
                .map_err(|_| "数据库连接失败，请检查连接参数".to_string())?;
            tauri::async_runtime::spawn(async move {
                let _ = connection.await;
            });
            c
        }
        "require" | "prefer" => {
            cfg.ssl_mode(tokio_postgres::config::SslMode::Require);
            let tls = postgres_native_tls::MakeTlsConnector::new(
                native_tls::TlsConnector::new().map_err(io_error)?,
            );
            let (c, connection) = cfg
                .connect(tls)
                .await
                .map_err(|_| "TLS 数据库连接失败，请检查连接参数与受信证书".to_string())?;
            tauri::async_runtime::spawn(async move {
                let _ = connection.await;
            });
            c
        }
        _ => return Err("sslMode 必须为 disable、require 或 prefer".into()),
    };
    client
        .batch_execute("SET statement_timeout='30s'; SET lock_timeout='5s'")
        .await
        .map_err(io_error)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut databases = state.databases.lock().await;
    if databases.len() >= 8 {
        return Err("连接数量已达上限，请断开不用的连接".into());
    }
    databases.insert(id.clone(), client);
    Ok(id)
}
#[tauri::command]
async fn disconnect_database(
    state: State<'_, Backend>,
    connection_id: String,
) -> Result<(), String> {
    state.databases.lock().await.remove(&connection_id);
    Ok(())
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Column {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
    nullable: bool,
    #[serde(default)]
    generated: bool,
    #[serde(default)]
    has_default: bool,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Layer {
    schema: String,
    table: String,
    geometry_column: String,
    geometry_kind: String,
    srid: i32,
    key_columns: Vec<String>,
    columns: Vec<Column>,
}
async fn discover(client: &Client) -> Result<Vec<Layer>, String> {
    let rows=client.query("SELECT table_schema,table_name,column_name,data_type,is_nullable,(is_identity='YES' OR is_generated<>'NEVER'),(column_default IS NOT NULL) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY ordinal_position",&[]).await.map_err(io_error)?;
    let mut tables: HashMap<(String, String), Vec<Column>> = HashMap::new();
    for r in rows {
        tables
            .entry((r.get(0), r.get(1)))
            .or_default()
            .push(Column {
                name: r.get(2),
                data_type: r.get(3),
                nullable: r.get::<_, String>(4) == "YES",
                generated: r.get(5),
                has_default: r.get(6),
            });
    }
    let keys=client.query("SELECT tc.table_schema,tc.table_name,kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema AND tc.table_name=kcu.table_name WHERE tc.constraint_type='PRIMARY KEY' ORDER BY kcu.ordinal_position",&[]).await.map_err(io_error)?;
    let mut keymap: HashMap<(String, String), Vec<String>> = HashMap::new();
    for r in keys {
        keymap
            .entry((r.get(0), r.get(1)))
            .or_default()
            .push(r.get(2));
    }
    let geom = client
        .query(
            "SELECT f_table_schema,f_table_name,f_geometry_column,srid FROM geometry_columns",
            &[],
        )
        .await
        .map_err(|_| "PostGIS geometry_columns 不可读取，请确认扩展和权限".to_string())?;
    let mut out = Vec::new();
    for r in geom {
        let schema: String = r.get(0);
        let table: String = r.get(1);
        out.push(Layer {
            columns: tables
                .get(&(schema.clone(), table.clone()))
                .cloned()
                .unwrap_or_default(),
            key_columns: keymap
                .get(&(schema.clone(), table.clone()))
                .cloned()
                .unwrap_or_default(),
            schema,
            table,
            geometry_column: r.get(2),
            geometry_kind: "geometry".into(),
            srid: r.get(3),
        });
    }
    for ((schema, table), columns) in tables {
        for column in &columns {
            if ["text", "character varying", "character"].contains(&column.data_type.as_str()) {
                out.push(Layer {
                    schema: schema.clone(),
                    table: table.clone(),
                    geometry_column: column.name.clone(),
                    geometry_kind: "wkt".into(),
                    srid: 4326,
                    key_columns: keymap
                        .get(&(schema.clone(), table.clone()))
                        .cloned()
                        .unwrap_or_default(),
                    columns: columns.clone(),
                });
            }
        }
    }
    Ok(out)
}
#[tauri::command]
async fn discover_layers(
    state: State<'_, Backend>,
    connection_id: String,
) -> Result<Vec<Layer>, String> {
    let db = state.databases.lock().await;
    discover(db.get(&connection_id).ok_or("连接已失效")?).await
}
async fn validated(client: &Client, requested: &Layer) -> Result<Layer, String> {
    let mut layer = discover(client)
        .await?
        .into_iter()
        .find(|l| {
            l.schema == requested.schema
                && l.table == requested.table
                && l.geometry_column == requested.geometry_column
                && l.geometry_kind == requested.geometry_kind
        })
        .ok_or("数据源字段已变化或不受支持")?;
    if layer.geometry_kind == "wkt" {
        layer.srid = requested.srid;
    }
    if layer.srid < 0 {
        return Err("需要明确且有效的 SRID".into());
    }
    Ok(layer)
}
fn effective_srid(layer: &Layer) -> i32 { if layer.srid == 0 { 4326 } else { layer.srid } }
fn geometry_expr(layer: &Layer) -> Result<String, String> {
    let col = ident(&layer.geometry_column)?;
    Ok(if layer.geometry_kind == "geometry" {
        if layer.srid == 0 { format!("CASE WHEN ST_SRID({col})=0 THEN ST_SetSRID({col},4326) ELSE {col} END") } else { col }
    } else {
        format!("ST_GeomFromText(NULLIF({col},''),{})", effective_srid(layer))
    })
}
fn record_expr(layer: &Layer) -> Result<String, String> {
    if layer.columns.is_empty() {
        return Ok("'{}'::jsonb".into());
    }
    let keys = layer
        .columns
        .iter()
        .map(|c| format!("'{}'", c.name.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let values = layer
        .columns
        .iter()
        .map(|c| Ok(format!("{}::text", ident(&c.name)?)))
        .collect::<Result<Vec<_>, String>>()?
        .join(",");
    Ok(format!(
        "jsonb_object(ARRAY[{keys}]::text[],ARRAY[{values}]::text[])"
    ))
}
#[tauri::command]
async fn query_layer(
    state: State<'_, Backend>,
    connection_id: String,
    schema: String,
    table: String,
    geometry_column: String,
    geometry_kind: String,
    srid: Option<i32>,
    limit: i64,
    bbox: Option<Vec<f64>>,
) -> Result<Value, String> {
    let db = state.databases.lock().await;
    let client = db.get(&connection_id).ok_or("连接已失效")?;
    let layer = validated(
        client,
        &Layer {
            schema,
            table,
            geometry_column,
            geometry_kind,
            srid: srid.unwrap_or(4326),
            key_columns: vec![],
            columns: vec![],
        },
    )
    .await?;
    let count = limit.clamp(1, 100000);
    let geom = geometry_expr(&layer)?;
    let bbox = validate_bbox(bbox)?;
    let filter = if bbox.is_some() && layer.geometry_kind == "geometry" {
        if layer.srid == 0 {
            format!(" WHERE ST_Transform(({geom}),4326) && ST_MakeEnvelope($2,$3,$4,$5,4326)")
        } else {
            format!(" WHERE {geom} && ST_Transform(ST_MakeEnvelope($2,$3,$4,$5,4326),{})", layer.srid)
        }
    } else {
        String::new()
    };
    let ordering = order_by(&layer)?;
    let sql = format!(
        "SELECT {}, ST_AsGeoJSON(ST_Transform(({geom}),4326))::jsonb FROM {}{filter}{ordering} LIMIT $1",
        record_expr(&layer)?,
        table_sql(&layer.schema, &layer.table)?
    );
    let take = count + 1;
    let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&take];
    if layer.geometry_kind == "geometry" {
        if let Some(b) = &bbox {
            for n in b {
                params.push(n);
            }
        }
    }
    let rows = tokio::time::timeout(Duration::from_secs(30), client.query(&sql, &params))
        .await
        .map_err(|_| "查询超时，请缩小数据范围")?
        .map_err(|_| "读取失败，请检查 WKT、SRID 和几何类型".to_string())?;
    let truncated = rows.len() > count as usize;
    let mut features = Vec::new();
    for (index, row) in rows.into_iter().take(count as usize).enumerate() {
        let baseline: Value = row.get(0);
        let mut properties = baseline.clone();
        properties
            .as_object_mut()
            .unwrap()
            .remove(&layer.geometry_column);
        let key: serde_json::Map<String, Value> = layer
            .key_columns
            .iter()
            .map(|k| (k.clone(), baseline[k].clone()))
            .collect();
        let id = if key.is_empty() {
            index.to_string()
        } else {
            Value::Object(key.clone()).to_string()
        };
        features.push(json!({"id":id,"geometry":row.get::<_,Option<Value>>(1),"properties":properties,"dbKey":key,"baseline":baseline}));
    }
    Ok(json!({"features":features,"srid":effective_srid(&layer),"truncated":truncated}))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    kind: String,
    #[serde(default)]
    db_key: Value,
    #[serde(default)]
    baseline: Value,
    #[serde(default)]
    geometry: Option<Value>,
    #[serde(default)]
    properties: Value,
    #[serde(default)]
    geometry_changed: Option<bool>,
}
fn validate_bbox(bbox: Option<Vec<f64>>) -> Result<Option<Vec<f64>>, String> {
    if let Some(b) = &bbox {
        if b.len() != 4
            || !b.iter().all(|n| n.is_finite())
            || b[0] >= b[2]
            || b[1] >= b[3]
            || b[0] < -180.
            || b[2] > 180.
            || b[1] < -90.
            || b[3] > 90.
        {
            return Err("bbox 需要有效 WGS84 [west,south,east,north] 边界".into());
        }
    }
    Ok(bbox)
}
fn order_by(layer: &Layer) -> Result<String, String> {
    if layer.key_columns.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!(
            " ORDER BY {}",
            layer
                .key_columns
                .iter()
                .map(|k| ident(k))
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        ))
    }
}
fn key_where(layer: &Layer) -> Result<String, String> {
    if layer.key_columns.is_empty() {
        return Err("没有稳定主键，仅支持只读".into());
    }
    Ok(layer
        .key_columns
        .iter()
        .map(|k| {
            Ok(format!(
                "{}::text IS NOT DISTINCT FROM ($1::jsonb ->> '{}')",
                ident(k)?,
                k.replace('\'', "''")
            ))
        })
        .collect::<Result<Vec<_>, String>>()?
        .join(" AND "))
}
fn baseline_matches(current: &Value, baseline: &Value) -> bool {
    current == baseline
}
fn validate_geometry(geometry: &Option<Value>) -> Result<(), String> {
    fn positions(value: &Value) -> bool {
        match value.as_array() {
            Some(a) if a.first().is_some_and(Value::is_number) => {
                [2, 3].contains(&a.len()) && a.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
            }
            Some(a) => !a.is_empty() && a.iter().all(positions),
            None => false,
        }
    }
    if let Some(g) = geometry {
        if g.is_null() {
            return Ok(());
        }
        let kind = g.get("type").and_then(Value::as_str).unwrap_or("");
        if ![
            "Point",
            "MultiPoint",
            "LineString",
            "MultiLineString",
            "Polygon",
            "MultiPolygon",
        ]
        .contains(&kind)
            || !g.get("coordinates").is_some_and(positions)
        {
            return Err(
                "仅支持有限二维或XYZ坐标的基础几何；M/ZM、空几何或 GeometryCollection 不可写入".into(),
            );
        }
    }
    Ok(())
}
#[tauri::command]
async fn commit_changes(
    state: State<'_, Backend>,
    connection_id: String,
    layer: Layer,
    changes: Vec<Change>,
) -> Result<Value, String> {
    if changes.len() > 10000 {
        return Err("单次提交最多 10000 条".into());
    }
    let mut db = state.databases.lock().await;
    let client = db.get_mut(&connection_id).ok_or("连接已失效")?;
    let layer = validated(client, &layer).await?;
    let target = table_sql(&layer.schema, &layer.table)?;
    let where_clause = key_where(&layer)?;
    let tx = client.transaction().await.map_err(io_error)?;
    tx.batch_execute("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'")
        .await
        .map_err(io_error)?;
    for change in &changes {
        let geometry_changed = change.kind == "insert" || change.geometry_changed.unwrap_or(true);
        if change.kind != "delete" && geometry_changed {
            validate_geometry(&change.geometry)?;
            let geometry = change
                .geometry
                .as_ref()
                .filter(|v| !v.is_null())
                .map(Value::to_string);
            let row = tx
                .query_one(
                    "SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326))",
                    &[&geometry],
                )
                .await
                .map_err(|_| "几何解析失败，提交已回滚")?;
            if row.get::<_, Option<bool>>(0) == Some(false) {
                return Err("几何拓扑无效，提交已回滚".into());
            }
        }
        if !["insert", "update", "delete"].contains(&change.kind.as_str()) {
            return Err("未知变更类型".into());
        }
        if change.kind != "insert" {
            if layer
                .key_columns
                .iter()
                .any(|k| change.db_key.get(k).is_none() || change.db_key[k].is_null())
            {
                return Err("变更缺少有效主键".into());
            }
            let sql = format!(
                "SELECT {} FROM {target} WHERE {where_clause} FOR UPDATE",
                record_expr(&layer)?
            );
            let rows = tx.query(&sql, &[&change.db_key]).await.map_err(io_error)?;
            if rows.len() != 1 || !baseline_matches(&rows[0].get::<_, Value>(0), &change.baseline) {
                return Err("记录已被其他操作修改或删除，提交已回滚".into());
            }
        }
        if change.kind == "delete" {
            tx.execute(
                &format!("DELETE FROM {target} WHERE {where_clause}"),
                &[&change.db_key],
            )
            .await
            .map_err(io_error)?;
            continue;
        }
        let props = change.properties.as_object().ok_or("属性必须为对象")?;
        let mut columns = Vec::new();
        let mut expressions = Vec::new();
        let mut normalized = serde_json::Map::new();
        for (name, value) in props {
            if name == &layer.geometry_column {
                continue;
            }
            let col = layer
                .columns
                .iter()
                .find(|c| &c.name == name)
                .ok_or("属性字段不属于发现的表")?;
            if col.generated {
                if change.kind == "update" && change.baseline.get(name) != Some(value) {
                    return Err("不能修改自动生成字段".into());
                }
                continue;
            }
            if change.kind == "update" && change.baseline.get(name) == Some(value) {
                continue;
            }
            if value.is_null() && !col.nullable {
                return Err(format!("字段 {name} 不允许 NULL"));
            }
            if change.kind == "insert" && value.is_null() && col.has_default {
                continue;
            }
            if col.data_type == "USER-DEFINED" {
                return Err("不支持编辑自定义字段类型".into());
            }
            columns.push(ident(name)?);
            expressions.push(format!(
                "(jsonb_populate_record(NULL::{target},$2::jsonb)).{}",
                ident(name)?
            ));
            let normalized_value =
                if ["json", "jsonb"].contains(&col.data_type.as_str()) && !value.is_null() {
                    match value.as_str() {
                        Some(text) => serde_json::from_str(text)
                            .map_err(|_| format!("字段 {name} 需要合法 JSON"))?,
                        None => value.clone(),
                    }
                } else {
                    value.clone()
                };
            normalized.insert(name.clone(), normalized_value);
        }
        if geometry_changed {
            columns.push(ident(&layer.geometry_column)?);
            let geo = if layer.geometry_kind == "geometry" {
                format!(
                    "ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($3::text),4326),{})",
                    effective_srid(&layer)
                )
            } else {
                format!(
                    "ST_AsText(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($3::text),4326),{}))",
                    effective_srid(&layer)
                )
            };
            expressions.push(geo);
        }
        if columns.is_empty() {
            continue;
        }
        let geometry = change
            .geometry
            .as_ref()
            .filter(|v| !v.is_null())
            .map(Value::to_string);
        let properties = Value::Object(normalized);
        let sql = if change.kind == "insert" {
            format!(
                "WITH input AS (SELECT $1::jsonb,$2::jsonb,$3::text) INSERT INTO {target} ({}) SELECT {}",
                columns.join(","),
                expressions.join(",")
            )
        } else {
            format!(
                "WITH input AS (SELECT $1::jsonb,$2::jsonb,$3::text) UPDATE {target} SET {} WHERE {where_clause}",
                columns
                    .iter()
                    .zip(&expressions)
                    .map(|(c, e)| format!("{c}={e}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        let affected = tx
            .execute(&sql, &[&change.db_key, &properties, &geometry])
            .await
            .map_err(io_error)?;
        if affected != 1 {
            return Err("提交行数异常，已回滚".into());
        }
    }
    tx.commit().await.map_err(|_| {
        "提交结果待核对：连接在事务完成时异常，请重新读取数据库，不要直接重复提交".to_string()
    })?;
    Ok(json!({"committed":changes.len(),"reloadRequired":true}))
}
#[tauri::command]
async fn export_database(
    state: State<'_, Backend>,
    connection_id: String,
    schema: String,
    table: String,
    features: Value,
    new_table: bool,
) -> Result<Value, String> {
    if !new_table {
        return Err("首版导入只支持创建新表，不覆盖或追加现有表".into());
    }
    let list = features
        .get("features")
        .and_then(Value::as_array)
        .or_else(|| features.as_array())
        .ok_or("需要 GeoJSON FeatureCollection")?;
    if list.len() > 100000 {
        return Err("单次导入最多 100000 条".into());
    }
    let target = table_sql(&schema, &table)?;
    let mut db = state.databases.lock().await;
    let client = db.get_mut(&connection_id).ok_or("连接已失效")?;
    let tx = client.transaction().await.map_err(io_error)?;
    tx.batch_execute("SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'")
        .await
        .map_err(io_error)?;
    fn dimensions(v: &Value, dims: &mut std::collections::BTreeSet<usize>) {
        if let Some(a) = v.as_array() {
            if a.first().is_some_and(Value::is_number) { dims.insert(a.len()); }
            else { for child in a { dimensions(child, dims); } }
        }
    }
    let mut dims = std::collections::BTreeSet::new();
    for f in list { dimensions(&f["geometry"]["coordinates"], &mut dims); }
    if dims.len() > 1 { return Err("新表不支持混合二维与XYZ几何，请分图层导出".into()); }
    let geometry_type = if dims.contains(&3) { "GeometryZ" } else { "Geometry" };
    tx.batch_execute(&format!("CREATE TABLE {target} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, properties jsonb NOT NULL, geom geometry({geometry_type},4326))")).await.map_err(io_error)?;
    for f in list {
        let props = f.get("properties").cloned().unwrap_or(json!({}));
        let geometry = f
            .get("geometry")
            .filter(|v| !v.is_null())
            .map(Value::to_string);
        validate_geometry(&f.get("geometry").filter(|v| !v.is_null()).cloned())?;
        let row = tx
            .query_one(
                "SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326))",
                &[&geometry],
            )
            .await
            .map_err(|_| "几何解析失败，导入已回滚")?;
        if row.get::<_, Option<bool>>(0) == Some(false) {
            return Err("几何拓扑无效，导入已回滚".into());
        }
        tx.execute(&format!("INSERT INTO {target}(properties,geom) VALUES ($1,ST_SetSRID(ST_GeomFromGeoJSON($2::text),4326))"),&[&props,&geometry]).await.map_err(io_error)?;
    }
    tx.commit()
        .await
        .map_err(|_| "提交结果待核对：请确认目标表是否已创建，不要直接重复导入".to_string())?;
    Ok(json!({"inserted":list.len(),"schema":schema,"table":table}))
}

pub fn run() {
    tauri::Builder::default()
        .manage(Backend::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                handle_drop(window, paths.clone());
            }
        })
        .manage(gis_mcp::GisMcp::default())
        .manage(codex_agent::CodexAgent::default())
        .setup(|app| {
            // 完成启动尝试后再显示前端；失败详情由设置页状态呈现，不阻止地图工作区。
            let mcp = app.state::<gis_mcp::GisMcp>().inner().clone();
            let _ = tauri::async_runtime::block_on(mcp.enable());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            gis_mcp::gis_mcp_status,
            gis_mcp::gis_mcp_tool_catalog,
            gis_mcp::gis_mcp_set_enabled,
            gis_mcp::gis_workspace_sync,
            gis_mcp::gis_results_drain,
            gis_mcp::gis_mcp_audit,
            codex_agent::agent_open,
            codex_agent::agent_current,
            codex_agent::agent_read,
            codex_agent::agent_write,
            codex_agent::agent_resize,
            codex_agent::agent_close,
            export_shapefile,
            open_files,
            save_file,
            save_recovery,
            load_recovery,
            preferences::load_preferences,
            preferences::save_preferences,
            basemap_preview::fetch_basemap_tile,
            connect_database,
            disconnect_database,
            discover_layers,
            query_layer,
            commit_changes,
            export_database
        ])
        .build(tauri::generate_context!())
        .expect("zGIS 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<codex_agent::CodexAgent>().shutdown();
                app.state::<gis_mcp::GisMcp>().shutdown();
            }
        });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_files_register_deduplicated_native_sources() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.geojson");
        fs::write(&path, b"{}").unwrap();
        let handles = Mutex::new(HashMap::new());
        let opened = read_selected_files(vec![path.clone(), path.clone()], &handles).unwrap();
        assert_eq!(opened.len(), 1);
        let registered = handles.lock().unwrap();
        assert_eq!(registered[&opened[0].source_id].path, fs::canonicalize(path).unwrap());
        assert_eq!(registered[&opened[0].source_id].hash, Sha256::digest(b"{}").to_vec());
    }
    #[test]
    fn selected_files_failure_does_not_register_partial_batch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.geojson");
        fs::write(&path, b"{}").unwrap();
        let bad = dir.path().join("a.exe"); fs::write(&bad, b"x").unwrap();
        let handles = Mutex::new(HashMap::new());
        assert!(read_selected_files(vec![path, bad], &handles).is_err());
        assert!(read_selected_files(vec![dir.path().to_path_buf()], &handles).is_err());
        let credentials = dir.path().join("_credentials"); fs::create_dir(&credentials).unwrap();
        let secret = credentials.join("private.json"); fs::write(&secret, b"{}").unwrap();
        assert!(read_selected_files(vec![secret], &handles).is_err());
        assert!(handles.lock().unwrap().is_empty());
    }
    #[test]
    fn selected_shp_includes_companions_once() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.shp", "a.dbf", "a.prj", "b.dbf"] { fs::write(dir.path().join(name), b"x").unwrap(); }
        let handles = Mutex::new(HashMap::new());
        let files = read_selected_files(vec![dir.path().join("a.shp"), dir.path().join("a.dbf")], &handles).unwrap();
        assert_eq!(files.len(), 3);
        assert!(!files.iter().any(|f| f.name == "b.dbf"));
    }
    #[test]
    fn changes_accept_kind_specific_payloads() {
        let insert: Change = serde_json::from_value(
            json!({"kind":"insert","geometry":null,"properties":{"name":"new"}}),
        )
        .unwrap();
        assert!(insert.db_key.is_null());
        let delete: Change = serde_json::from_value(
            json!({"kind":"delete","dbKey":{"id":"1"},"baseline":{"id":"1"}}),
        )
        .unwrap();
        assert!(delete.properties.is_null());
        assert!(delete.geometry.is_none());
    }
    #[test]
    fn shapefile_only_adds_same_stem_companions() {
        let dir = tempfile::tempdir().unwrap();
        for file in ["a.SHP", "a.dbf", "a.PRJ", "b.dbf", "a.txt"] {
            fs::write(dir.path().join(file), b"x").unwrap();
        }
        let group = shapefile_group(vec![dir.path().join("a.SHP")]).unwrap();
        assert_eq!(group.len(), 3);
        assert!(!group.contains(&dir.path().join("b.dbf")));
        assert!(!group.contains(&dir.path().join("a.txt")));
    }
    #[test]
    fn bbox_validates_range_and_order() {
        assert!(validate_bbox(Some(vec![-180., -90., 180., 90.])).is_ok());
        assert!(validate_bbox(Some(vec![5., 1., 2., 4.])).is_err());
        assert!(validate_bbox(Some(vec![1., 2., f64::NAN, 4.])).is_err());
        assert!(validate_bbox(Some(vec![1., 2., 181., 4.])).is_err());
    }
    #[test]
    fn geometry_rejects_extra_dimensions() {
        assert!(validate_geometry(&Some(json!({"type":"Point","coordinates":[1,2]}))).is_ok());
        assert!(validate_geometry(&Some(json!({"type":"Point","coordinates":[1,2,3]}))).is_ok());
        assert!(validate_geometry(&Some(json!({"type":"Point","coordinates":[1,2,3,4]}))).is_err());
        assert!(
            validate_geometry(&Some(json!({"type":"GeometryCollection","geometries":[]}))).is_err()
        );
    }
    #[test]
    fn identifiers_are_quoted() {
        assert_eq!(
            ident("a\";DROP TABLE x;--").unwrap(),
            "\"a\"\";DROP TABLE x;--\""
        );
        assert!(ident("\0").is_err());
    }
    #[test]
    fn baseline_detects_conflicts() {
        assert!(baseline_matches(&json!({"id":"1"}), &json!({"id":"1"})));
        assert!(!baseline_matches(
            &json!({"id":"1","x":"2"}),
            &json!({"id":"1","x":"3"})
        ));
    }
    #[test]
    fn atomic_save_and_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("数据.csv");
        atomic_write(&path, b"old").unwrap();
        let first = fingerprint(&path).unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_ne!(first, fingerprint(&path).unwrap());
        assert_eq!(fs::read(path).unwrap(), b"new");
    }
    #[test]
    fn new_export_never_replaces_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.zip");
        atomic_write_new(&path, b"original").unwrap();
        assert!(atomic_write_new(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn publish_rejects_target_created_after_validation() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("pending.tmp");
        let target = dir.path().join("new.zip");
        assert!(!target.exists());
        fs::write(&temp, b"new").unwrap();
        fs::write(&target, b"created-by-another-process").unwrap();
        assert!(publish_new(&temp, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"created-by-another-process");
        assert_eq!(fs::read(&temp).unwrap(), b"new");
    }
    #[test]
    fn missing_key_is_readonly() {
        let layer = Layer {
            schema: "s".into(),
            table: "t".into(),
            geometry_column: "g".into(),
            geometry_kind: "geometry".into(),
            srid: 4326,
            key_columns: vec![],
            columns: vec![],
        };
        assert!(key_where(&layer).is_err());
    }
    #[test]
    fn unspecified_geometry_and_wkt_use_4326_without_relabeling_known_srid() {
        let mut layer = Layer {
            schema: "s".into(), table: "t".into(), geometry_column: "g".into(),
            geometry_kind: "geometry".into(), srid: 0, key_columns: vec![], columns: vec![],
        };
        assert_eq!(effective_srid(&layer), 4326);
        assert_eq!(geometry_expr(&layer).unwrap(), "CASE WHEN ST_SRID(\"g\")=0 THEN ST_SetSRID(\"g\",4326) ELSE \"g\" END");
        for srid in [4326, 4490, 3857] {
            layer.srid = srid;
            assert_eq!(effective_srid(&layer), srid);
            assert_eq!(geometry_expr(&layer).unwrap(), "\"g\"");
            layer.geometry_kind = "wkt".into();
            assert_eq!(geometry_expr(&layer).unwrap(), format!("ST_GeomFromText(NULLIF(\"g\",''),{srid})"));
            layer.geometry_kind = "geometry".into();
        }
    }
}
