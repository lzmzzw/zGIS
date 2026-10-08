use super::{atomic_write, ident, Backend, Column};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};
use tauri::{Manager, State};
use tokio_postgres::Client;

const MAX_SOURCES: usize = 64;
const MAX_COLUMNS: usize = 128;
const CELL_CHARS: usize = 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseSource {
    id: String,
    name: String,
    host: String,
    port: u16,
    database: String,
    user: String,
    ssl_mode: String,
}

fn validate_sources(sources: &[DatabaseSource]) -> Result<(), String> {
    if sources.len() > MAX_SOURCES {
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
                return Err("数据源配置包含空字段、过长字段或控制字符".into());
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
pub fn save_database_sources(
    app: tauri::AppHandle,
    sources: Vec<DatabaseSource>,
) -> Result<(), String> {
    validate_sources(&sources)?;
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "配置目录不可用")?;
    std::fs::create_dir_all(&directory).map_err(|_| "配置目录不可写")?;
    let bytes = serde_json::to_vec(&sources).map_err(|_| "数据源配置无效")?;
    atomic_write(&directory.join("postgis-sources.json"), &bytes)
}

#[tauri::command]
pub fn load_database_sources(app: tauri::AppHandle) -> Result<Vec<DatabaseSource>, String> {
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "配置目录不可用")?
        .join("postgis-sources.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    if std::fs::metadata(&path)
        .map_err(|_| "数据源配置不可读")?
        .len()
        > 256 * 1024
    {
        return Err("数据源配置过大".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "数据源配置不可读")?;
    let sources: Vec<DatabaseSource> =
        serde_json::from_slice(&bytes).map_err(|_| "数据源配置无效")?;
    validate_sources(&sources)?;
    Ok(sources)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryColumn {
    name: String,
    srid: i32,
    #[serde(rename = "type")]
    kind: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTable {
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
pub struct Preview {
    columns: Vec<Column>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
}

// 目录依据 PostgreSQL 元数据和 SELECT 权限，避免将普通表误判为可加载的空间图层。
async fn catalog(client: &Client) -> Result<Catalog, String> {
    let schema_rows = client.query("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND has_schema_privilege(oid,'USAGE') ORDER BY nspname LIMIT 10001", &[]).await.map_err(|_| "读取 Schema 失败")?;
    if schema_rows.len() > 10000 {
        return Err("Schema 数量超过浏览上限".into());
    }
    let schemas = schema_rows.into_iter().map(|r| r.get(0)).collect();
    let rows = client.query("SELECT n.nspname,c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),NOT a.attnotnull,(a.attidentity <> '' OR a.attgenerated <> ''),a.atthasdef,t.typname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT') ORDER BY n.nspname,c.relname,a.attnum LIMIT 100001", &[]).await.map_err(|_| "读取表目录失败")?;
    if rows.len() > 100000 {
        return Err("目录过大，请使用权限限制需要浏览的表".into());
    }
    let mut tables = BTreeMap::<(String, String), DatabaseTable>::new();
    for row in rows {
        let schema: String = row.get(0);
        let table: String = row.get(1);
        let entry = tables
            .entry((schema.clone(), table.clone()))
            .or_insert_with(|| DatabaseTable {
                schema,
                table,
                columns: vec![],
                key_columns: vec![],
                geometry_columns: vec![],
            });
        if let Some(name) = row.get::<_, Option<String>>(2) {
            if row.get::<_, Option<String>>(7).as_deref() == Some("geometry") {
                entry.geometry_columns.push(GeometryColumn {
                    name: name.clone(),
                    srid: 0,
                    kind: "Geometry".into(),
                });
            }
            entry.columns.push(Column {
                name,
                data_type: row.get(3),
                nullable: row.get(4),
                generated: row.get(5),
                has_default: row.get(6),
            });
        }
    }
    let keys = client.query("SELECT n.nspname,c.relname,a.attname FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,pos) ON true JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE i.indisprimary AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY n.nspname,c.relname,k.pos LIMIT 100001", &[]).await.map_err(|_| "读取主键失败")?;
    if keys.len() > 100000 {
        return Err("主键目录超过浏览上限".into());
    }
    for row in keys {
        if let Some(table) = tables.get_mut(&(row.get(0), row.get(1))) {
            table.key_columns.push(row.get(2));
        }
    }
    let extension = client.query_opt("SELECT n.nspname FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='postgis'", &[]).await.map_err(|_| "读取 PostGIS 元数据失败")?;
    if let Some(row) = extension {
        let namespace: String = row.get(0);
        let sql = format!("SELECT f_table_schema,f_table_name,f_geometry_column,srid,type FROM {}.geometry_columns LIMIT 100001", ident(&namespace)?);
        let geometries = client
            .query(&sql, &[])
            .await
            .map_err(|_| "读取 PostGIS 几何字段失败")?;
        for row in geometries {
            if let Some(table) = tables.get_mut(&(row.get(0), row.get(1))) {
                let name: String = row.get(2);
                if let Some(column) = table
                    .geometry_columns
                    .iter_mut()
                    .find(|column| column.name == name)
                {
                    column.srid = row.get(3);
                    column.kind = row.get(4);
                }
            }
        }
    }
    Ok(Catalog {
        schemas,
        tables: tables.into_values().collect(),
    })
}

#[tauri::command]
pub async fn discover_database_tables(
    state: State<'_, Backend>,
    connection_id: String,
) -> Result<Catalog, String> {
    let databases = state.databases.lock().await;
    let client = databases.get(&connection_id).ok_or("连接已失效")?;
    tokio::time::timeout(Duration::from_secs(15), catalog(client))
        .await
        .map_err(|_| "读取目录超时")?
}

fn preview_sql(table: &DatabaseTable, limit: i64) -> Result<String, String> {
    if ![10, 20].contains(&limit) {
        return Err("预览条数仅支持 10 或 20".into());
    }
    if table.columns.len() > MAX_COLUMNS {
        return Err("表字段超过 128 列，暂不支持预览".into());
    }
    let expressions = table.columns.iter().map(|column| {
        let quoted = ident(&column.name)?;
        if let Some(geometry) = table.geometry_columns.iter().find(|g| g.name == column.name) {
            let summary = format!("{} · SRID {}", geometry.kind, geometry.srid).replace('\'', "''");
            return Ok(format!("CASE WHEN {quoted} IS NULL THEN NULL ELSE '{summary}'::text END"));
        }
        // 数组、JSON 和自定义类型可能在小体积 TOAST 中压缩极大的值；不触发其输出函数。
        if !safe_scalar(&column.data_type) {
            return Ok(format!("CASE WHEN {quoted} IS NULL THEN NULL ELSE '[复杂字段，未读取]'::text END"));
        }
        let size = if matches!(column.data_type.as_str(), "text" | "bytea" | "character varying" | "character") || column.data_type.starts_with("character varying(") || column.data_type.starts_with("character(") { format!("octet_length({quoted})") } else { format!("pg_column_size({quoted})") };
        Ok(format!("CASE WHEN {quoted} IS NULL THEN NULL WHEN {size}>4096 THEN '[大字段，未读取]'::text ELSE left({quoted}::text,{CELL_CHARS}) END"))
    }).collect::<Result<Vec<String>, String>>()?;
    let columns = if expressions.is_empty() {
        "NULL::text".into()
    } else {
        expressions.join(",")
    };
    Ok(format!(
        "SELECT {columns} FROM {}.{} LIMIT $1",
        ident(&table.schema)?,
        ident(&table.table)?
    ))
}

fn safe_scalar(kind: &str) -> bool {
    [
        "text",
        "bytea",
        "boolean",
        "smallint",
        "integer",
        "bigint",
        "real",
        "double precision",
        "money",
        "uuid",
        "date",
        "inet",
        "cidr",
        "macaddr",
        "macaddr8",
        "character",
        "character varying",
        "numeric",
        "bit",
        "bit varying",
    ]
    .contains(&kind)
        || [
            "timestamp without time zone",
            "timestamp with time zone",
            "time without time zone",
            "time with time zone",
            "interval",
        ]
        .contains(&kind)
        || [
            "numeric(",
            "character(",
            "character varying(",
            "bit(",
            "bit varying(",
            "timestamp(",
            "time(",
            "interval(",
            "interval ",
        ]
        .iter()
        .any(|prefix| kind.starts_with(prefix))
}

#[tauri::command]
pub async fn preview_database_table(
    state: State<'_, Backend>,
    connection_id: String,
    schema: String,
    table: String,
    limit: i64,
) -> Result<Preview, String> {
    if ![10, 20].contains(&limit) {
        return Err("预览条数仅支持 10 或 20".into());
    }
    let databases = state.databases.lock().await;
    let client = databases.get(&connection_id).ok_or("连接已失效")?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let selected = catalog(client)
            .await?
            .tables
            .into_iter()
            .find(|t| t.schema == schema && t.table == table)
            .ok_or("表不存在或没有 SELECT 权限")?;
        let sql = preview_sql(&selected, limit)?;
        let take = limit + 1;
        let result = client
            .query(&sql, &[&take])
            .await
            .map_err(|_| "读取表预览失败，请检查权限或字段类型")?;
        let truncated = result.len() > limit as usize;
        let rows = result
            .into_iter()
            .take(limit as usize)
            .map(|row| {
                (0..selected.columns.len())
                    .map(|index| {
                        row.try_get::<_, Option<String>>(index)
                            .map_err(|_| "预览字段转换失败".to_string())
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
            .map_err(|_| "预览结果无效")?
            .len()
            > 1024 * 1024
        {
            return Err("预览结果超过 1 MiB，请选择更少的预览行".into());
        }
        Ok(preview)
    })
    .await
    .map_err(|_| "表预览超时")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn table() -> DatabaseTable {
        DatabaseTable {
            schema: "public\";DROP TABLE x;--".into(),
            table: "a'b".into(),
            columns: vec![Column {
                name: "value\"".into(),
                data_type: "numeric".into(),
                nullable: true,
                generated: false,
                has_default: false,
            }],
            key_columns: vec![],
            geometry_columns: vec![],
        }
    }
    #[test]
    fn preview_quotes_identifiers_and_keeps_values_as_text() {
        let sql = preview_sql(&table(), 20).unwrap();
        assert!(sql.contains("\"public\"\";DROP TABLE x;--\".\"a'b\""));
        assert!(sql.contains("\"value\"\"\"::text"));
        assert!(sql.ends_with("LIMIT $1"));
    }
    #[test]
    fn preview_limits_rows_columns_and_large_cells() {
        assert!(preview_sql(&table(), 100).is_err());
        let mut t = table();
        t.columns = vec![t.columns[0].clone(); 129];
        assert!(preview_sql(&t, 10).is_err());
        assert!(preview_sql(&table(), 10)
            .unwrap()
            .contains("pg_column_size"));
    }
    #[test]
    fn geometry_preview_never_serializes_geometry() {
        let mut t = table();
        t.geometry_columns.push(GeometryColumn {
            name: t.columns[0].name.clone(),
            srid: 4326,
            kind: "MultiPolygon".into(),
        });
        let sql = preview_sql(&t, 20).unwrap();
        assert!(sql.contains("MultiPolygon · SRID 4326"));
        assert!(!sql.contains("::text,1024"));
    }
    #[test]
    fn compressed_complex_fields_do_not_trigger_unbounded_output_functions() {
        let mut t = table();
        for kind in ["jsonb", "integer[]", "custom_type", "geometry"] {
            t.columns[0].data_type = kind.into();
            let sql = preview_sql(&t, 20).unwrap();
            assert!(sql.contains("复杂字段，未读取"));
            assert!(!sql.contains("left("));
        }
    }
    #[test]
    fn sources_reject_password_unknown_fields_duplicates_and_invalid_settings() {
        let json = r#"{"id":"1","name":"source","host":"localhost","port":5432,"database":"gis","user":"reader","sslMode":"require"}"#;
        let source: DatabaseSource = serde_json::from_str(json).unwrap();
        assert!(validate_sources(&[source.clone()]).is_ok());
        assert!(validate_sources(&[source.clone(), source.clone()]).is_err());
        assert!(serde_json::from_str::<DatabaseSource>(
            &json.replace("\"id\":", "\"password\":\"secret\",\"id\":")
        )
        .is_err());
        let mut invalid = source;
        invalid.port = 0;
        assert!(validate_sources(&[invalid]).is_err());
    }
}
