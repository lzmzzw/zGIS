//! 仅绑定 loopback 的会话 MCP；无任意写文件、数据库或进程工具。
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{sync::Semaphore, task::JoinHandle};
#[derive(Clone, Default)]
pub struct GisMcp {
    inner: Arc<Mutex<Inner>>,
}
#[derive(Default)]
struct Inner {
    generation: u64,
    endpoint: Option<String>,
    token: Option<String>,
    server: Option<JoinHandle<()>>,
    layers: Vec<Value>,
    active: Option<String>,
    grants: Vec<PathBuf>,
    results: HashMap<String, Cached>,
    queue: Vec<Value>,
    audit: VecDeque<Value>,
}
struct Cached {
    publishable: bool,
    bytes: usize,
    features: Vec<Value>,
    summary: Value,
    created: Instant,
    versions: Vec<(String, String)>,
    published: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    enabled: bool,
    endpoint: Option<String>,
    token: Option<String>,
    authorized_paths: Vec<String>,
}
impl GisMcp {
    fn start_generation(&self) -> Option<u64> {
        let i = self.inner.lock().unwrap();
        if i.server.is_some() {
            None
        } else {
            Some(i.generation)
        }
    }
    fn install_listener(
        &self,
        listener: tokio::net::TcpListener,
        generation: u64,
    ) -> Result<(), String> {
        let endpoint = format!(
            "http://{}/mcp",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let mut i = self.inner.lock().unwrap();
        if i.generation != generation {
            return Err("MCP启动已被停止或撤销取消".into());
        }
        if i.server.is_some() {
            return Ok(());
        }
        i.endpoint = Some(endpoint);
        i.token = Some(uuid::Uuid::new_v4().to_string());
        let app = router(self.clone());
        i.server = Some(tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        }));
        Ok(())
    }
    pub fn access(&self) -> Result<(String, String), String> {
        let i = self.inner.lock().unwrap();
        Ok((
            i.endpoint.clone().ok_or("MCP未启动")?,
            i.token.clone().ok_or("MCP未启动")?,
        ))
    }
    pub fn shutdown(&self) {
        let mut i = self.inner.lock().unwrap();
        i.generation += 1;
        if let Some(h) = i.server.take() {
            h.abort()
        }
        i.endpoint = None;
        i.token = None;
        i.results.clear();
        i.queue.clear();
        i.grants.clear();
    }
    fn status(&self) -> McpStatus {
        let i = self.inner.lock().unwrap();
        McpStatus {
            enabled: i.server.is_some(),
            endpoint: i.endpoint.clone(),
            token: i.token.clone(),
            authorized_paths: i.grants.iter().map(|p| p.display().to_string()).collect(),
        }
    }
    fn log(&self, name: &str, ok: bool) {
        let safe_name = if definitions().iter().any(|d| d["name"] == name)
            || ["http_host_check", "http_auth_check", "http_origin_check"].contains(&name)
        {
            name
        } else {
            "unknown_tool"
        };
        let mut i = self.inner.lock().unwrap();
        i.audit.push_back(json!({"tool":safe_name,"risk":if name=="publish_result"{"local_layer_add"}else{"read_only"},"status":if ok{"ok"}else{"error"},"summary":if ok{"完成"}else{"拒绝或执行失败"}}));
        while i.audit.len() > 200 {
            i.audit.pop_front();
        }
    }
}
#[tauri::command]
pub fn gis_mcp_status(state: tauri::State<'_, GisMcp>) -> McpStatus {
    state.status()
}
#[tauri::command]
pub async fn gis_mcp_set_enabled(
    enabled: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, GisMcp>,
) -> Result<McpStatus, String> {
    if !enabled {
        if let Some(agent) = app.try_state::<crate::codex_agent::CodexAgent>() {
            agent.shutdown();
        }
        state.shutdown();
        return Ok(state.status());
    }
    let Some(generation) = state.start_generation() else {
        return Ok(state.status());
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    state.install_listener(listener, generation)?;
    Ok(state.status())
}
#[tauri::command]
pub fn gis_workspace_sync(
    layers: Vec<Value>,
    active_layer_id: Option<String>,
    state: tauri::State<'_, GisMcp>,
) -> Result<(), String> {
    if serde_json::to_vec(&layers)
        .map_err(|e| e.to_string())?
        .len()
        > 100 * 1024 * 1024
    {
        return Err("同步图层总大小超过100MB".into());
    }
    if layers.len() > 100 {
        return Err("最多同步100图层".into());
    }
    let mut count = 0;
    for l in &layers {
        if !l["id"].is_string() || !l["name"].is_string() {
            return Err("无效图层".into());
        }
        let fs = l["features"].as_array().ok_or("缺少features")?;
        count += fs.len();
        for f in fs {
            if f["type"] != "Feature" {
                return Err("无效要素".into());
            }
            super::vector_files::validate_geometry(&f["geometry"])?;
        }
    }
    if count > 100_000 {
        return Err("最多同步100000要素".into());
    }
    let mut i = state.inner.lock().unwrap();
    i.layers = layers;
    i.active = active_layer_id;
    Ok(())
}
#[tauri::command]
pub fn gis_results_drain(state: tauri::State<'_, GisMcp>) -> Vec<Value> {
    std::mem::take(&mut state.inner.lock().unwrap().queue)
}
#[tauri::command]
pub async fn gis_authorize_files(state: tauri::State<'_, GisMcp>) -> Result<Vec<String>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .add_filter("矢量文件", &["geojson", "json", "csv", "shp", "zip"])
        .pick_files()
        .await;
    let mut i = state.inner.lock().unwrap();
    if let Some(files) = selected {
        for f in files {
            let p = f.path().canonicalize().map_err(|e| e.to_string())?;
            if p.components().any(|c| {
                c.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("_credentials")
            }) {
                return Err("不可授权凭据目录".into());
            }
            if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("shp")) {
                for ext in ["shp", "shx", "dbf", "prj", "cpg"] {
                    let q = p.with_extension(ext);
                    if q.exists() {
                        let q = q.canonicalize().map_err(|e| e.to_string())?;
                        if q.parent() != p.parent() {
                            return Err("配套文件越过授权目录".into());
                        }
                        if !i.grants.contains(&q) {
                            i.grants.push(q)
                        }
                    }
                }
            } else if !i.grants.contains(&p) {
                i.grants.push(p)
            }
        }
    }
    Ok(i.grants.iter().map(|p| p.display().to_string()).collect())
}
#[tauri::command]
pub async fn gis_authorize_directory(
    state: tauri::State<'_, GisMcp>,
) -> Result<Vec<String>, String> {
    let selected = rfd::AsyncFileDialog::new().pick_folder().await;
    let mut i = state.inner.lock().unwrap();
    if let Some(f) = selected {
        let p = f.path().canonicalize().map_err(|e| e.to_string())?;
        if p.components().any(|c| {
            c.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("_credentials")
        }) {
            return Err("不可授权凭据目录".into());
        }
        if !i.grants.contains(&p) {
            i.grants.push(p)
        }
    }
    Ok(i.grants.iter().map(|p| p.display().to_string()).collect())
}
#[tauri::command]
pub fn gis_revoke_access(state: tauri::State<'_, GisMcp>) {
    let mut i = state.inner.lock().unwrap();
    i.generation += 1;
    i.grants.clear();
    i.results.clear();
    i.queue.clear();
}
#[tauri::command]
pub fn gis_mcp_audit(state: tauri::State<'_, GisMcp>) -> Vec<Value> {
    state.inner.lock().unwrap().audit.iter().cloned().collect()
}
#[derive(Clone)]
struct HttpState {
    mcp: GisMcp,
    limit: Arc<Semaphore>,
}
fn router(mcp: GisMcp) -> Router {
    Router::new()
        .route("/mcp", post(handle))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(HttpState {
            mcp,
            limit: Arc::new(Semaphore::new(2)),
        })
}
async fn handle(
    State(s): State<HttpState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let (endpoint, token, generation) = {
        let i = s.mcp.inner.lock().unwrap();
        (
            i.endpoint.clone().ok_or(StatusCode::SERVICE_UNAVAILABLE)?,
            i.token.clone().ok_or(StatusCode::SERVICE_UNAVAILABLE)?,
            i.generation,
        )
    };
    let base = endpoint.trim_end_matches("/mcp");
    let host = base.trim_start_matches("http://");
    if headers.get("host").and_then(|h| h.to_str().ok()) != Some(host) {
        s.mcp.log("http_host_check", false);
        return Err(StatusCode::FORBIDDEN);
    }
    if headers.get("authorization").and_then(|h| h.to_str().ok())
        != Some(format!("Bearer {token}").as_str())
    {
        s.mcp.log("http_auth_check", false);
        return Err(StatusCode::UNAUTHORIZED);
    }
    if let Some(origin) = headers.get("origin") {
        if origin.to_str().ok() != Some(base) {
            s.mcp.log("http_origin_check", false);
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let req: Value = serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)?;
    if req["jsonrpc"] != "2.0" || !req.is_object() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = req.get("id").cloned();
    let method = req["method"].as_str().ok_or(StatusCode::BAD_REQUEST)?;
    if id.is_none() {
        if method.starts_with("notifications/") {
            return Ok((StatusCode::ACCEPTED, Json(Value::Null)));
        }
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = id.unwrap();
    let result = match method {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"zgis","version":"0.1.0"},"instructions":"仅分析当前图层快照或用户会话授权文件；所有几何WGS84，结果需publish_result加入独立图层。"}),
        ),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":definitions()})),
        "tools/call" => {
            let params = &req["params"];
            let name = params["name"]
                .as_str()
                .ok_or(StatusCode::BAD_REQUEST)?
                .to_string();
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            let permit = s
                .limit
                .clone()
                .try_acquire_owned()
                .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
            let m = s.mcp.clone();
            let n = name.clone();
            let r = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                call_expected(&m, &n, &args, generation)
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            s.mcp.log(&name, r.is_ok());
            Ok(match r {
                Ok(v) => {
                    json!({"content":[{"type":"text","text":v.to_string()}],"structuredContent":v,"isError":false})
                }
                Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
            })
        }
        _ => Err("未知JSON-RPC方法".to_string()),
    };
    Ok((
        StatusCode::OK,
        Json(match result {
            Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
            Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":e}}),
        }),
    ))
}
fn def(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":name!="publish_result","destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})
}
pub fn definitions() -> Vec<Value> {
    let mut d = vec![
        def("list_layers", "列举当前zGIS图层快照", json!({}), &[]),
        def(
            "describe_layer",
            "查看图层字段、要素数与快照版本",
            json!({"layerId":{"type":"string"}}),
            &["layerId"],
        ),
        def(
            "read_features",
            "分页读取当前图层（最多100条）",
            json!({"layerId":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}}),
            &["layerId"],
        ),
        def(
            "load_vector_file",
            "读取用户会话授权的外部矢量文件并缓存，支持GeoJSON/CSV/SHP/ZIP；二维WGS84",
            json!({"path":{"type":"string"},"crs":{"type":"string","enum":["EPSG:4326","EPSG:3857"]},"wktField":{"type":"string"},"xField":{"type":"string"},"yField":{"type":"string"}}),
            &["path"],
        ),
        def(
            "read_result",
            "分页读取分析缓存（最多100条）",
            json!({"resultId":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}}),
            &["resultId"],
        ),
        def(
            "publish_result",
            "将结果作为独立新图层加入zGIS，不修改源图层，不写文件",
            json!({"resultId":{"type":"string"},"name":{"type":"string","minLength":1,"maxLength":100}}),
            &["resultId", "name"],
        ),
    ];
    let mut spatial = super::spatial::tool_definitions();
    for tool in &mut spatial {
        for name in ["source", "target"] {
            if let Some(variants) = tool["inputSchema"]["properties"][name]["oneOf"].as_array_mut()
            {
                variants.push(json!({"type":"object","properties":{"resultId":{"type":"string","minLength":1}},"required":["resultId"],"additionalProperties":false}));
            }
        }
    }
    d.extend(spatial);
    d
}
fn validate(value: &Value, schema: &Value) -> Result<(), String> {
    match schema["type"].as_str() {
        Some("object") => {
            let obj = value.as_object().ok_or("参数必须是object")?;
            let props = schema["properties"].as_object();
            if schema["additionalProperties"] == false {
                for k in obj.keys() {
                    if !props.is_some_and(|p| p.contains_key(k)) {
                        return Err(format!("未知参数: {k}"));
                    }
                }
            }
            if let Some(required) = schema["required"].as_array() {
                for k in required {
                    if !obj.contains_key(k.as_str().ok_or("无效schema")?) {
                        return Err(format!("缺少参数: {k}"));
                    }
                }
            }
            if let Some(props) = props {
                for (k, v) in obj {
                    if let Some(sc) = props.get(k) {
                        validate(v, sc)?
                    }
                }
            }
        }
        Some("string") => {
            let v = value.as_str().ok_or("参数必须是string")?;
            if schema["minLength"]
                .as_u64()
                .is_some_and(|n| v.chars().count() < (n as usize))
                || schema["maxLength"]
                    .as_u64()
                    .is_some_and(|n| v.chars().count() > (n as usize))
            {
                return Err("字符串长度不符合要求".into());
            }
        }
        Some("integer") => {
            if value.as_u64().is_none() {
                return Err("参数必须是非负integer".into());
            }
        }
        Some("number") => {
            if value.as_f64().is_none() {
                return Err("参数必须是number".into());
            }
        }
        Some("boolean") => {
            if !value.is_boolean() {
                return Err("参数必须是boolean".into());
            }
        }
        Some("array") => {
            let a = value.as_array().ok_or("参数必须是array")?;
            if schema["minItems"]
                .as_u64()
                .is_some_and(|n| a.len() < (n as usize))
                || schema["maxItems"]
                    .as_u64()
                    .is_some_and(|n| a.len() > (n as usize))
            {
                return Err("数组长度不符合要求".into());
            }
            for v in a {
                validate(v, &schema["items"])?
            }
        }
        _ => {}
    }
    if let Some(e) = schema["enum"].as_array() {
        if !e.contains(value) {
            return Err("参数不在允许值中".into());
        }
    }
    if let Some(n) = value.as_f64() {
        if schema["exclusiveMinimum"].as_f64().is_some_and(|m| n <= m)
            || schema["minimum"].as_f64().is_some_and(|m| n < m)
            || schema["maximum"].as_f64().is_some_and(|m| n > m)
        {
            return Err("参数超出范围".into());
        }
    }
    if let Some(one) = schema["oneOf"].as_array() {
        if one.iter().filter(|s| validate(value, s).is_ok()).count() != 1 {
            return Err("参数必须匹配一种来源".into());
        }
    }
    Ok(())
}
fn fingerprint(l: &Value) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(l["features"].to_string().as_bytes()))
}
fn source(m: &GisMcp, v: &Value) -> Result<(Vec<Value>, Vec<(String, String)>), String> {
    let obj = v.as_object().ok_or("source必须为object")?;
    if let Some(id) = v["resultId"].as_str() {
        if obj.len() != 1 {
            return Err("resultId不接受其他参数".into());
        }
        let i = m.inner.lock().unwrap();
        let r = i.results.get(id).ok_or("缓存不存在或已过期")?;
        if !r.publishable || stale(&i, r) || r.created.elapsed() >= Duration::from_secs(1800) {
            return Err("缓存不是矢量结果或已过期，请重新分析".into());
        }
        return Ok((r.features.clone(), r.versions.clone()));
    }
    if let Some(id) = v["layerId"].as_str() {
        if obj.len() != 1 {
            return Err("layerId来源不接受其他参数".into());
        }
        let i = m.inner.lock().unwrap();
        let l = i
            .layers
            .iter()
            .find(|l| l["id"] == id)
            .ok_or("图层不存在")?;
        Ok((
            l["features"].as_array().ok_or("无效图层")?.clone(),
            vec![(id.into(), fingerprint(l))],
        ))
    } else if let Some(path) = v["path"].as_str() {
        for k in obj.keys() {
            if !["path", "crs", "wktField", "xField", "yField"].contains(&k.as_str()) {
                return Err("未知文件来源参数".into());
            }
        }
        let grants = m.inner.lock().unwrap().grants.clone();
        Ok((super::vector_files::load(path, v, &grants)?, vec![]))
    } else {
        Err("source需要layerId或path".into())
    }
}
fn cache(
    m: &GisMcp,
    features: Vec<Value>,
    summary: Value,
    versions: Vec<(String, String)>,
    generation: u64,
    publishable: bool,
) -> Result<Value, String> {
    if features.len() > 100_000 {
        return Err("结果超过100000要素".into());
    }
    let mut i = m.inner.lock().unwrap();
    if i.generation != generation {
        return Err("会话已停止或授权已撤销，请重新执行".into());
    }
    let bytes =
        features.iter().map(|f| f.to_string().len()).sum::<usize>() + summary.to_string().len();
    i.results
        .retain(|_, r| r.created.elapsed() < Duration::from_secs(1800));
    if i.results.len() >= 20
        || i.results.values().map(|r| r.features.len()).sum::<usize>() + features.len() > 200_000
        || i.results.values().map(|r| r.bytes).sum::<usize>() + bytes > 100 * 1024 * 1024
    {
        return Err("结果缓存已满，请关闭重启MCP清理".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let result = json!({"resultId":id,"summary":compact_summary(&summary),"featureCount":features.len(),"sample":bounded_sample(&features)});
    i.results.insert(
        id,
        Cached {
            publishable,
            bytes,
            features,
            summary,
            created: Instant::now(),
            versions,
            published: false,
        },
    );
    Ok(result)
}
#[cfg(test)]
fn call(m: &GisMcp, name: &str, args: &Value) -> Result<Value, String> {
    let generation = m.inner.lock().unwrap().generation;
    call_expected(m, name, args, generation)
}
fn call_expected(m: &GisMcp, name: &str, args: &Value, generation: u64) -> Result<Value, String> {
    if m.inner.lock().unwrap().generation != generation {
        return Err("会话授权已改变".into());
    }
    let d = definitions()
        .into_iter()
        .find(|d| d["name"] == name)
        .ok_or("未知工具")?;
    validate(args, &d["inputSchema"])?;
    {
        let mut i = m.inner.lock().unwrap();
        i.results
            .retain(|_, r| r.created.elapsed() < Duration::from_secs(1800));
    }
    match name {
        "list_layers" => {
            let i = m.inner.lock().unwrap();
            Ok(
                json!({"activeLayerId":i.active,"layers":i.layers.iter().map(|l|json!({"id":l["id"],"name":l["name"],"featureCount":l["features"].as_array().map(Vec::len),"version":fingerprint(l)})).collect::<Vec<_>>()}),
            )
        }
        "describe_layer" | "read_features" => {
            let i = m.inner.lock().unwrap();
            let l = i
                .layers
                .iter()
                .find(|l| l["id"] == args["layerId"])
                .ok_or("图层不存在")?;
            let f = l["features"].as_array().ok_or("无效图层")?;
            if name == "describe_layer" {
                let mut fields = std::collections::BTreeSet::new();
                for v in f {
                    if let Some(p) = v["properties"].as_object() {
                        fields.extend(p.keys().cloned());
                    }
                }
                Ok(
                    json!({"id":l["id"],"name":l["name"],"featureCount":f.len(),"fields":fields,"version":fingerprint(l)}),
                )
            } else {
                Ok(page(f, args, json!({"version":fingerprint(l)})))
            }
        }
        "load_vector_file" => {
            let grants = m.inner.lock().unwrap().grants.clone();
            let f = super::vector_files::load(args["path"].as_str().unwrap(), args, &grants)?;
            let count = f.len();
            cache(
                m,
                f,
                json!({"operation":name,"featureCount":count}),
                vec![],
                generation,
                true,
            )
        }
        "read_result" => {
            let i = m.inner.lock().unwrap();
            let r = i
                .results
                .get(args["resultId"].as_str().unwrap())
                .ok_or("结果不存在或已过期")?;
            if let Some(issues) = r.summary["issues"].as_array() {
                let offset = args["offset"].as_u64().unwrap_or(0) as usize;
                let limit = args["limit"].as_u64().unwrap_or(100) as usize;
                let items = bounded_sample(
                    &issues
                        .iter()
                        .skip(offset)
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>(),
                );
                return Ok(
                    json!({"summary":compact_summary(&r.summary),"total":issues.len(),"offset":offset,"issues":items,"stale":stale(&i,r)}),
                );
            }
            Ok(page(
                &r.features,
                args,
                json!({"summary":compact_summary(&r.summary),"stale":stale(&i,r)}),
            ))
        }
        "publish_result" => {
            let mut i = m.inner.lock().unwrap();
            let id = args["resultId"].as_str().unwrap();
            let r = i.results.get(id).ok_or("结果不存在或已过期")?;
            if i.generation != generation {
                return Err("会话授权已改变".into());
            }
            if !r.publishable {
                return Err("报告结果不能发布为矢量图层".into());
            }
            if stale(&i, r) {
                return Err("源图层已改变，请重新分析后发布".into());
            }
            if r.published {
                return Ok(json!({"published":true,"alreadyPublished":true}));
            }
            if i.queue.len() >= 20 {
                return Err("待导入结果已满".into());
            }
            if !r.features.is_empty() {
                super::spatial::analyze("layer_summary", &json!({}), &r.features, None)?;
            }
            let layer = json!({"id":id,"name":args["name"],"features":r.features});
            i.queue.push(layer);
            i.results.get_mut(id).unwrap().published = true;
            Ok(json!({"published":true,"resultId":id}))
        }
        _ => {
            let (s, mut versions) = source(m, &args["source"])?;
            let target = if !args["target"].is_null() {
                let (t, v) = source(m, &args["target"])?;
                versions.extend(v);
                Some(t)
            } else {
                None
            };
            let result = super::spatial::analyze(name, args, &s, target.as_deref())?;
            let features = result["features"].as_array().cloned().unwrap_or_default();
            let publishable = result["type"] == "FeatureCollection";
            let mut summary = result;
            summary.as_object_mut().map(|o| o.remove("features"));
            cache(m, features, summary, versions, generation, publishable)
        }
    }
}
fn stale(i: &Inner, r: &Cached) -> bool {
    r.versions.iter().any(|(id, v)| {
        !i.layers
            .iter()
            .any(|l| l["id"] == *id && fingerprint(l) == *v)
    })
}
fn bounded_sample(features: &[Value]) -> Vec<Value> {
    let mut bytes = 0;
    features
        .iter()
        .take(100)
        .take_while(|f| {
            bytes += f.to_string().len();
            bytes <= 512 * 1024
        })
        .cloned()
        .collect()
}
fn compact_summary(summary: &Value) -> Value {
    let mut v = summary.clone();
    if let Some(issues) = v["issues"].as_array() {
        let count = issues.len();
        let sample = bounded_sample(issues);
        v["issueCount"] = json!(count);
        v["issues"] = json!(sample);
    }
    v
}
fn page(f: &[Value], args: &Value, mut extra: Value) -> Value {
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(100).min(100) as usize;
    extra["total"] = json!(f.len());
    extra["offset"] = json!(offset);
    extra["features"] = json!(bounded_sample(
        &f.iter()
            .skip(offset)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
    ));
    extra
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn concurrent_enable_keeps_one_server_and_stop_cancels_pending_start() {
        let m = GisMcp::default();
        let a = m.start_generation().unwrap();
        let b = m.start_generation().unwrap();
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unused = second.local_addr().unwrap();
        m.install_listener(first, a).unwrap();
        let before = m.access().unwrap();
        m.install_listener(second, b).unwrap();
        assert_eq!(m.access().unwrap(), before);
        assert!(tokio::net::TcpStream::connect(unused).await.is_err());
        m.shutdown();
        let generation = m.start_generation().unwrap();
        let pending = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        m.shutdown();
        assert!(m.install_listener(pending, generation).is_err());
        assert!(!m.status().enabled);
    }
    #[test]
    fn result_source_schema_and_chain_are_validated() {
        let m = GisMcp::default();
        let layer = json!({"id":"point","name":"point","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[116.,39.]},"properties":{}}]});
        m.inner.lock().unwrap().layers.push(layer);
        let buffer = call(
            &m,
            "buffer",
            &json!({"source":{"layerId":"point"},"distanceMeters":100.}),
        )
        .unwrap();
        let next = call(
            &m,
            "buffer",
            &json!({"source":{"resultId":buffer["resultId"]},"distanceMeters":10.}),
        )
        .unwrap();
        assert_eq!(next["featureCount"], 1);
        assert!(call(
            &m,
            "buffer",
            &json!({"source":{"resultId":buffer["resultId"],"path":"bad"},"distanceMeters":10.})
        )
        .is_err());
        m.inner.lock().unwrap().layers[0]["features"][0]["geometry"]["coordinates"] =
            json!([117., 39.]);
        assert!(call(
            &m,
            "buffer",
            &json!({"source":{"resultId":buffer["resultId"]},"distanceMeters":10.})
        )
        .is_err());
    }
    #[test]
    fn revocation_prevents_inflight_cache_and_bounds_audit() {
        let m = GisMcp::default();
        m.shutdown();
        assert!(cache(&m, vec![], json!({}), vec![], 0, true).is_err());
        for _ in 0..220 {
            m.log("secret-in-tool-name", false);
        }
        let i = m.inner.lock().unwrap();
        assert_eq!(i.audit.len(), 200);
        assert!(!i
            .audit
            .iter()
            .any(|v| v.to_string().contains("secret-in-tool-name")));
    }
    #[test]
    fn rejects_unknown_and_limits() {
        assert!(call(&GisMcp::default(), "shell", &json!({})).is_err());
        assert!(call(
            &GisMcp::default(),
            "list_layers",
            &json!({"token":"secret"})
        )
        .is_err());
        assert!(validate(&json!({"limit":101}), &definitions()[2]["inputSchema"]).is_err());
    }
    #[test]
    fn publication_is_independent_idempotent_and_fresh() {
        let m = GisMcp::default();
        let layer = json!({"id":"a","name":"a","features":[]});
        m.inner.lock().unwrap().layers.push(layer.clone());
        let c = cache(
            &m,
            vec![],
            json!({}),
            vec![("a".into(), fingerprint(&layer))],
            0,
            true,
        )
        .unwrap();
        let args = json!({"resultId":c["resultId"],"name":"new"});
        call(&m, "publish_result", &args).unwrap();
        call(&m, "publish_result", &args).unwrap();
        assert_eq!(m.inner.lock().unwrap().queue.len(), 1);
        m.inner.lock().unwrap().layers[0]["features"] = json!([{"type":"Feature"}]);
        assert!(call(&m, "publish_result", &args).is_err());
    }
    #[tokio::test]
    async fn http_checks_auth_origin_and_initializes() {
        let m = GisMcp::default();
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = l.local_addr().unwrap();
        {
            let mut i = m.inner.lock().unwrap();
            i.endpoint = Some(format!("http://{address}/mcp"));
            i.token = Some("test-secret".into());
        }
        let h = tokio::spawn(async move { axum::serve(l, router(m)).await.unwrap() });
        async fn request(address: std::net::SocketAddr, headers: &str) -> String {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
            let mut s = tokio::net::TcpStream::connect(address).await.unwrap();
            s.write_all(format!("POST /mcp HTTP/1.1\r\nHost: {address}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        }
        assert!(request(address, "").await.contains("401"));
        assert!(request(
            address,
            "Authorization: Bearer test-secret\r\nOrigin: https://evil.test\r\n"
        )
        .await
        .contains("403"));
        assert!(request(address, "Authorization: Bearer test-secret\r\n")
            .await
            .contains("2025-11-25"));
        h.abort();
    }
}
