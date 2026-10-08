use super::{atomic_write, Change, Column, ConnectionConfig, Layer, SchemaChange};
use mysql_async::{prelude::Queryable, Conn, OptsBuilder, Row, SslOpts, TxOpts};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::Duration,
};
use tauri::{Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct MysqlBackend {
    clients: Mutex<HashMap<String, Conn>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MysqlSource {
    id: String,
    name: String,
    host: String,
    port: u16,
    database: String,
    user: String,
    ssl_mode: String,
}
fn validate_sources(sources: &[MysqlSource]) -> Result<(), String> {
    if sources.len() > 64 {
        return Err("数据源数量超过上限（64）".into());
    }
    let mut ids = HashSet::new();
    for source in sources {
        for value in [
            &source.id,
            &source.name,
            &source.host,
            &source.database,
            &source.user,
        ] {
            if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
                return Err("数据源包含空字段、过长字段或控制字符".into());
            }
        }
        if source.port == 0 || !["disable", "prefer", "require"].contains(&source.ssl_mode.as_str())
        {
            return Err("数据源端口或 SSL 模式无效".into());
        }
        if !ids.insert(&source.id) {
            return Err("数据源 ID 重复".into());
        }
    }
    Ok(())
}
#[tauri::command]
pub fn save_mysql_sources(app: tauri::AppHandle, sources: Vec<MysqlSource>) -> Result<(), String> {
    validate_sources(&sources)?;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "配置目录不可用")?;
    std::fs::create_dir_all(&dir).map_err(|_| "配置目录不可写")?;
    atomic_write(
        &dir.join("mysql-sources.json"),
        &serde_json::to_vec(&sources).map_err(|_| "数据源配置无效")?,
    )
}
#[tauri::command]
pub fn load_mysql_sources(app: tauri::AppHandle) -> Result<Vec<MysqlSource>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "配置目录不可用")?
        .join("mysql-sources.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    if std::fs::metadata(&path).map_err(|_| "配置不可读")?.len() > 256 * 1024 {
        return Err("数据源配置过大".into());
    }
    let sources: Vec<MysqlSource> =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "配置不可读")?)
            .map_err(|_| "数据源配置无效")?;
    validate_sources(&sources)?;
    Ok(sources)
}
#[tauri::command]
pub async fn connect_mysql_database(
    state: State<'_, MysqlBackend>,
    config: ConnectionConfig,
) -> Result<String, String> {
    let source = MysqlSource {
        id: "connection".into(),
        name: "connection".into(),
        host: config.host.clone(),
        port: config.port,
        database: config.database.clone(),
        user: config.user.clone(),
        ssl_mode: config.ssl_mode.clone(),
    };
    validate_sources(&[source])?;
    let ssl = match config.ssl_mode.as_str() {
        "disable" => None,
        "require" | "prefer" => Some(SslOpts::default()),
        _ => return Err("SSL 模式无效".into()),
    };
    let opts = OptsBuilder::default()
        .ip_or_hostname(config.host)
        .tcp_port(config.port)
        .db_name(Some(config.database))
        .user(Some(config.user))
        .pass(Some(config.password))
        .ssl_opts(ssl)
        .prefer_socket(false)
        .max_allowed_packet(Some(4 * 1024 * 1024));
    let connection = tokio::time::timeout(Duration::from_secs(10), Conn::new(opts))
        .await
        .map_err(|_| "Mysql 连接超时")?
        .map_err(|_| "Mysql 连接失败，请检查参数、权限与受信证书")?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut clients = state.clients.lock().await;
    if clients.len() >= 8 {
        return Err("连接数量已达上限，请断开不用的连接".into());
    }
    clients.insert(id.clone(), connection);
    Ok(id)
}
#[tauri::command]
pub async fn disconnect_mysql_database(
    state: State<'_, MysqlBackend>,
    connection_id: String,
) -> Result<(), String> {
    if let Some(conn) = state.clients.lock().await.remove(&connection_id) {
        let _ = tokio::time::timeout(Duration::from_secs(3), conn.disconnect()).await;
    }
    Ok(())
}
#[derive(Serialize)]
struct GeometryColumn {
    name: String,
    srid: i32,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseTable {
    schema: String,
    table: String,
    columns: Vec<Column>,
    key_columns: Vec<String>,
    geometry_columns: Vec<GeometryColumn>,
}
#[derive(Serialize)]
pub struct Catalog {
    schemas: Vec<String>,
    tables: Vec<DatabaseTable>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    columns: Vec<Column>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

fn text(row: &Row, index: usize) -> Result<String, String> {
    row.get_opt::<String, _>(index)
        .ok_or("目录字段缺失")?
        .map_err(|_| "目录字段转换失败".into())
}
fn ident(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("表或字段名称无效".into());
    }
    Ok(format!("`{}`", value.replace('`', "``")))
}
fn geometry_type(kind: &str) -> bool {
    [
        "geometry",
        "point",
        "linestring",
        "polygon",
        "multipoint",
        "multilinestring",
        "multipolygon",
        "geometrycollection",
    ]
    .contains(&kind)
}
async fn catalog<Q: Queryable>(conn: &mut Q) -> Result<Catalog, String> {
    let rows:Vec<Row>=conn.query("SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,COLUMN_DEFAULT IS NOT NULL,DATA_TYPE,COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION LIMIT 100001").await.map_err(|_|"读取 Mysql 表目录失败")?;
    if rows.len() > 100000 {
        return Err("表目录过大，请限制可访问的表".into());
    }
    let mut tables = BTreeMap::<(String, String), DatabaseTable>::new();
    for row in rows {
        let schema = text(&row, 0)?;
        let table = text(&row, 1)?;
        let name = text(&row, 2)?;
        let kind = text(&row, 7)?;
        let t = tables
            .entry((schema.clone(), table.clone()))
            .or_insert_with(|| DatabaseTable {
                schema,
                table,
                columns: vec![],
                key_columns: vec![],
                geometry_columns: vec![],
            });
        if geometry_type(&kind) {
            t.geometry_columns.push(GeometryColumn {
                name: name.clone(),
                srid: 0,
                kind: kind.clone(),
            });
        }
        if text(&row, 8)? == "PRI" {
            t.key_columns.push(name.clone());
        }
        let extra = text(&row, 5)?.to_uppercase();
        t.columns.push(Column {
            name,
            data_type: text(&row, 3)?,
            nullable: text(&row, 4)? == "YES",
            generated: extra.contains("VIRTUAL GENERATED")
                || extra.contains("STORED GENERATED")
                || extra.contains("AUTO_INCREMENT"),
            has_default: row.get::<u8, _>(6).unwrap_or(0) != 0,
        });
    }
    // MySQL 8 提供声明的 SRID；5.7 无此目录，保留未知 SRID，加载时逐条核验。
    let geometries:Result<Vec<Row>,_>=conn.query("SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,SRS_ID FROM information_schema.ST_GEOMETRY_COLUMNS WHERE TABLE_SCHEMA=DATABASE() LIMIT 100001").await;
    if let Ok(rows) = geometries {
        for row in rows {
            if let Some(t) = tables.get_mut(&(text(&row, 0)?, text(&row, 1)?)) {
                if let Some(g) = t
                    .geometry_columns
                    .iter_mut()
                    .find(|g| g.name == row.get::<String, _>(2).unwrap_or_default())
                {
                    g.srid = row.get::<Option<i32>, _>(3).flatten().unwrap_or(0);
                }
            }
        }
    }
    Ok(Catalog {
        schemas: vec![],
        tables: tables.into_values().collect(),
    })
}
#[tauri::command]
pub async fn discover_mysql_tables(
    state: State<'_, MysqlBackend>,
    connection_id: String,
) -> Result<Catalog, String> {
    let mut clients = state.clients.lock().await;
    let conn = clients.get_mut(&connection_id).ok_or("连接已失效")?;
    match tokio::time::timeout(Duration::from_secs(15), catalog(conn)).await {
        Ok(result) => result,
        Err(_) => {
            clients.remove(&connection_id);
            Err("读取目录超时，连接已断开".into())
        }
    }
}
fn preview_expressions(table: &DatabaseTable) -> Result<Vec<String>, String> {
    if table.columns.len() > 128 {
        return Err("表字段超过 128 列，暂不支持预览".into());
    }
    table.columns.iter().map(|c| {
        let col=ident(&c.name)?;
        let kind=c.data_type.to_ascii_lowercase();
        if table.geometry_columns.iter().any(|g|g.name==c.name) { return Ok(format!("CASE WHEN {col} IS NULL THEN NULL ELSE '[几何字段]' END")); }
        if kind=="json" { return Ok(format!("CASE WHEN {col} IS NULL THEN NULL ELSE '[复杂字段，未读取]' END")); }
        if kind.contains("blob")||kind.starts_with("binary")||kind.starts_with("varbinary")||kind.starts_with("bit") { return Ok(format!("CASE WHEN {col} IS NULL THEN NULL ELSE '[二进制字段，未读取]' END")); }
        Ok(format!("CASE WHEN {col} IS NULL THEN NULL WHEN OCTET_LENGTH({col})>4096 THEN '[大字段，未读取]' ELSE LEFT(CAST({col} AS CHAR),1024) END"))
    }).collect()
}
fn preview_sql(table: &DatabaseTable, limit: u32) -> Result<String, String> {
    if ![10, 20].contains(&limit) {
        return Err("预览条数仅支持 10 或 20".into());
    }
    Ok(format!(
        "SELECT {} FROM {}.{} LIMIT {}",
        preview_expressions(table)?.join(","),
        ident(&table.schema)?,
        ident(&table.table)?,
        limit + 1
    ))
}
const MAX_ATTRIBUTE_BYTES: usize = 64 * 1024;

// 地图工作副本必须保留完整属性；预览用的摘要和截断不能用于导出数据。
fn load_expressions(table: &DatabaseTable) -> Result<Vec<String>, String> {
    if table.columns.len() > 128 {
        return Err("表字段超过 128 列，暂不支持空间加载".into());
    }
    let mut expressions = Vec::with_capacity(table.columns.len() * 2);
    for column in &table.columns {
        if table.geometry_columns.iter().any(|g| g.name == column.name) {
            expressions.extend(["NULL".to_string(), "0".to_string()]);
            continue;
        }
        let kind = column.data_type.to_ascii_lowercase();
        if kind.contains("blob")
            || kind.starts_with("binary")
            || kind.starts_with("varbinary")
            || kind.starts_with("bit")
        {
            return Err(format!(
                "字段“{}”为二进制类型，无法无损加载到 GeoJSON；请先转换该字段",
                column.name
            ));
        }
        let quoted = ident(&column.name)?;
        // JSON 和高精度数值均保留完整文本；额外标志区分真实 NULL 与过大字段。
        expressions.push(format!("CASE WHEN OCTET_LENGTH({quoted})>{MAX_ATTRIBUTE_BYTES} THEN NULL ELSE CAST({quoted} AS CHAR CHARACTER SET utf8mb4) END"));
        expressions.push(format!(
            "COALESCE(OCTET_LENGTH({quoted})>{MAX_ATTRIBUTE_BYTES},0)"
        ));
    }
    Ok(expressions)
}

fn attribute_value(name: &str, value: Option<String>, oversized: bool) -> Result<Value, String> {
    if oversized
        || value
            .as_ref()
            .is_some_and(|text| text.len() > MAX_ATTRIBUTE_BYTES)
    {
        return Err(format!(
            "字段“{name}”超过 64 KiB，未加载；请减少字段体积后重试"
        ));
    }
    Ok(value.map(Value::String).unwrap_or(Value::Null))
}
async fn selected_table(
    conn: &mut Conn,
    schema: &str,
    table: &str,
) -> Result<DatabaseTable, String> {
    catalog(conn)
        .await?
        .tables
        .into_iter()
        .find(|t| t.schema == schema && t.table == table)
        .ok_or("表不存在或没有访问权限".into())
}
fn validate_geometry_srid(actual: i32, requested: Option<i32>) -> Result<(), String> {
    if actual == 4326 || (actual == 0 && requested == Some(4326)) {
        return Ok(());
    }
    Err(if actual == 0 {
        "几何 SRID 未指定，请明确使用 WGS84（EPSG:4326）后加载".into()
    } else {
        format!("暂不支持 Mysql EPSG:{actual} 空间加载，请先转换为 EPSG:4326")
    })
}
type RecordValues = BTreeMap<String, Option<String>>;
fn scalar_column(column: &Column) -> bool {
    let kind = column.data_type.to_ascii_lowercase();
    let base = kind.split(['(', ' ']).next().unwrap_or("");
    [
        "tinyint",
        "smallint",
        "mediumint",
        "int",
        "integer",
        "bigint",
        "decimal",
        "numeric",
        "float",
        "double",
        "real",
        "date",
        "datetime",
        "timestamp",
        "time",
        "year",
        "char",
        "varchar",
        "tinytext",
        "text",
        "mediumtext",
        "longtext",
        "enum",
        "set",
        "json",
    ]
    .contains(&base)
}
fn record_columns(table: &DatabaseTable) -> Result<Vec<&Column>, String> {
    if table.columns.len() > 128 {
        return Err("表字段超过 128 列，暂不支持记录编辑".into());
    }
    if table.key_columns.is_empty()
        || table.key_columns.iter().any(|key| {
            !table
                .columns
                .iter()
                .any(|c| c.name == *key && scalar_column(c))
        })
    {
        return Err("记录编辑需要可读取的标量主键".into());
    }
    Ok(table.columns.iter().filter(|c| scalar_column(c)).collect())
}
#[cfg(test)]
fn editable_columns(table: &DatabaseTable) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|c| scalar_column(c) && !c.generated && !table.key_columns.contains(&c.name))
        .map(|c| c.name.clone())
        .collect()
}
fn checked_values(values: &RecordValues) -> Result<(), String> {
    if values.len() > 128
        || values
            .values()
            .flatten()
            .any(|value| value.len() > MAX_ATTRIBUTE_BYTES)
        || serde_json::to_vec(values)
            .map_err(|_| "记录序列化失败")?
            .len()
            > 1024 * 1024
    {
        return Err("记录字段超过 64 KiB 或记录超过 1 MiB".into());
    }
    Ok(())
}
fn validate_key(table: &DatabaseTable, key: &RecordValues) -> Result<(), String> {
    record_columns(table)?;
    checked_values(key)?;
    if key.len() != table.key_columns.len()
        || table
            .key_columns
            .iter()
            .any(|name| key.get(name).is_none_or(Option::is_none))
    {
        return Err("主键必须完整且不能为 NULL".into());
    }
    Ok(())
}
async fn is_transactional<Q: Queryable>(
    client: &mut Q,
    table: &DatabaseTable,
) -> Result<bool, String> {
    let engine: Option<String> = client
        .exec_first(
            "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?",
            (&table.schema, &table.table),
        )
        .await
        .map_err(|_| "读取表事务能力失败")?;
    Ok(engine.as_deref() == Some("InnoDB"))
}
#[cfg(test)]
fn record_sql(table: &DatabaseTable, locked: bool) -> Result<String, String> {
    let expressions=record_columns(table)?.iter().flat_map(|c| {
        let column=ident(&c.name);
        match column { Ok(col)=>vec![Ok(format!("CASE WHEN OCTET_LENGTH({col})>{MAX_ATTRIBUTE_BYTES} THEN NULL ELSE CAST({col} AS CHAR CHARACTER SET utf8mb4) END")),Ok(format!("COALESCE(OCTET_LENGTH({col})>{MAX_ATTRIBUTE_BYTES},0)"))],Err(error)=>vec![Err(error)] }
    }).collect::<Result<Vec<_>,String>>()?;
    let predicate = table
        .key_columns
        .iter()
        .map(|k| ident(k).map(|name| format!("{name} = ?")))
        .collect::<Result<Vec<_>, _>>()?
        .join(" AND ");
    Ok(format!(
        "SELECT {} FROM {}.{} WHERE {} LIMIT 2{}",
        expressions.join(","),
        ident(&table.schema)?,
        ident(&table.table)?,
        predicate,
        if locked { " FOR UPDATE" } else { "" }
    ))
}
#[cfg(test)]
fn validate_update(
    table: &DatabaseTable,
    baseline: &RecordValues,
    changes: &RecordValues,
) -> Result<RecordValues, String> {
    checked_values(baseline)?;
    checked_values(changes)?;
    let columns = record_columns(table)?;
    if baseline.len() != columns.len() || columns.iter().any(|c| !baseline.contains_key(&c.name)) {
        return Err("原始记录基线不完整，请重新读取记录".into());
    }
    let editable = editable_columns(table);
    if changes.is_empty()
        || changes.iter().any(|(name, value)| {
            !editable.contains(name)
                || (value.is_none() && table.columns.iter().any(|c| c.name == *name && !c.nullable))
        })
    {
        return Err("只能修改可编辑字段，非空字段不能设为 NULL".into());
    }
    for (name, value) in changes {
        if table
            .columns
            .iter()
            .any(|c| c.name == *name && c.data_type.eq_ignore_ascii_case("json"))
        {
            if let Some(value) = value {
                serde_json::from_str::<Value>(value)
                    .map_err(|_| format!("字段“{name}”不是有效 JSON"))?;
            }
        }
    }
    let key = table
        .key_columns
        .iter()
        .map(|name| (name.clone(), baseline[name].clone()))
        .collect();
    validate_key(table, &key)?;
    Ok(key)
}
#[cfg(test)]
fn update_sql(table: &DatabaseTable, changes: &RecordValues) -> Result<String, String> {
    let sets = changes
        .keys()
        .map(|name| ident(name).map(|name| format!("{name} = ?")))
        .collect::<Result<Vec<_>, _>>()?
        .join(",");
    let predicate = table
        .key_columns
        .iter()
        .map(|name| ident(name).map(|name| format!("{name} = ?")))
        .collect::<Result<Vec<_>, _>>()?
        .join(" AND ");
    Ok(format!(
        "UPDATE {}.{} SET {sets} WHERE {predicate} LIMIT 1",
        ident(&table.schema)?,
        ident(&table.table)?
    ))
}
fn snapshot_expressions(table: &DatabaseTable) -> Result<Vec<String>, String> {
    let mut result = vec![];
    if table.columns.len() > 128 {
        return Err("表字段超过 128 列".into());
    }
    for c in &table.columns {
        let name = ident(&c.name)?;
        let geometric = table.geometry_columns.iter().any(|g| g.name == c.name);
        if !geometric && !scalar_column(c) {
            return Err(format!("字段“{}”不支持无损编辑", c.name));
        }
        let cap = if geometric {
            1024 * 1024
        } else {
            MAX_ATTRIBUTE_BYTES
        };
        let value = if geometric {
            format!("HEX({name})")
        } else {
            format!("CAST({name} AS CHAR CHARACTER SET utf8mb4)")
        };
        result.push(format!(
            "CASE WHEN OCTET_LENGTH({name})>{cap} THEN NULL ELSE {value} END"
        ));
        result.push(format!("COALESCE(OCTET_LENGTH({name})>{cap},0)"));
    }
    Ok(result)
}
fn snapshot_values(
    table: &DatabaseTable,
    row: &Row,
    offset: usize,
) -> Result<RecordValues, String> {
    let mut values = RecordValues::new();
    for (i, col) in table.columns.iter().enumerate() {
        if row
            .get_opt::<u8, _>(offset + i * 2 + 1)
            .ok_or("字段大小标志缺失")?
            .map_err(|_| "字段大小转换失败")?
            != 0
        {
            return Err(format!("字段“{}”超过读取体积限制", col.name));
        }
        let value = row
            .get_opt::<Option<String>, _>(offset + i * 2)
            .ok_or("字段缺失")?
            .map_err(|_| "字段转换失败")?;
        values.insert(col.name.clone(), value);
    }
    if serde_json::to_vec(&values)
        .map_err(|_| "记录序列化失败")?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("记录基线超过16 MiB".into());
    }
    Ok(values)
}
fn values_from_json(value: &Value) -> Result<RecordValues, String> {
    let object = value.as_object().ok_or("主键和基线必须为对象")?;
    object
        .iter()
        .map(|(name, value)| {
            let text = if value.is_null() {
                None
            } else {
                Some(
                    value
                        .as_str()
                        .ok_or("基线必须保留原始字符串或 NULL")?
                        .to_string(),
                )
            };
            Ok((name.clone(), text))
        })
        .collect()
}
fn baseline_complete(table: &DatabaseTable, baseline: &RecordValues) -> Result<(), String> {
    if baseline.len() != table.columns.len()
        || table
            .columns
            .iter()
            .any(|c| !baseline.contains_key(&c.name))
        || serde_json::to_vec(baseline).map_err(|_| "基线无效")?.len() > 16 * 1024 * 1024
    {
        return Err("原始基线不完整或过大，请重新读取图层".into());
    }
    Ok(())
}
fn geometry_expression(table: &DatabaseTable, layer: &Layer) -> Result<String, String> {
    let column = table
        .columns
        .iter()
        .find(|c| c.name == layer.geometry_column)
        .ok_or("几何字段不存在")?;
    let quoted = ident(&column.name)?;
    match layer.geometry_kind.as_str() {
        "geometry"
            if table
                .geometry_columns
                .iter()
                .any(|c| c.name == layer.geometry_column) =>
        {
            Ok(quoted)
        }
        "wkt"
            if scalar_column(column)
                && [
                    "char",
                    "varchar",
                    "tinytext",
                    "text",
                    "mediumtext",
                    "longtext",
                ]
                .contains(
                    &column
                        .data_type
                        .to_ascii_lowercase()
                        .split('(')
                        .next()
                        .unwrap_or(""),
                )
                && layer.srid == 4326 =>
        {
            Ok(format!("ST_GeomFromText(NULLIF({quoted},''),0)"))
        }
        _ => Err("只支持 geometry 或 WGS84 文本 WKT 字段".into()),
    }
}
async fn locked_snapshot<Q: Queryable>(
    client: &mut Q,
    table: &DatabaseTable,
    key: &RecordValues,
) -> Result<RecordValues, String> {
    validate_key(table, key)?;
    let predicate = precise_key_predicate(table)?;
    let sql = format!(
        "SELECT {} FROM {}.{} WHERE {predicate} LIMIT 2 FOR UPDATE",
        snapshot_expressions(table)?.join(","),
        ident(&table.schema)?,
        ident(&table.table)?
    );
    let rows: Vec<Row> = client
        .exec(
            sql,
            table
                .key_columns
                .iter()
                .flat_map(|name| [key[name].clone(), key[name].clone()])
                .collect::<Vec<_>>(),
        )
        .await
        .map_err(|_| "锁定记录失败，请检查权限")?;
    if rows.len() != 1 {
        return Err("记录已被其他操作删除或主键不唯一，提交已回滚".into());
    }
    let current = snapshot_values(table, &rows[0], 0)?;
    if table
        .key_columns
        .iter()
        .any(|name| current.get(name) != key.get(name))
    {
        return Err("记录主键不完整或已变化".into());
    }
    Ok(current)
}
fn validate_mysql_geometry(geometry: &Option<Value>) -> Result<(), String> {
    super::validate_geometry(geometry)?;
    fn xy(value: &Value) -> bool {
        match value.as_array() {
            Some(a) if a.first().is_some_and(Value::is_number) => {
                a.len() == 2
                    && a[0].as_f64().is_some_and(|n| (-180.0..=180.0).contains(&n))
                    && a[1].as_f64().is_some_and(|n| (-90.0..=90.0).contains(&n))
            }
            Some(a) => !a.is_empty() && a.iter().all(xy),
            None => false,
        }
    }
    if geometry
        .as_ref()
        .filter(|g| !g.is_null())
        .is_some_and(|g| !g.get("coordinates").is_some_and(xy))
    {
        return Err("Mysql 仅支持 WGS84 二维坐标，XYZ 或超范围坐标不可写入".into());
    }
    Ok(())
}
fn raw_geometry_srid(hex: &str) -> Result<i32, String> {
    if hex.len() < 8 {
        return Err("原始几何基线缺少 SRID".into());
    }
    let mut bytes = [0u8; 4];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(i * 2..i * 2 + 2).ok_or("原始几何基线无效")?, 16)
            .map_err(|_| "原始几何基线无效")?;
    }
    let srid = u32::from_le_bytes(bytes);
    if srid != 0 && srid != 4326 {
        return Err("暂不支持非0/4326坐标系写回".into());
    }
    Ok(srid as i32)
}
fn property_text(column: &Column, value: &Value) -> Result<Option<String>, String> {
    let text = if value.is_null() {
        None
    } else if column.data_type.eq_ignore_ascii_case("json") {
        Some(match value.as_str() {
            Some(s) => {
                serde_json::from_str::<Value>(s)
                    .map_err(|_| format!("字段“{}”需要有效 JSON", column.name))?;
                s.to_string()
            }
            None => value.to_string(),
        })
    } else if let Some(s) = value.as_str() {
        Some(s.to_string())
    } else if value.is_number() {
        Some(value.to_string())
    } else if let Some(b) = value.as_bool() {
        Some(if b { "1" } else { "0" }.into())
    } else {
        return Err("普通字段只能写入标量值".into());
    };
    if text.as_ref().is_some_and(|s| s.len() > MAX_ATTRIBUTE_BYTES) {
        return Err("属性字段超过64 KiB，提交已回滚".into());
    }
    Ok(text)
}
fn changed_properties(
    table: &DatabaseTable,
    layer: &Layer,
    change: &Change,
    baseline: &RecordValues,
) -> Result<RecordValues, String> {
    let props = change.properties.as_object().ok_or("属性必须为对象")?;
    let mut changed = RecordValues::new();
    for (name, value) in props {
        if name == &layer.geometry_column {
            return Err("几何/WKT字段必须通过几何编辑写回".into());
        }
        let col = table
            .columns
            .iter()
            .find(|c| c.name == *name)
            .ok_or("属性字段不属于来源表")?;
        if !scalar_column(col) {
            return Err("不支持直接编辑几何、二进制或自定义属性字段".into());
        }
        let value = property_text(col, value)?;
        if change.kind == "update" && baseline.get(name) == Some(&value) {
            continue;
        }
        if col.generated {
            if change.kind == "insert" {
                continue;
            }
            return Err("不能修改自动生成字段".into());
        }
        if change.kind == "update" && table.key_columns.contains(name) {
            return Err("不能修改稳定主键字段".into());
        }
        if change.kind == "insert" && value.is_none() && col.has_default {
            continue;
        }
        if value.is_none() && !col.nullable {
            return Err(format!("字段“{name}”不允许NULL"));
        }
        changed.insert(name.clone(), value);
    }
    Ok(changed)
}
fn insert_required(
    table: &DatabaseTable,
    layer: &Layer,
    properties: &RecordValues,
    geometry: &Option<Value>,
) -> Result<(), String> {
    for col in &table.columns {
        if col.generated || col.has_default || col.nullable {
            continue;
        }
        if col.name == layer.geometry_column {
            if geometry.as_ref().is_none_or(Value::is_null) {
                return Err("几何字段不允许NULL".into());
            }
        } else if properties.get(&col.name).is_none_or(Option::is_none) {
            return Err(format!("新增记录缺少必填字段“{}”", col.name));
        }
    }
    Ok(())
}
fn precise_key_predicate(table: &DatabaseTable) -> Result<String, String> {
    table.key_columns.iter().map(|key|ident(key).map(|name|format!("({name} = ? AND CAST(CAST({name} AS CHAR CHARACTER SET utf8mb4) AS BINARY) = CAST(? AS BINARY))"))).collect::<Result<Vec<_>,_>>().map(|parts|parts.join(" AND "))
}
fn commit_sql(
    table: &DatabaseTable,
    kind: &str,
    columns: &[String],
    expressions: &[String],
) -> Result<String, String> {
    let target = format!("{}.{}", ident(&table.schema)?, ident(&table.table)?);
    let predicate = precise_key_predicate(table)?;
    if kind != "insert" && table.key_columns.is_empty() {
        return Err("没有稳定主键，仅支持只读".into());
    }
    if kind != "delete" && (columns.is_empty() || columns.len() != expressions.len()) {
        return Err("写入字段表达式无效".into());
    }
    match kind {
        "insert" => Ok(format!(
            "INSERT INTO {target} ({}) VALUES ({})",
            columns.join(","),
            expressions.join(",")
        )),
        "update" => Ok(format!(
            "UPDATE {target} SET {} WHERE {predicate} LIMIT 1",
            columns
                .iter()
                .zip(expressions)
                .map(|(column, expr)| format!("{column}={expr}"))
                .collect::<Vec<_>>()
                .join(",")
        )),
        "delete" => Ok(format!("DELETE FROM {target} WHERE {predicate} LIMIT 1")),
        _ => Err("未知变更类型".into()),
    }
}
fn schema_plan(
    table: &DatabaseTable,
    layer: &Layer,
    changes: &[SchemaChange],
) -> Result<(DatabaseTable, String), String> {
    if changes.len() > 64 {
        return Err("单次最多64个字段变更".into());
    }
    let mut projected = table
        .columns
        .iter()
        .map(|c| (c.clone(), Some(c.name.clone())))
        .collect::<Vec<_>>();
    for change in changes {
        if change.name.chars().count() > 64 {
            return Err("字段名称超过64字符".into());
        }
        ident(&change.name)?;
        match change.kind.as_str() {
            "add" => {
                if projected
                    .iter()
                    .any(|(c, _)| c.name.eq_ignore_ascii_case(&change.name))
                {
                    return Err("新增字段名称已存在".into());
                }
                projected.push((
                    Column {
                        name: change.name.clone(),
                        data_type: "varchar(255)".into(),
                        nullable: true,
                        generated: false,
                        has_default: false,
                    },
                    None,
                ));
            }
            "rename" | "delete" => {
                let index = projected
                    .iter()
                    .position(|(c, _)| c.name == change.name)
                    .ok_or("字段已不存在")?;
                if let Some(original) = &projected[index].1 {
                    if projected[index].0.generated
                        || table.key_columns.contains(original)
                        || table.geometry_columns.iter().any(|g| g.name == *original)
                        || original == &layer.geometry_column
                    {
                        return Err("不能删除/重命名主键、几何/WKT或生成字段".into());
                    }
                }
                if change.kind == "delete" {
                    projected.remove(index);
                } else {
                    let new = change.new_name.as_deref().ok_or("新字段名称缺失")?;
                    ident(new)?;
                    if new.chars().count() > 64
                        || projected
                            .iter()
                            .enumerate()
                            .any(|(i, (c, _))| i != index && c.name.eq_ignore_ascii_case(new))
                    {
                        return Err("新字段名称已存在或超过64字符".into());
                    }
                    projected[index].0.name = new.into();
                }
            }
            _ => return Err("未知字段变更类型".into()),
        }
        if projected.len() > 128 {
            return Err("字段变更后超过128列".into());
        }
    }
    let mut clauses = vec![];
    for original in &table.columns {
        if !projected
            .iter()
            .any(|(_, source)| source.as_ref() == Some(&original.name))
        {
            clauses.push(format!("DROP COLUMN {}", ident(&original.name)?));
        }
    }
    for (column, source) in &projected {
        if let Some(original) = source {
            if &column.name != original {
                clauses.push(format!(
                    "RENAME COLUMN {} TO {}",
                    ident(original)?,
                    ident(&column.name)?
                ));
            }
        }
    }
    for (column, source) in &projected {
        if source.is_none() {
            clauses.push(format!(
                "ADD COLUMN {} VARCHAR(255) NULL",
                ident(&column.name)?
            ));
        }
    }
    let result = DatabaseTable {
        schema: table.schema.clone(),
        table: table.table.clone(),
        columns: projected.into_iter().map(|(c, _)| c).collect(),
        key_columns: table.key_columns.clone(),
        geometry_columns: table
            .geometry_columns
            .iter()
            .map(|g| GeometryColumn {
                name: g.name.clone(),
                srid: g.srid,
                kind: g.kind.clone(),
            })
            .collect(),
    };
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(
            "ALTER TABLE {}.{} {}",
            ident(&table.schema)?,
            ident(&table.table)?,
            clauses.join(",")
        )
    };
    Ok((result, sql))
}
fn remap_baseline(baseline: &RecordValues, changes: &[SchemaChange]) -> RecordValues {
    let mut mapped = baseline.clone();
    for change in changes {
        match change.kind.as_str() {
            "add" => {
                mapped.insert(change.name.clone(), None);
            }
            "rename" => {
                if let Some(value) = mapped.remove(&change.name) {
                    if let Some(new) = &change.new_name {
                        mapped.insert(new.clone(), value);
                    }
                }
            }
            "delete" => {
                mapped.remove(&change.name);
            }
            _ => {}
        }
    }
    mapped
}
async fn check_schema_dependencies(
    conn: &mut Conn,
    table: &DatabaseTable,
    changes: &[SchemaChange],
) -> Result<(), String> {
    let affected = changes
        .iter()
        .filter(|c| c.kind != "add")
        .map(|c| c.name.as_str())
        .collect::<HashSet<_>>();
    if affected.is_empty() {
        return Ok(());
    }
    let rows:Vec<Row>=conn.exec("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? UNION SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=? UNION SELECT REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME=?",(&table.schema,&table.table,&table.schema,&table.table,&table.schema,&table.table)).await.map_err(|_|"字段索引/约束依赖检查失败")?;
    if rows.iter().any(|row| {
        row.get::<String, _>(0)
            .is_some_and(|name| affected.contains(name.as_str()))
    }) {
        return Err("字段参与索引或外键，不能直接删除/重命名".into());
    }
    let dependency:Option<u64>=conn.exec_first("SELECT (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK')+(SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=? AND EVENT_OBJECT_TABLE=?)+(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND GENERATION_EXPRESSION<>'')+(SELECT COUNT(*) FROM information_schema.VIEW_TABLE_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME=?)",(&table.schema,&table.table,&table.schema,&table.table,&table.schema,&table.table,&table.schema,&table.table)).await.map_err(|_|"字段表达式/触发器/视图依赖检查失败")?;
    if dependency.unwrap_or(0) > 0 {
        return Err("来源表存在CHECK、触发器、生成表达式或视图依赖，需先处理依赖再修改字段".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn commit_mysql_changes(
    state: State<'_, MysqlBackend>,
    connection_id: String,
    layer: Layer,
    changes: Vec<Change>,
    schema_changes: Option<Vec<SchemaChange>>,
) -> Result<Value, String> {
    let schema_changes = schema_changes.unwrap_or_default();
    let mut schema_applied = false;
    if changes.len() > 10000
        || changes
            .iter()
            .map(|c| {
                c.properties.to_string().len()
                    + c.baseline.to_string().len()
                    + c.db_key.to_string().len()
                    + c.geometry
                        .as_ref()
                        .map(|g| g.to_string().len())
                        .unwrap_or(0)
            })
            .sum::<usize>()
            > 16 * 1024 * 1024
    {
        return Err("单次提交最多10000条且不超过16 MiB".into());
    }
    let mut clients = state.clients.lock().await;
    let conn = clients.get_mut(&connection_id).ok_or("连接已失效")?;
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        let mut table = selected_table(conn, &layer.schema, &layer.table).await?;
        geometry_expression(&table, &layer)?;
        record_columns(&table)?;
        snapshot_expressions(&table)?;
        if !is_transactional(conn, &table).await? {
            return Err("只支持事务型InnoDB图层写回".into());
        }
        conn.query_drop("SET SESSION innodb_lock_wait_timeout=5")
            .await
            .map_err(|_| "设置锁超时失败")?;
        conn.query_drop("SET SESSION sql_mode=CONCAT(@@SESSION.sql_mode,',STRICT_ALL_TABLES')")
            .await
            .map_err(|_| "开启严格转换失败")?;
        if !schema_changes.is_empty() {
            let major = conn.server_version().0;
            if !(8..10).contains(&major) {
                return Err("Mysql字段同步仅支持MySQL8/9的原子InnoDB ALTER，请先升级".into());
            }
            let (projected, sql) = schema_plan(&table, &layer, &schema_changes)?;
            snapshot_expressions(&projected)?;
            check_schema_dependencies(conn, &table, &schema_changes).await?;
            let mut preflight = conn
                .start_transaction(TxOpts::default())
                .await
                .map_err(|_| "字段变更预检事务失败")?;
            let check = async {
                for change in &changes {
                    if !["insert", "update", "delete"].contains(&change.kind.as_str()) {
                        return Err("未知变更类型".into());
                    }
                    let baseline = if change.kind == "insert" {
                        RecordValues::new()
                    } else {
                        let key = values_from_json(&change.db_key)?;
                        let original = values_from_json(&change.baseline)?;
                        baseline_complete(&table, &original)?;
                        if locked_snapshot(&mut preflight, &table, &key).await? != original {
                            return Err("记录已变化，字段变更尚未执行，请重新读图层".into());
                        }
                        remap_baseline(&original, &schema_changes)
                    };
                    if change.kind != "delete" {
                        let props = changed_properties(&projected, &layer, change, &baseline)?;
                        if change.kind == "insert" {
                            insert_required(&projected, &layer, &props, &change.geometry)?;
                        }
                        if change.kind == "insert" || change.geometry_changed.unwrap_or(true) {
                            validate_mysql_geometry(&change.geometry)?;
                        }
                    }
                }
                Ok::<(), String>(())
            }
            .await;
            preflight
                .rollback()
                .await
                .map_err(|_| "字段变更预检结束失败")?;
            check?;
            conn.query_drop("SET SESSION lock_wait_timeout=5")
                .await
                .map_err(|_| "设置字段锁超时失败")?;
            conn.query_drop(format!(
                "LOCK TABLES {}.{} WRITE",
                ident(&table.schema)?,
                ident(&table.table)?
            ))
            .await
            .map_err(|_| "字段同步需要LOCK TABLES与ALTER权限，来源表锁定失败")?;
            let ddl_result = async {
                let fresh = selected_table(conn, &table.schema, &table.table).await?;
                if serde_json::to_vec(&fresh).map_err(|_| "表结构核验失败")?
                    != serde_json::to_vec(&table).map_err(|_| "表结构核验失败")?
                    || !is_transactional(conn, &fresh).await?
                {
                    return Err("来源表结构或事务能力已变化，字段同步未执行，请重新读取图层".into());
                }
                check_schema_dependencies(conn, &fresh, &schema_changes).await?;
                for change in changes.iter().filter(|c| c.kind != "insert") {
                    let key = values_from_json(&change.db_key)?;
                    let original = values_from_json(&change.baseline)?;
                    baseline_complete(&fresh, &original)?;
                    if locked_snapshot(conn, &fresh, &key).await? != original {
                        return Err("记录在字段锁定前已变化，字段同步未执行，请重新读取图层".into());
                    }
                }
                if !sql.is_empty() {
                    conn.query_drop(sql).await.map_err(|_| {
                        "字段ALTER执行失败或结果待核对，请重新读取来源表；不要重复提交"
                    })?;
                    schema_applied = true;
                }
                Ok::<(), String>(())
            }
            .await;
            conn.query_drop("UNLOCK TABLES")
                .await
                .map_err(|_| "来源表解锁结果待核对，请断开并重新连接")?;
            ddl_result?;
            table = projected;
        }
        let mut tx = conn
            .start_transaction(TxOpts::default())
            .await
            .map_err(|_| "开启编辑事务失败")?;
        let operation = async {
            let target = format!("{}.{}", ident(&table.schema)?, ident(&table.table)?);
            tx.query_drop(format!("SELECT 1 FROM {target} LIMIT 0 FOR UPDATE"))
                .await
                .map_err(|_| "来源表事务锁定失败")?;
            let fresh = catalog(&mut tx)
                .await?
                .tables
                .into_iter()
                .find(|t| t.schema == table.schema && t.table == table.table)
                .ok_or("来源表已失效")?;
            if serde_json::to_vec(&fresh).map_err(|_| "表结构核验失败")?
                != serde_json::to_vec(&table).map_err(|_| "表结构核验失败")?
                || !is_transactional(&mut tx, &fresh).await?
            {
                return Err("来源表结构或事务能力已变化，请重新读取图层".into());
            }
            for change in &changes {
                if !["insert", "update", "delete"].contains(&change.kind.as_str()) {
                    return Err("未知变更类型".into());
                }
                let (key, baseline) = if change.kind == "insert" {
                    (RecordValues::new(), RecordValues::new())
                } else {
                    let key = values_from_json(&change.db_key)?;
                    let baseline =
                        remap_baseline(&values_from_json(&change.baseline)?, &schema_changes);
                    baseline_complete(&table, &baseline)?;
                    let current = locked_snapshot(&mut tx, &table, &key).await?;
                    if current != baseline {
                        return Err("记录已被其他操作修改或删除，整批提交已回滚".into());
                    }
                    (key, baseline)
                };
                // 锁定来源记录后再核验存储引擎，避免DDL替换为不可回滚表。
                if !is_transactional(&mut tx, &table).await? {
                    return Err("来源表事务能力已变化，提交已回滚".into());
                }
                let mut params = vec![];
                if change.kind == "delete" {
                    params.extend(table.key_columns.iter().flat_map(|name| {
                        [
                            mysql_async::Value::from(key[name].clone()),
                            mysql_async::Value::from(key[name].clone()),
                        ]
                    }));
                    tx.exec_drop(commit_sql(&table, "delete", &[], &[])?, params)
                        .await
                        .map_err(|_| "删除记录失败，整批已回滚")?;
                    if tx.affected_rows() != 1 || tx.get_warnings() > 0 {
                        return Err("删除记录数量异常，整批已回滚".into());
                    }
                    continue;
                }
                let props = changed_properties(&table, &layer, change, &baseline)?;
                if change.kind == "insert" {
                    insert_required(&table, &layer, &props, &change.geometry)?;
                }
                let use_geometry_default = change.kind == "insert"
                    && change.geometry.as_ref().is_none_or(Value::is_null)
                    && table
                        .columns
                        .iter()
                        .any(|c| c.name == layer.geometry_column && c.has_default);
                let geometry_changed = !use_geometry_default
                    && (change.kind == "insert" || change.geometry_changed.unwrap_or(true));
                let mut columns = props
                    .keys()
                    .map(|name| ident(name))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut expressions = props
                    .values()
                    .map(|value| {
                        params.push(mysql_async::Value::from(value.clone()));
                        "?".to_string()
                    })
                    .collect::<Vec<_>>();
                if geometry_changed {
                    if table
                        .columns
                        .iter()
                        .any(|c| c.name == layer.geometry_column && c.generated)
                    {
                        return Err("不能修改自动生成的几何/WKT字段".into());
                    }
                    validate_mysql_geometry(&change.geometry)?;
                    let geo = change
                        .geometry
                        .as_ref()
                        .filter(|g| !g.is_null())
                        .map(Value::to_string);
                    if geo.is_none()
                        && table
                            .columns
                            .iter()
                            .any(|c| c.name == layer.geometry_column && !c.nullable)
                    {
                        return Err("几何字段不允许NULL".into());
                    }
                    let actual_srid = if layer.geometry_kind == "wkt" {
                        0
                    } else if change.kind == "update" {
                        baseline
                            .get(&layer.geometry_column)
                            .and_then(Option::as_deref)
                            .map(raw_geometry_srid)
                            .transpose()?
                            .unwrap_or_else(|| {
                                table
                                    .geometry_columns
                                    .iter()
                                    .find(|g| g.name == layer.geometry_column)
                                    .map(|g| g.srid)
                                    .unwrap_or(0)
                            })
                    } else {
                        table
                            .geometry_columns
                            .iter()
                            .find(|g| g.name == layer.geometry_column)
                            .map(|g| g.srid)
                            .unwrap_or(0)
                    };
                    if ![0, 4326].contains(&actual_srid) {
                        return Err("只支持SRID0/4326写回".into());
                    }
                    let valid: Option<u8> = tx
                        .exec_first(
                            "SELECT ST_IsValid(ST_GeomFromGeoJSON(?,1,?))",
                            (geo.clone(), actual_srid),
                        )
                        .await
                        .map_err(|_| "几何解析/拓扑检查失败，整批已回滚")?;
                    if geo.is_some() && valid != Some(1) {
                        return Err("几何拓扑无效，整批已回滚".into());
                    }
                    columns.push(ident(&layer.geometry_column)?);
                    expressions.push(if layer.geometry_kind == "wkt" {
                        "ST_AsText(ST_GeomFromGeoJSON(?,1,?))".into()
                    } else {
                        "ST_GeomFromGeoJSON(?,1,?)".into()
                    });
                    params.push(mysql_async::Value::from(geo));
                    params.push(mysql_async::Value::from(actual_srid));
                }
                if columns.is_empty() {
                    continue;
                }
                if change.kind != "insert" {
                    params.extend(table.key_columns.iter().flat_map(|name| {
                        [
                            mysql_async::Value::from(key[name].clone()),
                            mysql_async::Value::from(key[name].clone()),
                        ]
                    }));
                }
                let sql = commit_sql(&table, &change.kind, &columns, &expressions)?;
                tx.exec_drop(sql, params)
                    .await
                    .map_err(|_| "字段类型/约束/写入权限检查失败，整批已回滚")?;
                if tx.affected_rows() > 1
                    || (change.kind == "insert" && tx.affected_rows() != 1)
                    || tx.get_warnings() > 0
                {
                    return Err("写入产生转换警告或范围异常，整批已回滚".into());
                }
            }
            Ok::<(), String>(())
        }
        .await;
        match operation {
            Ok(()) => {
                tx.commit()
                    .await
                    .map_err(|_| "提交结果待核对，请重新读取数据库，不要直接重复提交")?;
                Ok(json!({"committed":changes.len(),"reloadRequired":true}))
            }
            Err(error) => {
                tx.rollback()
                    .await
                    .map_err(|_| "回滚结果待核对，请断开并重新连接")?;
                Err(error)
            }
        }
    })
    .await;
    match result {
        Ok(Err(error)) if schema_applied=>Err(format!("字段结构已提交；数据修改未完成或结果待核对。请重新读取图层，禁止直接重试原变更。{error}")),
        Ok(result) => result,
        Err(_) => {
            clients.remove(&connection_id);
            Err(if schema_changes.is_empty(){"图层提交超时，连接已断开；请重新读取核实结果".into()}else{"字段或数据提交结果待核对，连接已断开；请重新读取来源表，禁止直接重试原变更".into()})
        }
    }
}
#[tauri::command]
pub async fn preview_mysql_table(
    state: State<'_, MysqlBackend>,
    connection_id: String,
    schema: String,
    table: String,
    limit: u32,
) -> Result<Preview, String> {
    if ![10, 20].contains(&limit) {
        return Err("预览条数仅支持 10 或 20".into());
    }
    let mut clients = state.clients.lock().await;
    let conn = clients.get_mut(&connection_id).ok_or("连接已失效")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let selected = selected_table(conn, &schema, &table).await?;
        let records: Vec<Row> = conn
            .query(preview_sql(&selected, limit)?)
            .await
            .map_err(|_| "Mysql 表预览失败，请检查 SELECT 权限")?;
        let truncated = records.len() > limit as usize;
        let rows = records
            .into_iter()
            .take(limit as usize)
            .map(|row| {
                (0..selected.columns.len())
                    .map(|i| {
                        row.get_opt::<Option<String>, _>(i)
                            .ok_or("字段缺失".to_string())?
                            .map_err(|_| "字段转换失败".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        let preview = Preview {
            columns: selected.columns,
            rows,
            truncated,
        };
        if serde_json::to_vec(&preview)
            .map_err(|_| "预览序列化失败")?
            .len()
            > 1024 * 1024
        {
            return Err("预览数据超过 1 MiB".into());
        }
        Ok(preview)
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            clients.remove(&connection_id);
            Err("表预览超时，连接已断开".into())
        }
    }
}

#[tauri::command]
pub async fn query_mysql_geometry(
    state: State<'_, MysqlBackend>,
    connection_id: String,
    schema: String,
    table: String,
    geometry_column: String,
    geometry_kind: Option<String>,
    limit: u32,
    srid: Option<i32>,
    bbox: Option<Vec<f64>>,
) -> Result<Value, String> {
    if limit == 0 || limit > 10000 {
        return Err("加载条数必须为1至10000".into());
    }
    let bbox = super::validate_bbox(bbox)?;
    let mut clients = state.clients.lock().await;
    let conn = clients.get_mut(&connection_id).ok_or("连接已失效")?;
    let result=tokio::time::timeout(Duration::from_secs(30),async {
        let selected=selected_table(conn,&schema,&table).await?;
        let layer=Layer {schema:schema.clone(),table:table.clone(),geometry_column:geometry_column.clone(),geometry_kind:geometry_kind.unwrap_or_else(||"geometry".into()),srid:srid.unwrap_or(0),key_columns:selected.key_columns.clone(),columns:selected.columns.clone()};
        let geom=geometry_expression(&selected,&layer)?;
        let mut expressions=load_expressions(&selected)?;
        let snapshot=snapshot_expressions(&selected);
        let writable=record_columns(&selected).is_ok()&&snapshot.is_ok()&&!selected.key_columns.contains(&geometry_column)&&!selected.columns.iter().any(|c|c.name==geometry_column&&c.generated)&&is_transactional(conn,&selected).await?;
        if writable {expressions.extend(snapshot?);}
        let order=if selected.key_columns.is_empty() {String::new()}else{format!(" ORDER BY {}",selected.key_columns.iter().map(|name|ident(name)).collect::<Result<Vec<_>,_>>()?.join(","))};
        let mut params=Vec::<mysql_async::Value>::new();
        let filter=if let Some(b)=bbox {
            let polygon=json!({"type":"Polygon","coordinates":[[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]],[b[0],b[1]]]]});
            params.push(mysql_async::Value::from(polygon.to_string()));
            format!(" WHERE MBRIntersects({geom},ST_GeomFromGeoJSON(?,1,ST_SRID({geom})))")
        }else{String::new()};
        let sql=format!("SELECT CASE WHEN OCTET_LENGTH({geom})>1048576 THEN NULL ELSE ST_AsGeoJSON({geom},15,0) END,ST_SRID({geom}),{} FROM {}.{}{filter}{order} LIMIT {}",expressions.join(","),ident(&schema)?,ident(&table)?,limit+1);
        let mut records=conn.exec_iter(sql,params).await.map_err(|_|"空间读取失败，请检查字段数据、Mysql版本与权限")?;
        let mut features=vec![];let mut total=0usize;let mut truncated=false;
        while let Some(row)=records.next().await.map_err(|_|"空间数据读取失败")? {
            if features.len()>=limit as usize {truncated=true;break;}
            let actual=row.get_opt::<Option<i32>,_>(1).ok_or("SRID字段缺失")?.map_err(|_|"SRID转换失败")?;
            let raw=row.get_opt::<Option<String>,_>(0).ok_or("几何字段缺失")?.map_err(|_|"几何字段转换失败")?;
            if layer.geometry_kind=="geometry" {if let Some(actual)=actual {validate_geometry_srid(actual,srid)?;}}
            if actual.is_some()&&raw.is_none() {return Err("单个几何体超过1 MiB，未加载".into());}
            let geometry=raw.map(|s|serde_json::from_str::<Value>(&s).map_err(|_|"几何转换失败")).transpose()?;
            let mut properties=serde_json::Map::new();
            for (i,col) in selected.columns.iter().enumerate() {
                if col.name==geometry_column||selected.geometry_columns.iter().any(|g|g.name==col.name) {continue;}
                let value=row.get_opt::<Option<String>,_>(2+i*2).ok_or("字段缺失")?.map_err(|_|"属性转换失败")?;
                let oversized=row.get_opt::<u8,_>(3+i*2).ok_or("字段大小标志缺失")?.map_err(|_|"字段大小转换失败")?!=0;
                properties.insert(col.name.clone(),attribute_value(&col.name,value,oversized)?);
            }
            let baseline=if writable {snapshot_values(&selected,&row,2+selected.columns.len()*2)?}else{RecordValues::new()};
            let key=if writable {selected.key_columns.iter().map(|name|(name.clone(),baseline[name].clone())).collect::<RecordValues>()}else{RecordValues::new()};
            if writable {validate_key(&selected,&key)?;}
            let id=if key.is_empty() {features.len().to_string()}else{serde_json::to_string(&key).map_err(|_|"主键序列化失败")?};
            let feature=json!({"id":id,"geometry":geometry,"properties":properties,"dbKey":key,"baseline":baseline});
            total+=serde_json::to_vec(&feature).map_err(|_|"空间数据序列化失败")?.len();
            if total>16*1024*1024 {return Err("空间数据超过16 MiB，请减少加载条数".into());}features.push(feature);
        }
        records.drop_result().await.map_err(|_|"空间数据读取失败")?;
        let result=json!({"features":features,"srid":4326,"truncated":truncated,"writable":writable});
        if serde_json::to_vec(&result).map_err(|_|"空间数据序列化失败")?.len()>16*1024*1024 {return Err("空间数据超过16 MiB，请减少加载条数".into());}
        Ok(result)
    }).await;
    match result {
        Ok(result) => result,
        Err(_) => {
            clients.remove(&connection_id);
            Err("空间加载超时，连接已断开".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> DatabaseTable {
        DatabaseTable {
            schema: "gis` ;DROP TABLE x".into(),
            table: "table`name".into(),
            columns: vec![Column {
                name: "n`um".into(),
                data_type: "decimal(65,30)".into(),
                nullable: true,
                generated: false,
                has_default: false,
            }],
            key_columns: vec![],
            geometry_columns: vec![],
        }
    }
    fn editable_table() -> DatabaseTable {
        let mut table = sample();
        table.columns[0].name = "id`key".into();
        table.columns[0].data_type = "bigint".into();
        table.columns[0].generated = true;
        table.columns[0].nullable = false;
        table.key_columns = vec!["id`key".into()];
        for (name, kind, nullable, generated) in [
            ("value", "decimal(65,30)", true, false),
            ("label", "varchar(255)", false, false),
            ("document", "json", true, false),
            ("binary", "blob", true, false),
            ("computed", "int", true, true),
        ] {
            table.columns.push(Column {
                name: name.into(),
                data_type: kind.into(),
                nullable,
                generated,
                has_default: false,
            });
        }
        table
    }
    fn baseline() -> RecordValues {
        [
            ("id`key", Some("90071992547409931234")),
            ("value", Some("12345678901234567890.1234567890")),
            ("label", Some("原始文字")),
            ("document", Some("{\"nested\":[1,null]}")),
            ("computed", Some("1")),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.map(str::to_string)))
        .collect()
    }
    fn spatial_table() -> (DatabaseTable, Layer) {
        let mut t = editable_table();
        t.columns.retain(|c| c.name != "binary");
        t.columns.push(Column {
            name: "shape".into(),
            data_type: "point".into(),
            nullable: true,
            generated: false,
            has_default: false,
        });
        t.geometry_columns.push(GeometryColumn {
            name: "shape".into(),
            srid: 0,
            kind: "point".into(),
        });
        let layer = Layer {
            schema: t.schema.clone(),
            table: t.table.clone(),
            geometry_column: "shape".into(),
            geometry_kind: "geometry".into(),
            srid: 4326,
            key_columns: t.key_columns.clone(),
            columns: t.columns.clone(),
        };
        (t, layer)
    }
    fn change(kind: &str, properties: Value) -> Change {
        serde_json::from_value(json!({"kind":kind,"properties":properties,"geometryChanged":false}))
            .unwrap()
    }
    #[test]
    fn mysql_layer_updates_keep_geometry_out_of_attribute_changes_and_protect_keys() {
        let (t, layer) = spatial_table();
        let mut original = baseline();
        original.insert("shape".into(), Some("000000000101".into()));
        let attr = changed_properties(
            &t,
            &layer,
            &change(
                "update",
                json!({"label":"changed","id`key":"90071992547409931234"}),
            ),
            &original,
        )
        .unwrap();
        assert_eq!(attr.keys().collect::<Vec<_>>(), vec!["label"]);
        assert!(changed_properties(
            &t,
            &layer,
            &change("update", json!({"shape":"POINT(1 2)"})),
            &original
        )
        .is_err());
        assert!(changed_properties(
            &t,
            &layer,
            &change("update", json!({"id`key":"other"})),
            &original
        )
        .is_err());
        baseline_complete(&t, &original).unwrap();
        original.remove("shape");
        assert!(baseline_complete(&t, &original).is_err());
        let expressions = snapshot_expressions(&t).unwrap().join(",");
        assert!(expressions.contains("HEX(`shape`)"));
        assert!(!expressions.contains("LEFT("));
    }
    #[test]
    fn mysql_inserts_and_deletes_enforce_required_values_defaults_and_stable_keys() {
        let (mut t, layer) = spatial_table();
        let inserted = changed_properties(
            &t,
            &layer,
            &change(
                "insert",
                json!({"id`key":null,"label":"new","document":{"a":1}}),
            ),
            &RecordValues::new(),
        )
        .unwrap();
        assert!(!inserted.contains_key("id`key"));
        let supplied_generated = changed_properties(
            &t,
            &layer,
            &change("insert", json!({"id`key":"123","label":"new"})),
            &RecordValues::new(),
        )
        .unwrap();
        assert!(!supplied_generated.contains_key("id`key"));
        assert_eq!(inserted["document"], Some("{\"a\":1}".into()));
        insert_required(&t, &layer, &inserted, &None).unwrap();
        assert!(insert_required(&t, &layer, &RecordValues::new(), &None).is_err());
        t.columns
            .iter_mut()
            .find(|c| c.name == "label")
            .unwrap()
            .has_default = true;
        insert_required(&t, &layer, &RecordValues::new(), &None).unwrap();
        let sql = commit_sql(&t, "insert", &["`label`".into()], &["?".into()]).unwrap();
        assert!(sql.starts_with("INSERT INTO"));
        assert!(sql.ends_with("VALUES (?)"));
        let sql = commit_sql(&t, "delete", &[], &[]).unwrap();
        assert!(sql.contains("`id``key` = ?"));
        assert!(sql.contains("AS BINARY) = CAST(? AS BINARY)"));
        assert!(sql.ends_with("LIMIT 1"));
        assert_eq!(sql.matches('?').count(), 2);
        t.key_columns.clear();
        assert!(commit_sql(&t, "delete", &[], &[]).is_err());
        assert!(commit_sql(&t, "drop", &[], &[]).is_err());
    }
    #[test]
    fn mysql_geometry_preserves_raw_srid_and_rejects_xyz_and_implicit_wkt_coordinates() {
        assert_eq!(raw_geometry_srid("000000000101").unwrap(), 0);
        assert_eq!(raw_geometry_srid("E61000000101").unwrap(), 4326);
        assert!(raw_geometry_srid("110F00000101").is_err());
        assert!(raw_geometry_srid("中中中中").is_err());
        validate_mysql_geometry(&Some(json!({"type":"Point","coordinates":[120,30]}))).unwrap();
        assert!(
            validate_mysql_geometry(&Some(json!({"type":"Point","coordinates":[120,30,10]})))
                .is_err()
        );
        assert!(
            validate_mysql_geometry(&Some(json!({"type":"Point","coordinates":[190,30]}))).is_err()
        );
        validate_mysql_geometry(&None).unwrap();
        let (mut t, mut layer) = spatial_table();
        t.geometry_columns.clear();
        t.columns
            .iter_mut()
            .find(|c| c.name == "shape")
            .unwrap()
            .data_type = "text".into();
        layer.geometry_kind = "wkt".into();
        assert!(geometry_expression(&t, &layer)
            .unwrap()
            .contains("NULLIF(`shape`,'')"));
        layer.srid = 0;
        assert!(geometry_expression(&t, &layer).is_err());
    }
    #[test]
    fn mysql_schema_plan_is_one_atomic_alter_with_varchar255_and_baseline_mapping() {
        let (t, layer) = spatial_table();
        let operations = vec![
            SchemaChange {
                kind: "add".into(),
                name: "new`field".into(),
                new_name: None,
            },
            SchemaChange {
                kind: "rename".into(),
                name: "label".into(),
                new_name: Some("renamed".into()),
            },
            SchemaChange {
                kind: "delete".into(),
                name: "value".into(),
                new_name: None,
            },
        ];
        let (projected, sql) = schema_plan(&t, &layer, &operations).unwrap();
        assert_eq!(sql.matches("ALTER TABLE").count(), 1);
        assert!(sql.contains("ADD COLUMN `new``field` VARCHAR(255) NULL"));
        assert!(sql.contains("RENAME COLUMN `label` TO `renamed`"));
        assert!(sql.contains("DROP COLUMN `value`"));
        let mapped = remap_baseline(&baseline(), &operations);
        assert_eq!(mapped["renamed"], Some("原始文字".into()));
        assert_eq!(mapped["new`field"], None);
        assert!(!mapped.contains_key("value"));
        assert!(projected
            .columns
            .iter()
            .any(|c| c.name == "new`field" && c.data_type == "varchar(255)" && c.nullable));
        for name in ["id`key", "shape", "computed"] {
            assert!(schema_plan(
                &t,
                &layer,
                &[SchemaChange {
                    kind: "delete".into(),
                    name: name.into(),
                    new_name: None
                }]
            )
            .is_err());
        }
        assert!(schema_plan(
            &t,
            &layer,
            &[SchemaChange {
                kind: "rename".into(),
                name: "label".into(),
                new_name: Some("document".into())
            }]
        )
        .is_err());
    }
    #[test]
    fn mysql_schema_sequences_collapse_add_delete_and_rename_chains_into_net_alter() {
        let (t, layer) = spatial_table();
        let sequence = vec![
            SchemaChange {
                kind: "add".into(),
                name: "extra".into(),
                new_name: None,
            },
            SchemaChange {
                kind: "rename".into(),
                name: "label".into(),
                new_name: Some("temporary".into()),
            },
            SchemaChange {
                kind: "rename".into(),
                name: "temporary".into(),
                new_name: Some("final".into()),
            },
            SchemaChange {
                kind: "delete".into(),
                name: "extra".into(),
                new_name: None,
            },
        ];
        let (_, sql) = schema_plan(&t, &layer, &sequence).unwrap();
        assert!(sql.ends_with("RENAME COLUMN `label` TO `final`"));
        assert!(!sql.contains("extra"));
        assert!(!sql.contains("temporary"));
        let mapped = remap_baseline(&baseline(), &sequence);
        assert_eq!(mapped["final"], Some("原始文字".into()));
        assert!(!mapped.contains_key("extra"));
        let add_rename = vec![
            SchemaChange {
                kind: "add".into(),
                name: "extra".into(),
                new_name: None,
            },
            SchemaChange {
                kind: "rename".into(),
                name: "extra".into(),
                new_name: Some("newName".into()),
            },
        ];
        let (_, sql) = schema_plan(&t, &layer, &add_rename).unwrap();
        assert!(sql.ends_with("ADD COLUMN `newName` VARCHAR(255) NULL"));
        let rename_delete = vec![
            SchemaChange {
                kind: "rename".into(),
                name: "label".into(),
                new_name: Some("gone".into()),
            },
            SchemaChange {
                kind: "delete".into(),
                name: "gone".into(),
                new_name: None,
            },
        ];
        let (_, sql) = schema_plan(&t, &layer, &rename_delete).unwrap();
        assert!(sql.ends_with("DROP COLUMN `label`"));
        let canceled = vec![
            SchemaChange {
                kind: "add".into(),
                name: "extra".into(),
                new_name: None,
            },
            SchemaChange {
                kind: "delete".into(),
                name: "extra".into(),
                new_name: None,
            },
        ];
        assert!(schema_plan(&t, &layer, &canceled).unwrap().1.is_empty());
    }
    #[test]
    fn records_require_exact_primary_key_and_full_safe_baseline() {
        let t = editable_table();
        let mut original = baseline();
        let changes = RecordValues::from([("value".into(), None)]);
        let key = validate_update(&t, &original, &changes).unwrap();
        assert_eq!(key["id`key"], Some("90071992547409931234".into()));
        original.remove("computed");
        assert!(validate_update(&t, &original, &changes).is_err());
        assert!(validate_key(&t, &RecordValues::new()).is_err());
        assert!(validate_key(&t, &RecordValues::from([("id`key".into(), None)])).is_err());
        let mut extra = key;
        extra.insert("extra".into(), Some("x".into()));
        assert!(validate_key(&t, &extra).is_err());
        assert!(record_columns(&sample()).is_err());
    }
    #[test]
    fn updates_reject_keys_generated_binary_unknown_invalid_json_and_nullability() {
        let t = editable_table();
        let original = baseline();
        for field in ["id`key", "computed", "binary", "unknown"] {
            assert!(validate_update(
                &t,
                &original,
                &RecordValues::from([(field.into(), Some("x".into()))])
            )
            .is_err());
        }
        assert!(
            validate_update(&t, &original, &RecordValues::from([("label".into(), None)])).is_err()
        );
        assert!(validate_update(
            &t,
            &original,
            &RecordValues::from([("document".into(), Some("{bad json".into()))])
        )
        .is_err());
        assert!(validate_update(
            &t,
            &original,
            &RecordValues::from([("document".into(), Some("null".into()))])
        )
        .is_ok());
    }
    #[test]
    fn updates_quote_identifiers_and_parameterize_all_values_with_locked_baseline() {
        let t = editable_table();
        let evil = "';DROP TABLE users;--";
        let changes =
            RecordValues::from([("label".into(), Some(evil.into())), ("value".into(), None)]);
        let sql = update_sql(&t, &changes).unwrap();
        assert!(!sql.contains(evil));
        assert_eq!(sql.matches('?').count(), 3);
        assert!(sql.contains("`id``key` = ?"));
        assert!(sql.ends_with("LIMIT 1"));
        let locked = record_sql(&t, true).unwrap();
        assert!(locked.ends_with("LIMIT 2 FOR UPDATE"));
        assert!(!locked.contains("LEFT("));
        assert!(!locked.contains("未读取"));
        assert!(!locked.contains("`binary`"));
        assert!(locked.contains("`computed`"));
    }
    #[test]
    fn identifiers_are_quoted_and_numeric_values_stay_text() {
        let sql = preview_sql(&sample(), 20).unwrap();
        assert!(sql.contains("`gis`` ;DROP TABLE x`.`table``name`"));
        assert!(sql.contains("CAST(`n``um` AS CHAR)"));
        assert!(sql.ends_with("LIMIT 21"));
        assert!(ident("a\0b").is_err());
    }
    #[test]
    fn bounds_and_large_fields_are_enforced() {
        assert!(preview_sql(&sample(), 100).is_err());
        let mut t = sample();
        t.columns = vec![t.columns[0].clone(); 129];
        assert!(preview_sql(&t, 10).is_err());
        let mut t = sample();
        t.columns[0].data_type = "json".into();
        assert!(preview_sql(&t, 10).unwrap().contains("复杂字段"));
        t.columns[0].data_type = "longblob".into();
        assert!(preview_sql(&t, 10).unwrap().contains("二进制字段"));
    }
    #[test]
    fn source_config_rejects_password_and_duplicate_ids() {
        let source = r#"{"id":"1","name":"Mysql","host":"localhost","port":3306,"database":"gis","user":"reader","sslMode":"require"}"#;
        let s: MysqlSource = serde_json::from_str(source).unwrap();
        assert!(validate_sources(&[s.clone()]).is_ok());
        assert!(validate_sources(&[s.clone(), s]).is_err());
        assert!(serde_json::from_str::<MysqlSource>(
            &source.replace("\"id\":", "\"password\":\"secret\",\"id\":")
        )
        .is_err());
    }
    #[test]
    fn loading_keeps_full_text_json_and_precision_without_preview_summaries() {
        let mut t = sample();
        t.columns.push(Column {
            name: "json".into(),
            data_type: "json".into(),
            nullable: true,
            generated: false,
            has_default: false,
        });
        let sql = load_expressions(&t).unwrap().join(",");
        assert!(!sql.contains("LEFT("));
        assert!(!sql.contains("未读取"));
        assert!(sql.contains("CAST(`json` AS CHAR CHARACTER SET utf8mb4)"));
        assert!(sql.contains("COALESCE(OCTET_LENGTH"));
        let precise = "123456789012345678901234567890.12345678901234567890";
        assert_eq!(
            attribute_value("n", Some(precise.into()), false).unwrap(),
            Value::String(precise.into())
        );
        assert_eq!(attribute_value("n", None, false).unwrap(), Value::Null);
        let long = "x".repeat(4097);
        assert_eq!(
            attribute_value("text", Some(long.clone()), false).unwrap(),
            Value::String(long)
        );
        assert!(attribute_value("n", None, true).is_err());
        assert!(attribute_value("n", Some("x".repeat(MAX_ATTRIBUTE_BYTES + 1)), false).is_err());
        t.columns[0].data_type = "longblob".into();
        assert!(load_expressions(&t).unwrap_err().contains("无法无损加载"));
    }
    #[test]
    fn geometry_coordinates_are_never_silently_relabelled() {
        assert!(validate_geometry_srid(4326, None).is_ok());
        assert!(validate_geometry_srid(0, None).is_err());
        assert!(validate_geometry_srid(0, Some(4326)).is_ok());
        assert!(validate_geometry_srid(3857, Some(4326)).is_err());
        assert!(validate_geometry_srid(0, Some(3857)).is_err());
    }
}
