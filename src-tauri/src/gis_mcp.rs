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
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;
use tokio::{sync::Semaphore, task::JoinHandle};
#[derive(Clone)]
pub struct GisMcp {
    inner: Arc<Mutex<Inner>>,
    start_lock: Arc<tokio::sync::Mutex<()>>,
    sync_lock: Arc<tokio::sync::Mutex<()>>,
    instance_id: Arc<str>,
}
impl Default for GisMcp {
    fn default() -> Self {
        Self { inner: Arc::default(), start_lock: Arc::default(), sync_lock: Arc::default(), instance_id: uuid::Uuid::new_v4().to_string().into() }
    }
}
#[derive(Default)]
struct Inner {
    generation: u64,
    endpoint: Option<String>,
    token: Option<String>,
    server: Option<JoinHandle<()>>,
    layers: Vec<Arc<LayerSnapshot>>,
    active: Option<String>,
    startup_error: Option<String>,
    sync_error: Option<String>,
    results: HashMap<String, Cached>,
    queue: Vec<Publication>,
    queue_bytes: usize,
    audit: VecDeque<Value>,
}
#[derive(Clone)]
struct Cached {
    publishable: bool,
    bytes: usize,
    features: Arc<Vec<Value>>,
    summary: Arc<Value>,
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
    startup_error: Option<String>,
    headers_helper: Option<String>,
}
impl GisMcp {
    fn owner(&self, generation: u64) -> String { format!("mcp:{}:{generation}", self.instance_id) }
    #[cfg(test)]
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
        external_access: bool,
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
        let token = if external_access { crate::mcp_credentials::load_or_create()? }
            else { uuid::Uuid::new_v4().to_string() };
        i.startup_error = None;
        i.endpoint = Some(endpoint);
        i.token = Some(token);
        let app = router(self.clone(), generation);
        i.server = Some(tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        }));
        Ok(())
    }
    pub async fn enable(&self) -> Result<(), String> {
        self.enable_at("127.0.0.1:9420", true).await
    }
    async fn enable_at(&self, address: &str, external_access: bool) -> Result<(), String> {
        // 在排队前绑定请求代次，停止服务可取消已排队的启动。
        let generation = self.inner.lock().unwrap().generation;
        let _start = self.start_lock.lock().await;
        {
            let i = self.inner.lock().unwrap();
            if i.generation != generation { return Err("MCP 启动已取消".into()); }
            if i.server.is_some() { return Ok(()); }
        }
        let result = async {
            let listener = tokio::net::TcpListener::bind(address)
                .await.map_err(|_| "MCP 启动失败：本机端口 9420 不可用，请检查其他 zGIS 实例或端口占用".to_string())?;
            self.install_listener(listener, generation, external_access)
        }.await;
        if let Err(error) = &result {
            let mut i = self.inner.lock().unwrap();
            if i.generation == generation { i.startup_error = Some(error.clone()); }
        }
        result
    }
    pub fn access(&self) -> Result<(String, String), String> {
        let i = self.inner.lock().unwrap();
        Ok((
            i.endpoint.clone().ok_or("MCP未启动")?,
            i.token.clone().ok_or("MCP未启动")?,
        ))
    }
    pub fn shutdown(&self) {
        let _ = self.stop_listener();
    }
    pub async fn disable(&self) {
        let server = self.stop_listener();
        let _start = self.start_lock.lock().await;
        if let Some(server) = server {
            // abort 只请求取消；等待任务退出后才允许同端口重新启动。
            let _ = server.await;
        }
    }
    fn stop_listener(&self) -> Option<JoinHandle<()>> {
        let mut i = self.inner.lock().unwrap();
        crate::analysis_runtime::global().cancel_owner(&self.owner(i.generation));
        i.generation += 1;
        let server = i.server.take();
        if let Some(h) = &server {
            h.abort();
        }
        i.endpoint = None;
        i.token = None;
        let results = std::mem::take(&mut i.results);
        // Accepted publications survive transport restarts until the desktop acknowledges them.
        i.startup_error = None;
        drop(i);
        drop(results);
        server
    }
    fn status(&self) -> McpStatus {
        let i = self.inner.lock().unwrap();
        McpStatus {
            enabled: i.server.is_some(),
            endpoint: i.endpoint.clone(),
            token: i.token.clone(),
            startup_error: i.startup_error.clone(),
            headers_helper: None,
        }
    }
    fn client_status(&self, app: &tauri::AppHandle) -> McpStatus {
        let mut status = self.status();
        status.headers_helper = app.path().resource_dir().ok().map(|dir| {
            #[cfg(target_os = "macos")]
            { macos_headers_helper(&dir.join("mcp-headers-macos.sh")) }
            #[cfg(not(target_os = "macos"))]
            format!("pwsh -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{}\"", dir.join("mcp-headers.ps1").display())
        });
        status
    }
    fn log(&self, name: &str, ok: bool) {
        let safe_name = if definition_catalog().iter().any(|d| d["name"] == name)
            || ["http_host_check", "http_auth_check", "http_origin_check", "notifications/cancelled"].contains(&name)
        {
            name
        } else {
            "unknown_tool"
        };
        let mut i = self.inner.lock().unwrap();
        i.audit.push_back(json!({"tool":safe_name,"risk":match name {"publish_result"=>"local_layer_add","release_result"=>"transient_cache_release",_=>"read_only"},"affectedDomain":if name=="release_result"{"analysis_cache"}else{"gis"},"status":if ok{"ok"}else{"error"},"summary":if ok{"完成"}else{"拒绝或执行失败"}}));
        while i.audit.len() > 200 {
            i.audit.pop_front();
        }
    }
}
#[tauri::command]
pub fn gis_mcp_status(app: tauri::AppHandle, state: tauri::State<'_, GisMcp>) -> McpStatus {
    state.client_status(&app)
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
        state.disable().await;
        return Ok(state.client_status(&app));
    }
    state.enable().await?;
    Ok(state.client_status(&app))
}
#[tauri::command]
pub async fn gis_workspace_sync(
    layers: Vec<Value>,
    active_layer_id: Option<String>,
    incremental: Option<bool>,
    removed_layer_ids: Option<Vec<String>>,
    state: tauri::State<'_, GisMcp>,
) -> Result<(), String> {
    let m = state.inner().clone();
    let order = m.sync_lock.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _order = order;
        sync_workspace(&m, layers, active_layer_id, incremental.unwrap_or(false), removed_layer_ids.unwrap_or_default())
    })
        .await.map_err(|_| "工作区同步失败".to_owned())?
}
fn sync_workspace(m: &GisMcp, layers: Vec<Value>, active: Option<String>, incremental: bool, removed: Vec<String>) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        if layers.len() > 100 || removed.len() > 100 { return Err("最多同步100图层".into()); }
        super::bounded_json_size(&layers, 100 * 1024 * 1024).map_err(|_| "同步图层总大小超过100MB")?;
        let mut ids = std::collections::HashSet::new();
        let mut count = 0;
        for l in &layers {
            let id = l["id"].as_str().ok_or("无效图层id")?;
            if !ids.insert(id) || removed.iter().any(|x| x == id) { return Err("同步图层标识重复或同时删除".into()); }
            if !l["name"].is_string() { return Err("无效图层名称".into()); }
            let fs = l["features"].as_array().ok_or("缺少features")?;
            count += fs.len();
            for f in fs {
                if f["type"] != "Feature" { return Err("无效要素".into()); }
                super::vector_files::validate_geometry(&f["geometry"])?;
            }
        }
        if count > 100_000 { return Err("最多同步100000要素".into()); }
        let updates = layers.into_iter().map(LayerSnapshot::from_value).collect::<Result<Vec<_>, _>>()?;
        let mut i = m.inner.lock().unwrap();
        let mut next = if incremental { i.layers.clone() } else { Vec::new() };
        next.retain(|l| !removed.contains(&l.id));
        for layer in updates {
            if let Some(index) = next.iter().position(|l| l.id == layer.id) { next[index] = layer; }
            else { next.push(layer); }
        }
        if next.len() > 100 || next.iter().map(|l| l.features.len()).sum::<usize>() > 100_000 { return Err("工作区超过100图层或100000要素".into()); }
        if next.iter().map(|l| l.bytes).sum::<usize>().saturating_add(next.len()+2) > 100*1024*1024 { return Err("同步图层总大小超过100MB".into()); }
        let old = std::mem::replace(&mut i.layers, next);
        i.active = active;
        i.sync_error = None;
        drop(i); drop(old);
        Ok(())
    })();
    if let Err(error) = &result { m.inner.lock().unwrap().sync_error = Some(error.clone()); }
    result
}
#[tauri::command]
pub fn gis_results_drain(state: tauri::State<'_, GisMcp>) -> Vec<Value> {
    pending_publications(&state)
}
fn pending_publications(state: &GisMcp) -> Vec<Value> {
    let pending = state.inner.lock().unwrap().queue.clone();
    pending.into_iter().map(|p| json!({"id":p.id,"name":p.name,"features":p.features.as_ref()})).collect()
}
#[tauri::command]
pub fn gis_results_ack(state: tauri::State<'_, GisMcp>, result_ids: Vec<String>) -> Result<(), String> {
    acknowledge_publications(&state, &result_ids)
}
fn acknowledge_publications(state: &GisMcp, ids: &[String]) -> Result<(), String> {
    if ids.len() > 20 || ids.iter().any(|id| id.len() > 100) { return Err("发布确认参数超过上限".into()); }
    let mut inner = state.inner.lock().unwrap();
    let mut removed = Vec::new();
    let mut index = 0;
    while index < inner.queue.len() {
        if ids.contains(&inner.queue[index].id) {
            let item = inner.queue.remove(index);
            inner.queue_bytes = inner.queue_bytes.saturating_sub(item.bytes);
            removed.push(item);
        } else { index += 1; }
    }
    drop(inner);
    drop(removed);
    Ok(())
}
#[tauri::command]
pub fn gis_mcp_audit(state: tauri::State<'_, GisMcp>) -> Vec<Value> {
    state.inner.lock().unwrap().audit.iter().cloned().collect()
}
#[derive(Clone)]
struct HttpState {
    mcp: GisMcp,
    limit: Arc<Semaphore>,
    generation: u64,
}
struct LayerSnapshot {
    id: String,
    name: String,
    features: Arc<Vec<Value>>,
    version: String,
    fields: std::collections::BTreeSet<String>,
    bytes: usize,
}
impl LayerSnapshot {
    fn from_value(mut value: Value) -> Result<Arc<Self>, String> {
        let bytes = super::bounded_json_size(&value, 100*1024*1024).map_err(|_| "同步图层总大小超过100MB")?;
        let version = fingerprint(&value);
        let id = value["id"].as_str().ok_or("无效图层id")?.to_owned();
        let name = value["name"].as_str().ok_or("无效图层名称")?.to_owned();
        let Some(Value::Array(features)) = value.as_object_mut().and_then(|o| o.remove("features")) else {
            return Err("缺少features".into());
        };
        let fields = features.iter().filter_map(|f| f["properties"].as_object())
            .flat_map(|p| p.keys().cloned()).collect();
        Ok(Arc::new(Self { id, name, features: Arc::new(features), version, fields, bytes }))
    }
    #[cfg(test)]
    fn value(&self) -> Value {
        json!({"id":self.id,"name":self.name,"features":self.features.as_ref()})
    }
}
#[derive(Clone, Debug, PartialEq)]
struct Publication {
    id: String,
    name: String,
    features: Arc<Vec<Value>>,
    bytes: usize,
}
#[cfg(any(target_os = "macos", test))]
fn macos_headers_helper(path: &std::path::Path) -> String {
    // 命令供外部客户端执行；单引号保护空格、$、反引号和其他 shell 元字符。
    let quoted = path.to_string_lossy().replace('\'', "'\"'\"'");
    format!("/bin/sh '{quoted}'")
}
#[cfg(test)]
mod macos_helper_tests {
    #[test]
    fn helper_path_is_quoted_without_shell_expansion() {
        let command = super::macos_headers_helper(std::path::Path::new("/Applications/zGIS user's $(touch test) `id`/helper.sh"));
        assert_eq!(command, "/bin/sh '/Applications/zGIS user'\"'\"'s $(touch test) `id`/helper.sh'");
    }
}
fn router(mcp: GisMcp, generation: u64) -> Router {
    Router::new()
        .route("/mcp", post(handle))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(HttpState {
            mcp,
            // Transport/control capacity is independent of the two global computation slots.
            limit: Arc::new(Semaphore::new(8)),
            generation,
        })
}
async fn handle(
    State(s): State<HttpState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<(StatusCode, Json<Value>), StatusCode> {
    let (endpoint, token, generation) = {
        let i = s.mcp.inner.lock().unwrap();
        // 已建立的 HTTP keepalive 属于旧服务，不能继承重启后的会话授权。
        if i.generation != s.generation { return Err(StatusCode::SERVICE_UNAVAILABLE); }
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
        if method == "notifications/cancelled" {
            let target = request_job_id(&req["params"]["requestId"]).ok_or(StatusCode::BAD_REQUEST)?;
            crate::analysis_runtime::global().cancel(&s.mcp.owner(generation), &target);
            s.mcp.log(method, true);
        }
        if method.starts_with("notifications/") {
            return Ok((StatusCode::ACCEPTED, Json(Value::Null)));
        }
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = id.unwrap();
    let job_id = request_job_id(&id).ok_or(StatusCode::BAD_REQUEST)?;
    let result = match method {
        "initialize" => Ok(
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"zgis","version":env!("CARGO_PKG_VERSION")},"instructions":"zGIS 内部图层操作使用本 MCP；外部 GeoJSON、SHP、WKT CSV 等空间文件优先使用本 MCP，访问权限由调用 Agent 判断，zGIS 不校验文件访问授权。PostGIS 按场景选择：已加载图层用本 MCP 分析；直接数据库操作使用 DBX，本 MCP 不读写数据库。所有工作几何为 WGS84，分析结果用 publish_result 加入独立未保存图层。"}),
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
            let heavy = !matches!(name.as_str(), "list_layers" | "describe_layer" | "read_features" | "read_result" | "list_results" | "release_result");
            let owner = m.owner(generation);
            let job = if heavy { Some(crate::analysis_runtime::global().start(&owner, &job_id)) } else { None };
            let owns_job = matches!(&job, Some(Ok(_)));
            let mut cancellation = CancelHttpJob { owner, id:job_id, armed:owns_job };
            let r = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                match job {
                    Some(Ok(job)) => job.run(|| call_expected(&m, &n, &args, generation)),
                    Some(Err(error)) => Err(error),
                    None => call_expected(&m, &n, &args, generation),
                }
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            cancellation.armed = false;
            s.mcp.log(&name, r.is_ok());
            Ok(match r {
                Ok(v) => {
                    json!({"content":[{"type":"text","text":v.to_string()}],"structuredContent":v,"isError":false})
                }
                Err(e) => {
                    let code = if e.starts_with("RESULT_ITEM_TOO_LARGE:") { "RESULT_ITEM_TOO_LARGE" }
                        else if e.starts_with("RESULT_CACHE_FULL:") { "RESULT_CACHE_FULL" }
                        else if e.starts_with("ANALYSIS_CANCELLED:") { "ANALYSIS_CANCELLED" }
                        else if e.starts_with("ANALYSIS_TIMEOUT:") { "ANALYSIS_TIMEOUT" }
                        else if e.starts_with("ANALYSIS_BUSY:") { "ANALYSIS_BUSY" }
                        else if e.starts_with("ANALYSIS_DUPLICATE:") { "ANALYSIS_DUPLICATE" }
                        else { "TOOL_ERROR" };
                    json!({"content":[{"type":"text","text":e}],"structuredContent":{"error":{"code":code,"message":e}},"isError":true})
                },
            })
        }
        _ => Err("未知JSON-RPC方法".to_string()),
    };
    if s.mcp.inner.lock().unwrap().generation != generation { return Err(StatusCode::SERVICE_UNAVAILABLE); }
    Ok((
        StatusCode::OK,
        Json(match result {
            Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
            Err(e) => json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":e}}),
        }),
    ))
}
fn request_job_id(id: &Value) -> Option<String> {
    if !(id.is_string() || id.is_number()) { return None; }
    let id = id.to_string();
    (id.len() <= 200).then_some(id)
}
struct CancelHttpJob { owner: String, id: String, armed: bool }
impl Drop for CancelHttpJob {
    fn drop(&mut self) {
        if self.armed { crate::analysis_runtime::global().cancel(&self.owner, &self.id); }
    }
}
fn def(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},"annotations":{"readOnlyHint":!matches!(name,"publish_result"|"release_result"),"destructiveHint":name=="release_result","idempotentHint":true,"openWorldHint":!matches!(name,"list_layers"|"describe_layer"|"read_features"|"read_result"|"publish_result"|"list_results"|"release_result")}})
}
#[tauri::command]
pub fn gis_mcp_tool_catalog() -> Vec<Value> {
    definitions()
}

pub fn definitions() -> Vec<Value> {
    definition_catalog().to_vec()
}
fn definition_catalog() -> &'static [Value] {
    static CATALOG: OnceLock<Vec<Value>> = OnceLock::new();
    CATALOG.get_or_init(build_definitions)
}
fn build_definitions() -> Vec<Value> {
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
            "分页读取当前图层（最多100条）；properties选择属性字段，includeGeometry=false省略几何；按nextOffset推进，超大单条明确报错",
            page_schema("layerId"),
            &["layerId"],
        ),
        def(
            "load_vector_file",
            "读取外部矢量文件并缓存，访问授权由调用Agent负责；支持GeoJSON/CSV/SHP/ZIP；WGS84 XY/XYZ（高程保留，空间分析按 XY）",
            json!({"path":{"type":"string"},"crs":{"type":"string","enum":["EPSG:4326","EPSG:4490","EPSG:3857"]},"wktField":{"type":"string"},"xField":{"type":"string"},"yField":{"type":"string"}}),
            &["path"],
        ),
        def(
            "read_result",
            "分页读取分析缓存或质量问题（最多100条）；要素可选择properties及includeGeometry；按nextOffset推进，超大单条明确报错",
            page_schema("resultId"),
            &["resultId"],
        ),
        def(
            "publish_result",
            "将结果作为独立新图层加入zGIS，不修改源图层，不写文件",
            json!({"resultId":{"type":"string"},"name":{"type":"string","minLength":1,"maxLength":100}}),
            &["resultId", "name"],
        ),
    ];
    d.push(def("list_results", "列举未过期分析缓存、剩余预算及到期秒数；不读取源文件、不占用新缓存", json!({}), &[]));
    d.push(def("release_result", "仅释放指定resultId的临时分析缓存；不可撤销，后续引用失效；不删除已发布图层或待导入副本，重复释放安全", json!({"resultId":{"type":"string","minLength":1,"maxLength":100}}), &["resultId"]));
    let mut spatial = analysis_definitions();
    for tool in &mut spatial {
        tool["annotations"]["openWorldHint"] = json!(true);
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
// 来源引用属于 MCP 宿主；核心目录仅定义纯分析参数。
fn analysis_definitions() -> Vec<Value> {
    let reference = json!({"oneOf":[{"type":"object","properties":{"layerId":{"type":"string","minLength":1}},"required":["layerId"],"additionalProperties":false},{"type":"object","properties":{"path":{"type":"string","minLength":1},"crs":{"type":"string","enum":["EPSG:4326","EPSG:4490","EPSG:3857"]},"wktField":{"type":"string","minLength":1},"xField":{"type":"string","minLength":1},"yField":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}]});
    spatial_core::registry::ANALYSES.iter().map(|spec| {
        let mut schema=spec.parameter_schema();
        schema["properties"]["source"]=reference.clone();
        let mut required=vec![json!("source")];
        if spec.target != spatial_core::registry::TargetRequirement::None {
            schema["properties"]["target"]=reference.clone();
            if spec.target == spatial_core::registry::TargetRequirement::Required {required.push(json!("target"));}
        }
        required.extend(schema["required"].as_array().unwrap().iter().cloned());
        schema["required"]=json!(required);
        json!({"name":spec.id(),"description":spec.description,"inputSchema":schema,"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})
    }).collect()
}

fn page_schema(id: &str) -> Value {
    let mut schema = json!({"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100},"properties":{"type":"array","maxItems":100,"items":{"type":"string","minLength":1,"maxLength":256}},"includeGeometry":{"type":"boolean"}});
    schema[id] = json!({"type":"string","minLength":1});
    schema
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
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    // 流式序列化进摘要，避免每次查询临时复制整层 JSON 字符串。
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, &l["features"]).expect("JSON value serialization is infallible");
    format!("{:x}", writer.0.finalize())
}
fn current_inner(m: &GisMcp, generation: u64) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
    let inner = m.inner.lock().map_err(|_| "MCP状态不可用")?;
    if inner.generation != generation { return Err("会话授权已改变".into()); }
    Ok(inner)
}
type SourceSnapshot = (Arc<Vec<Value>>, Vec<(String, String)>);
fn source(m: &GisMcp, v: &Value, generation: u64) -> Result<SourceSnapshot, String> {
    let obj = v.as_object().ok_or("source必须为object")?;
    if let Some(id) = v["resultId"].as_str() {
        if obj.len() != 1 {
            return Err("resultId不接受其他参数".into());
        }
        let i = current_inner(m, generation)?;
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
        let i = current_inner(m, generation)?;
        if i.sync_error.is_some() { return Err("工作区同步失败，旧图层快照不可用于新分析".into()); }
        let l = i
            .layers
            .iter()
            .find(|l| l.id == id)
            .ok_or("图层不存在")?;
        Ok((
            l.features.clone(),
            vec![(id.into(), l.version.clone())],
        ))
    } else if let Some(path) = v["path"].as_str() {
        for k in obj.keys() {
            if !["path", "crs", "wktField", "xField", "yField"].contains(&k.as_str()) {
                return Err("未知文件来源参数".into());
            }
        }
        Ok((Arc::new(super::vector_files::load(path, v)?), vec![]))
    } else {
        Err("source需要layerId或path".into())
    }
}
fn prune_expired(m: &GisMcp) {
    let expired = {
        let mut inner = m.inner.lock().unwrap();
        let ids:Vec<_> = inner.results.iter().filter(|(_,r)| r.created.elapsed() >= Duration::from_secs(1800)).map(|(id,_)| id.clone()).collect();
        ids.into_iter().filter_map(|id| inner.results.remove(&id)).collect::<Vec<_>>()
    };
    drop(expired);
}
fn cache(
    m: &GisMcp,
    features: Vec<Value>,
    summary: Value,
    versions: Vec<(String, String)>,
    generation: u64,
    publishable: bool,
) -> Result<Value, String> {
    prune_expired(m);
    if features.len() > 100_000 {
        return Err("结果超过100000要素".into());
    }
    let feature_bytes = super::bounded_json_size(&features, 100 * 1024 * 1024)
        .map_err(|_| "结果缓存超过100MB")?;
    let bytes = feature_bytes + super::bounded_json_size(&summary, 100 * 1024 * 1024 - feature_bytes)
        .map_err(|_| "结果缓存超过100MB")?;
    let id = uuid::Uuid::new_v4().to_string();
    let sample = bounded_sample(&features);
    let result = json!({"resultId":id,"summary":compact_summary(&summary),"featureCount":features.len(),"sampleTruncated":sample.len()<features.len(),"sample":sample});
    let mut i = m.inner.lock().unwrap();
    if i.generation != generation {
        return Err("会话已停止或授权已撤销，请重新执行".into());
    }
    if i.results.len() >= 20
        || i.results.values().map(|r| r.features.len()).sum::<usize>() + features.len() > 200_000
        || i.results.values().map(|r| r.bytes).sum::<usize>() + bytes > 100 * 1024 * 1024
    {
        return Err("RESULT_CACHE_FULL: 结果缓存已满，请使用list_results查看并通过release_result释放不再需要的中间结果".into());
    }
    crate::analysis_runtime::commit_checkpoint()?;
    i.results.insert(
        id,
        Cached {
            publishable,
            bytes,
            features: Arc::new(features),
            summary: Arc::new(summary),
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
    let d = definition_catalog()
        .iter()
        .find(|d| d["name"] == name)
        .ok_or("未知工具")?;
    validate(args, &d["inputSchema"])?;
    prune_expired(m);
    match name {
        "list_results" => {
            let i = current_inner(m, generation)?;
            let used_bytes: usize = i.results.values().map(|r| r.bytes).sum();
            let used_features: usize = i.results.values().map(|r| r.features.len()).sum();
            let mut results: Vec<Value> = i.results.iter().map(|(id, r)| json!({"resultId":id,"featureCount":r.features.len(),"bytes":r.bytes,"expiresInSeconds":1800u64.saturating_sub(r.created.elapsed().as_secs()),"publishable":r.publishable,"published":r.published,"stale":stale(&i,r)})).collect();
            results.sort_by(|a,b| a["resultId"].as_str().cmp(&b["resultId"].as_str()));
            Ok(json!({"results":results,"remaining":{"results":20usize.saturating_sub(i.results.len()),"features":200_000usize.saturating_sub(used_features),"bytes":(100*1024*1024usize).saturating_sub(used_bytes)}}))
        }
        "release_result" => {
            let mut i = current_inner(m, generation)?;
            if i.generation != generation { return Err("会话授权已改变".into()); }
            let id = args["resultId"].as_str().unwrap();
            let removed = i.results.remove(id);
            drop(i);
            Ok(json!({"resultId":id,"released":removed.is_some(),"freedBytes":removed.map(|r|r.bytes).unwrap_or(0)}))
        }
        "list_layers" => {
            let i = current_inner(m, generation)?;
            Ok(json!({"activeLayerId":i.active,"synchronized":i.sync_error.is_none(),"syncError":i.sync_error,"layers":i.layers.iter().map(|l|json!({"id":l.id,"name":l.name,"featureCount":l.features.len(),"version":l.version})).collect::<Vec<_>>()}))
        }
        "describe_layer" | "read_features" => {
            let l = {
                let i = current_inner(m, generation)?;
                if i.sync_error.is_some() { return Err("工作区同步失败，请重试图层同步".into()); }
                i.layers.iter().find(|l| Some(l.id.as_str()) == args["layerId"].as_str())
                    .cloned().ok_or("图层不存在")?
            };
            if name == "describe_layer" {
                Ok(json!({"id":l.id,"name":l.name,"featureCount":l.features.len(),"fields":l.fields,"version":l.version}))
            } else {
                page(&l.features, args, json!({"version":l.version}), "features")
            }
        }
        "load_vector_file" => {
            let loaded = super::vector_files::load_with_metadata(args["path"].as_str().unwrap(), args)?;
            let count = loaded.features.len();
            cache(
                m,
                loaded.features,
                json!({"operation":name,"featureCount":count,"sourceCrs":loaded.source_crs,"workingCrs":loaded.working_crs}),
                vec![],
                generation,
                true,
            )
        }
        "read_result" => {
            let (r, is_stale) = {
                let i = current_inner(m, generation)?;
                let r = i.results.get(args["resultId"].as_str().unwrap()).ok_or("结果不存在或已过期")?;
                (r.clone(), stale(&i, r))
            };
            if let Some(issues) = r.summary["issues"].as_array() {
                let mut summary = compact_summary(&r.summary);
                summary.as_object_mut().unwrap().remove("issues");
                return page(issues, args, json!({"summary":summary,"stale":is_stale}), "issues");
            }
            page(&r.features, args, json!({"summary":compact_summary(&r.summary),"stale":is_stale}), "features")
        }
        "publish_result" => {
            let id = args["resultId"].as_str().unwrap();
            let r = {
                let i = current_inner(m, generation)?;
                let r = i.results.get(id).ok_or("结果不存在或已过期")?;
                if !r.publishable { return Err("报告结果不能发布为矢量图层".into()); }
                if stale(&i, r) { return Err("源图层已改变，请重新分析后发布".into()); }
                if r.published { return Ok(json!({"published":true,"alreadyPublished":true})); }
                r.clone()
            };
            // Potentially expensive validation never holds the metadata lock.
            if !r.features.is_empty() {
                super::spatial::analyze("layer_summary", &json!({}), &r.features, None)?;
            }
            let layer_bytes = r.bytes + args["name"].as_str().unwrap().len() + 1024;
            let mut i = current_inner(m, generation)?;
            if i.generation != generation { return Err("会话授权已改变".into()); }
            let current = i.results.get(id).ok_or("结果不存在或已过期")?;
            if current.created.elapsed() >= Duration::from_secs(1800) { return Err("结果不存在或已过期".into()); }
            if stale(&i, current) { return Err("源图层已改变，请重新分析后发布".into()); }
            if current.published { return Ok(json!({"published":true,"alreadyPublished":true})); }
            if i.queue.len() >= 20 { return Err("待导入结果已满".into()); }
            if i.queue_bytes.saturating_add(layer_bytes) > 100 * 1024 * 1024 {
                return Err("待导入结果超过100MB，请先导入已有结果".into());
            }
            crate::analysis_runtime::commit_checkpoint()?;
            i.queue.push(Publication { id:id.into(), name:args["name"].as_str().unwrap().into(), features:r.features, bytes:layer_bytes });
            i.queue_bytes += layer_bytes;
            i.results.get_mut(id).unwrap().published = true;
            Ok(json!({"published":true,"resultId":id}))
        }
        _ => {
            let (s, mut versions) = source(m, &args["source"], generation)?;
            let target = if !args["target"].is_null() {
                let (t, v) = source(m, &args["target"], generation)?;
                versions.extend(v);
                Some(t)
            } else {
                None
            };
            let mut parameters = args.clone();
            let object = parameters.as_object_mut().ok_or("参数必须为对象")?;
            object.remove("source");
            object.remove("target");
            let result = super::spatial::analyze(name, &parameters, &s, target.as_ref().map(|t| t.as_slice()))?;
            let publishable = result["type"] == "FeatureCollection";
            let mut summary = result;
            let features = match summary.as_object_mut().and_then(|o| o.remove("features")) {
                Some(Value::Array(features)) => features,
                _ => Vec::new(),
            };
            cache(m, features, summary, versions, generation, publishable)
        }
    }
}
fn stale(i: &Inner, r: &Cached) -> bool {
    if !r.versions.is_empty() && i.sync_error.is_some() { return true; }
    r.versions.iter().any(|(id, v)| {
        !i.layers
            .iter()
            .any(|l| l.id == *id && l.version == *v)
    })
}
fn bounded_sample(features: &[Value]) -> Vec<Value> {
    let mut bytes = 0;
    features
        .iter()
        .take(100)
        .take_while(|f| {
            if let Ok(size) = super::bounded_json_size(f, 512 * 1024 - bytes) {
                bytes += size;
                true
            } else { false }
        })
        .cloned()
        .collect()
}
fn compact_summary(summary: &Value) -> Value {
    let Some(object) = summary.as_object() else { return summary.clone(); };
    // issues 只复制预览，避免先克隆整份报告再截取样本。
    let mut v: serde_json::Map<String, Value> = object.iter()
        .filter(|(key, _)| key.as_str() != "issues")
        .map(|(key, value)| (key.clone(), value.clone())).collect();
    if let Some(issues) = summary["issues"].as_array() {
        let count = issues.len();
        let sample = bounded_sample(issues);
        v.insert("issueCount".into(), json!(count));
        v.insert("issues".into(), json!(sample));
    } else if let Some(issues) = object.get("issues") {
        v.insert("issues".into(), issues.clone());
    }
    Value::Object(v)
}
struct ProjectedItem<'a> { original: &'a Value, feature: bool, include_geometry: bool, fields: Option<&'a Vec<Value>> }
impl Serialize for ProjectedItem<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        struct Properties<'a>(&'a serde_json::Map<String, Value>, &'a [Value]);
        impl Serialize for Properties<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok,S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(None)?;
                for (key,value) in self.0 {
                    if self.1.iter().any(|field| field.as_str() == Some(key)) { map.serialize_entry(key,value)?; }
                }
                map.end()
            }
        }
        if !self.feature { return self.original.serialize(serializer); }
        let Some(object) = self.original.as_object() else { return self.original.serialize(serializer); };
        let mut map = serializer.serialize_map(None)?;
        for (key,value) in object {
            if !self.include_geometry && (key == "geometry" || key == "bbox") { continue; }
            if key == "properties" {
                if let (Some(fields),Some(properties)) = (self.fields,value.as_object()) {
                    map.serialize_entry(key, &Properties(properties,fields))?;
                    continue;
                }
            }
            map.serialize_entry(key,value)?;
        }
        map.end()
    }
}
fn page(f: &[Value], args: &Value, mut extra: Value, kind: &str) -> Result<Value, String> {
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(100).min(100) as usize;
    extra["total"] = json!(f.len());
    extra["offset"] = json!(offset);
    extra["resultKind"] = json!(kind);
    let include_geometry = args["includeGeometry"].as_bool().unwrap_or(true);
    let fields = args["properties"].as_array();
    if kind == "features" { extra["projection"] = json!({"includeGeometry":include_geometry,"properties":fields}); }
    let mut budget = (512 * 1024usize).saturating_sub(super::bounded_json_size(&extra, 512*1024).map_err(|_| "分页元数据超过响应上限")? + 256);
    let mut items = Vec::new();
    for (index, original) in f.iter().enumerate().skip(offset).take(limit) {
        // Count a borrowed projection before allocating; oversized items never clone a large tree.
        let view = ProjectedItem { original, feature:kind == "features", include_geometry, fields };
        match super::bounded_json_size(&view, budget.saturating_sub(1)) {
            Ok(bytes) => {
                budget = budget.saturating_sub(bytes+1);
                items.push(serde_json::to_value(&view).map_err(|_| "分页数据编码失败")?);
            }
            Err(_) if items.is_empty() => return Err(format!("RESULT_ITEM_TOO_LARGE: offset={index} 的单条记录超过512KiB响应预算；请指定properties字段或includeGeometry=false后重试")),
            Err(_) => break,
        }
    }
    let next = offset.saturating_add(items.len());
    extra["returnedCount"] = json!(items.len());
    extra["nextOffset"] = if next < f.len() { json!(next) } else { Value::Null };
    extra["hasMore"] = json!(next < f.len());
    extra["truncated"] = json!(items.len() < limit.min(f.len().saturating_sub(offset)));
    extra[kind] = json!(items);
    Ok(extra)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delta_sync_reuses_unchanged_layers_and_blocks_stale_workspace_on_failure() {
        let m=GisMcp::default();
        let a=json!({"id":"a","name":"a","features":[test_feature(0)]});
        let b=json!({"id":"b","name":"b","features":[test_feature(0)]});
        sync_workspace(&m,vec![a.clone(),b],Some("a".into()),false,vec![]).unwrap();
        let shared=m.inner.lock().unwrap().layers[0].clone();
        sync_workspace(&m,vec![],Some("b".into()),true,vec![]).unwrap();
        assert!(Arc::ptr_eq(&shared,&m.inner.lock().unwrap().layers[0]));
        assert_eq!(call(&m,"list_layers",&json!({})).unwrap()["activeLayerId"],"b");
        assert!(sync_workspace(&m,vec![json!({"id":"bad"})],None,true,vec![]).is_err());
        assert_eq!(call(&m,"list_layers",&json!({})).unwrap()["synchronized"],false);
        assert!(source(&m,&json!({"layerId":"a"}),0).is_err());
        sync_workspace(&m,vec![a],Some("a".into()),true,vec!["b".into()]).unwrap();
        assert_eq!(call(&m,"list_layers",&json!({})).unwrap()["layers"].as_array().unwrap().len(),1);
        assert!(source(&m,&json!({"layerId":"a"}),0).is_ok());
    }
    #[test]
    fn cancelled_cache_does_not_mutate_and_committed_cache_cannot_report_cancelled() {
        let m=GisMcp::default();
        let runtime=crate::analysis_runtime::AnalysisRuntime::new(1,Duration::from_secs(10));
        let job=runtime.start("test","cancel").unwrap();
        let error=job.run(|| {
            runtime.cancel("test","cancel");
            cache(&m,vec![test_feature(0)],json!({}),vec![],0,true)
        }).unwrap_err();
        assert!(error.contains("CANCELLED"));
        assert!(m.inner.lock().unwrap().results.is_empty());
        runtime.start("test","commit").unwrap().run(|| {
            let result=cache(&m,vec![test_feature(0)],json!({}),vec![],0,true)?;
            assert!(!runtime.cancel("test","commit"));
            Ok(result)
        }).unwrap();
        assert_eq!(m.inner.lock().unwrap().results.len(),1);
    }
    #[test]
    fn immutable_sources_share_storage_and_versions_change_only_with_content() {
        let m = GisMcp::default();
        let layer = json!({"id":"a","name":"old","features":[test_feature(1024)]});
        let snapshot = LayerSnapshot::from_value(layer.clone()).unwrap();
        m.inner.lock().unwrap().layers.push(snapshot.clone());
        let (features, versions) = source(&m, &json!({"layerId":"a"}), 0).unwrap();
        assert!(Arc::ptr_eq(&features, &snapshot.features));
        let mut renamed = layer.clone(); renamed["name"] = json!("new");
        assert_eq!(LayerSnapshot::from_value(renamed).unwrap().version, versions[0].1);
        let result = cache(&m, vec![test_feature(0)], json!({}), versions, 0, true).unwrap();
        let mut changed = layer; changed["features"][0]["properties"]["changed"] = json!(true);
        m.inner.lock().unwrap().layers[0] = LayerSnapshot::from_value(changed).unwrap();
        assert!(source(&m,&json!({"resultId":result["resultId"]}), 0).is_err());
        assert_eq!(features[0]["properties"]["changed"], Value::Null);
    }
    #[test]
    fn publication_retries_until_ack_even_after_cache_release() {
        let m = GisMcp::default();
        let result = cache(&m, vec![test_feature(0)], json!({}), vec![], 0, true).unwrap();
        let id = result["resultId"].as_str().unwrap().to_owned();
        call(&m,"publish_result",&json!({"resultId":id,"name":"output"})).unwrap();
        let first = pending_publications(&m);
        assert_eq!(pending_publications(&m), first, "failed IPC or WebView reload must allow redelivery");
        assert!(m.inner.lock().unwrap().queue_bytes > 0);
        call(&m,"release_result",&json!({"resultId":id})).unwrap();
        assert_eq!(pending_publications(&m), first);
        acknowledge_publications(&m, &["unrelated".into()]).unwrap();
        assert_eq!(pending_publications(&m), first);
        acknowledge_publications(&m, &[id.clone()]).unwrap();
        acknowledge_publications(&m, &[id]).unwrap();
        assert!(pending_publications(&m).is_empty());
        assert_eq!(m.inner.lock().unwrap().queue_bytes, 0);
    }
    #[tokio::test]
    async fn cancellation_notification_is_authenticated_and_scoped_to_generation() {
        let m = GisMcp::default();
        { let mut i=m.inner.lock().unwrap(); i.endpoint=Some("http://127.0.0.1:9420/mcp".into()); i.token=Some("test-only".into()); }
        let state=HttpState{mcp:m.clone(),limit:Arc::new(Semaphore::new(8)),generation:0};
        let mut headers=HeaderMap::new(); headers.insert("host","127.0.0.1:9420".parse().unwrap());
        let cancel=Bytes::from_static(br#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"job"}}"#);
        assert_eq!(handle(State(state.clone()),headers.clone(),cancel.clone()).await.unwrap_err(),StatusCode::UNAUTHORIZED);
        headers.insert("authorization","Bearer test-only".parse().unwrap());
        assert_eq!(handle(State(state.clone()),headers.clone(),cancel.clone()).await.unwrap().0,StatusCode::ACCEPTED);
        let call=Bytes::from_static(br#"{"jsonrpc":"2.0","id":"job","method":"tools/call","params":{"name":"load_vector_file","arguments":{"path":"not-read.geojson"}}}"#);
        let (_,Json(response))=handle(State(state.clone()),headers.clone(),call).await.unwrap();
        assert_eq!(response["result"]["structuredContent"]["error"]["code"],"ANALYSIS_CANCELLED");
        assert!(m.inner.lock().unwrap().results.is_empty());
        m.shutdown();
        assert_eq!(handle(State(state),headers,cancel).await.unwrap_err(),StatusCode::SERVICE_UNAVAILABLE);
    }
    #[test]
    #[ignore = "release performance baseline; prints JSON, does not mutate user data"]
    fn performance_metadata_snapshot() {
        let features:Vec<_>=(0..10000).map(|n|json!({"type":"Feature","geometry":{"type":"Point","coordinates":[n as f64/1000.,30.,1.]},"properties":{"text":"宽表属性".repeat(12)}})).collect();
        let layer=json!({"id":"bench","name":"bench","features":features});
        let m=GisMcp::default();
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(layer.clone()).unwrap());
        let mut old=Vec::new(); let mut new=Vec::new();
        for _ in 0..20 {
            let start=Instant::now(); std::hint::black_box(fingerprint(&layer)); old.push(start.elapsed().as_secs_f64()*1000.);
            let start=Instant::now(); std::hint::black_box(call(&m,"list_layers",&json!({})).unwrap()); new.push(start.elapsed().as_secs_f64()*1000.);
        }
        old.sort_by(f64::total_cmp); new.sort_by(f64::total_cmp);
        println!("{}",json!({"benchmark":"metadata-10000-features","samples":20,"baseline":"equivalent previous full-layer hash","baselineMedianMs":old[10],"snapshotMedianMs":new[10],"scope":"metadata CPU only; excludes sync, RSS, transport"}));
    }
    fn test_feature(text_bytes: usize) -> Value {
        json!({"type":"Feature","geometry":{"type":"Point","coordinates":[1,1]},"properties":{"name":"保留","large":"x".repeat(text_bytes)}})
    }
    #[test]
    fn cleaned_geometry_result_is_chainable_and_publication_keeps_source() {
        let m=GisMcp::default();
        let original=json!({"id":"dirty","name":"dirty","features":[test_feature(0),{"type":"Feature","geometry":null,"properties":{"name":"empty"}}]});
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(original.clone()).unwrap());
        assert_eq!(definitions().len(),31);
        let cleaned=call(&m,"clean_geometries",&json!({"source":{"layerId":"dirty"}})).unwrap();
        assert_eq!(cleaned["featureCount"],1);
        assert_eq!(cleaned["summary"]["analysis"]["removedCount"],1);
        let derived=call(&m,"buffer",&json!({"source":{"resultId":cleaned["resultId"]},"distanceMeters":10})).unwrap();
        call(&m,"publish_result",&json!({"resultId":derived["resultId"],"name":"clean buffer"})).unwrap();
        assert_eq!(m.inner.lock().unwrap().layers[0].value(),original);
        assert_eq!(m.inner.lock().unwrap().queue.len(),1);
        assert!(call(&m,"spatial_query",&json!({"source":{"resultId":cleaned["resultId"]},"target":{"resultId":cleaned["resultId"]},"bbox":[0,0,2,2]})).unwrap_err().contains("二选一"));
    }
    #[tokio::test]
    async fn http_external_file_pagination_and_cache_release_roundtrip() {
        let m=GisMcp::default();
        m.enable_at("127.0.0.1:0",false).await.unwrap();
        let (endpoint,token)=m.access().unwrap();
        let client=reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap();
        let invoke=|name: &'static str,args: Value| {
            let request=client.post(&endpoint).bearer_auth(&token).header("Content-Type","application/json").body(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}).to_string());
            async move { serde_json::from_str::<Value>(&request.send().await.unwrap().text().await.unwrap()).unwrap()["result"].clone() }
        };
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("projected.geojson");
        let mut feature=test_feature(600*1024);
        feature["geometry"]["coordinates"]=json!([0,0]);
        feature["bbox"]=json!([0,0,0,0]);
        feature["crs"]=json!({"type":"name","properties":{"name":"EPSG:3857"}});
        std::fs::write(&path,feature.to_string()).unwrap();
        let loaded=invoke("load_vector_file",json!({"path":path})).await;
        assert_eq!(loaded["isError"],false);
        assert_eq!(loaded["structuredContent"]["summary"]["sourceCrs"],"EPSG:3857");
        assert_eq!(loaded["structuredContent"]["summary"]["workingCrs"],"EPSG:4326");
        let id=loaded["structuredContent"]["resultId"].clone();
        let blocked=invoke("read_result",json!({"resultId":id})).await;
        assert_eq!(blocked["isError"],true);
        assert_eq!(blocked["structuredContent"]["error"]["code"],"RESULT_ITEM_TOO_LARGE");
        let projected=invoke("read_result",json!({"resultId":id,"properties":["name"]})).await;
        assert_eq!(projected["isError"],false);
        assert_eq!(projected["structuredContent"]["returnedCount"],1);
        assert!(projected["structuredContent"]["features"][0].get("bbox").is_none());
        assert!(projected["structuredContent"]["features"][0].get("crs").is_none());
        let released=invoke("release_result",json!({"resultId":id})).await;
        assert_eq!(released["structuredContent"]["released"],true);
        assert_eq!(invoke("list_results",json!({})).await["structuredContent"]["remaining"]["results"],20);
        assert_eq!(invoke("read_result",json!({"resultId":id})).await["isError"],true);
        m.disable().await;
    }
    #[test]
    fn oversized_feature_requires_explicit_projection_and_never_returns_empty_success() {
        let m = GisMcp::default();
        let original = test_feature(600*1024);
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(json!({"id":"large","name":"large","features":[original.clone()]})).unwrap());
        let result = cache(&m, vec![original.clone()], json!({}), vec![], 0, true).unwrap();
        assert_eq!(result["sampleTruncated"], true);
        for (tool, id) in [("read_result",json!({"resultId":result["resultId"]})),("read_features",json!({"layerId":"large"}))] {
            assert!(call(&m,tool,&id).unwrap_err().starts_with("RESULT_ITEM_TOO_LARGE:"));
            let mut projected = id.clone();
            projected["properties"] = json!(["name"]);
            let page = call(&m,tool,&projected).unwrap();
            assert_eq!(page["features"][0]["properties"],json!({"name":"保留"}));
            assert_eq!(page["returnedCount"],1);
            assert!(page["nextOffset"].is_null());
            assert_eq!(page["hasMore"],false);
        }
        assert_eq!(m.inner.lock().unwrap().layers[0].features[0],original);
        assert_eq!(m.inner.lock().unwrap().results[result["resultId"].as_str().unwrap()].features[0],original);
        let geometry = json!({"type":"Feature","geometry":{"type":"LineString","coordinates":vec![[1.,1.];70_000]},"properties":{"name":"line"}});
        assert!(page(&[geometry.clone()],&json!({}),json!({}),"features").is_err());
        let projected = page(&[geometry],&json!({"includeGeometry":false}),json!({}),"features").unwrap();
        assert!(projected["features"][0].get("geometry").is_none());
    }
    #[test]
    fn pagination_advances_by_returned_rows_and_reports_blocked_offset() {
        let rows = vec![test_feature(300*1024),test_feature(300*1024),test_feature(600*1024),test_feature(0)];
        let first = page(&rows,&json!({"limit":100}),json!({}),"features").unwrap();
        assert_eq!(first["returnedCount"],1);
        assert_eq!(first["nextOffset"],1);
        assert_eq!(first["truncated"],true);
        assert!(first.to_string().len()<512*1024);
        let second=page(&rows,&json!({"offset":1}),json!({}),"features").unwrap();
        assert_eq!(second["nextOffset"],2);
        assert!(page(&rows,&json!({"offset":2}),json!({}),"features").unwrap_err().contains("offset=2"));
        let projected=page(&rows,&json!({"offset":2,"properties":[]}),json!({}),"features").unwrap();
        assert_eq!(projected["returnedCount"],2);
        assert!(projected["nextOffset"].is_null());
        let beyond=page(&rows,&json!({"offset":999}),json!({}),"features").unwrap();
        assert_eq!(beyond["returnedCount"],0);
        assert!(beyond["nextOffset"].is_null());
    }
    #[test]
    fn cache_lifecycle_supports_long_workflows_without_touching_layers_or_publications() {
        let m=GisMcp::default();
        let layer=json!({"id":"a","name":"a","features":[test_feature(0)]});
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(layer.clone()).unwrap());
        for _ in 0..100 {
            let result=call(&m,"centroid",&json!({"source":{"layerId":"a"}})).unwrap();
            assert_eq!(call(&m,"list_results",&json!({})).unwrap()["remaining"]["results"],19);
            let id=result["resultId"].clone();
            assert_eq!(call(&m,"release_result",&json!({"resultId":id})).unwrap()["released"],true);
            assert!(call(&m,"read_result",&json!({"resultId":id})).is_err());
            assert_eq!(call(&m,"release_result",&json!({"resultId":id})).unwrap()["released"],false);
        }
        let mut ids=Vec::new();
        for _ in 0..20 { ids.push(cache(&m,vec![test_feature(0)],json!({}),vec![],0,true).unwrap()["resultId"].clone()); }
        assert!(cache(&m,vec![],json!({}),vec![],0,true).unwrap_err().starts_with("RESULT_CACHE_FULL:"));
        call(&m,"publish_result",&json!({"resultId":ids[0],"name":"output"})).unwrap();
        let queued=m.inner.lock().unwrap().queue.clone();
        call(&m,"release_result",&json!({"resultId":ids[0]})).unwrap();
        cache(&m,vec![],json!({}),vec![],0,true).unwrap();
        assert_eq!(m.inner.lock().unwrap().queue,queued);
        assert_eq!(m.inner.lock().unwrap().layers[0].value(),layer);
        let expired=ids[1].as_str().unwrap();
        m.inner.lock().unwrap().results.get_mut(expired).unwrap().created=Instant::now()-Duration::from_secs(1801);
        assert_eq!(call(&m,"list_results",&json!({})).unwrap()["remaining"]["results"],1);
        assert!(call(&m,"read_result",&json!({"resultId":expired})).is_err());
    }
    #[tokio::test]
    async fn result_release_has_auth_generation_schema_and_redacted_audit_boundaries() {
        let m=GisMcp::default();
        let result=cache(&m,vec![test_feature(0)],json!({}),vec![],0,true).unwrap();
        { let mut inner=m.inner.lock().unwrap(); inner.endpoint=Some("http://127.0.0.1:9420/mcp".into()); inner.token=Some("test-only".into()); }
        let state=HttpState{mcp:m.clone(),limit:Arc::new(Semaphore::new(2)),generation:0};
        let body=Bytes::from(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"release_result","arguments":{"resultId":result["resultId"]}}}).to_string());
        let mut headers=HeaderMap::new(); headers.insert("host","127.0.0.1:9420".parse().unwrap());
        assert_eq!(handle(State(state.clone()),headers.clone(),body.clone()).await.unwrap_err(),StatusCode::UNAUTHORIZED);
        assert_eq!(m.inner.lock().unwrap().results.len(),1);
        assert!(call_expected(&m,"release_result",&json!({"resultId":result["resultId"]}),1).is_err());
        assert!(call(&m,"release_result",&json!({"resultId":result["resultId"],"path":"forbidden"})).is_err());
        assert!(call(&m,"read_result",&json!({"resultId":result["resultId"],"includeGeometry":"false"})).is_err());
        headers.insert("authorization","Bearer test-only".parse().unwrap());
        let (_,Json(out))=handle(State(state),headers,body).await.unwrap();
        assert_eq!(out["result"]["structuredContent"]["released"],true);
        let audit=m.inner.lock().unwrap().audit.clone();
        assert_eq!(audit.back().unwrap()["risk"],"transient_cache_release");
        assert!(!serde_json::to_string(&audit).unwrap().contains("test-only"));
        assert!(!serde_json::to_string(&audit).unwrap().contains(result["resultId"].as_str().unwrap()));
        let definition=definitions().into_iter().find(|v|v["name"]=="release_result").unwrap();
        assert_eq!(definition["annotations"]["readOnlyHint"],false);
        assert_eq!(definition["annotations"]["destructiveHint"],true);
    }
    #[test]
    fn streaming_fingerprint_preserves_existing_versions() {
        use sha2::{Digest, Sha256};
        let layer = json!({"features":[{"type":"Feature","geometry":null,"properties":{"名称":"中文 🎯","n":1.2345678901234567}}]});
        let original = format!("{:x}", Sha256::digest(layer["features"].to_string().as_bytes()));
        assert_eq!(fingerprint(&layer), original);
    }
    #[tokio::test]
    async fn old_http_transport_cannot_inherit_restarted_session() {
        let mcp = GisMcp::default();
        {
            let mut inner = mcp.inner.lock().unwrap();
            inner.endpoint = Some("http://127.0.0.1:9420/mcp".into());
            inner.token = Some("test-only".into());
        }
        let old = HttpState { mcp: mcp.clone(), limit: Arc::new(Semaphore::new(2)), generation: 0 };
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:9420".parse().unwrap());
        headers.insert("authorization", "Bearer test-only".parse().unwrap());
        let body = Bytes::from_static(br#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#);
        let (_, Json(response)) = handle(State(old.clone()), headers.clone(), body.clone()).await.unwrap();
        assert_eq!(response["result"]["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
        // 固定外部令牌与端口保持不变，唯有服务代次可以隔离旧 keepalive。
        mcp.inner.lock().unwrap().generation = 1;
        assert_eq!(handle(State(old), headers.clone(), body.clone()).await.unwrap_err(), StatusCode::SERVICE_UNAVAILABLE);
        let current = HttpState { mcp, limit: Arc::new(Semaphore::new(2)), generation: 1 };
        assert!(handle(State(current), headers, body).await.is_ok());
    }
    #[test]
    fn publication_queue_has_independent_byte_budget() {
        let mcp = GisMcp::default();
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{}});
        let result = cache(&mcp, vec![feature], json!({}), vec![], 0, true).unwrap();
        // 已发布的结果过期释放缓存后，待导入队列仍占有独立内存预算。
        mcp.inner.lock().unwrap().queue_bytes = 100 * 1024 * 1024;
        assert!(call(&mcp, "publish_result", &json!({"resultId":result["resultId"],"name":"result"})).is_err());
        assert!(mcp.inner.lock().unwrap().queue.is_empty());
        mcp.inner.lock().unwrap().queue_bytes = 0;
        call(&mcp, "publish_result", &json!({"resultId":result["resultId"],"name":"result"})).unwrap();
        mcp.shutdown();
        assert_eq!(pending_publications(&mcp).len(), 1);
        acknowledge_publications(&mcp, &[result["resultId"].as_str().unwrap().into()]).unwrap();
        assert_eq!(mcp.inner.lock().unwrap().queue_bytes, 0);
    }
    #[test]
    fn new_algorithms_share_bounded_schema_cache_and_publication() {
        let m = GisMcp::default();
        let layer = json!({"id":"test-polygons","name":"测试面","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[116.,40.,11.],[116.01,40.,22.],[116.01,40.01,33.],[116.,40.01,44.],[116.,40.,11.]]]},"properties":{"group":"甲"}}]});
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(layer.clone()).unwrap());
        for name in ["intersection", "difference", "symmetric_difference", "centroid", "point_on_surface", "convex_hull", "envelope", "multipart_to_singleparts", "extract_vertices", "polygon_to_lines", "simplify", "geometry_attributes", "count_points", "merge"] {
            let definition = definitions().into_iter().find(|d| d["name"] == name).unwrap();
            assert_eq!(definition["annotations"]["readOnlyHint"], true);
            assert_eq!(definition["inputSchema"]["additionalProperties"], false);
            assert!(call(&m, name, &json!({"source":{"layerId":"test-polygons"},"shell":"ignored"})).is_err());
        }
        let result = call(&m, "centroid", &json!({"source":{"layerId":"test-polygons"}})).unwrap();
        let read = call(&m, "read_result", &json!({"resultId":result["resultId"]})).unwrap();
        assert_eq!(read["features"][0]["geometry"]["type"], "Point");
        assert_eq!(read["features"][0]["geometry"]["coordinates"][2], 0);
        assert!(call(&m, "simplify", &json!({"source":{"layerId":"test-polygons"},"toleranceMeters":0})).is_err());
        let next = call(&m, "buffer", &json!({"source":{"resultId":result["resultId"]},"distanceMeters":10})).unwrap();
        call(&m, "publish_result", &json!({"resultId":next["resultId"],"name":"缓冲结果"})).unwrap();
        let inner = m.inner.lock().unwrap();
        assert_eq!(inner.layers[0].value(), layer);
        assert_eq!(inner.queue.len(), 1);
        assert_eq!(inner.queue[0].features[0]["geometry"]["type"], "MultiPolygon");
        assert!(inner.queue[0].features[0]["geometry"]["coordinates"][0][0].as_array().unwrap().iter().all(|c| c.as_array().unwrap().len() == 3 && c[2] == 0));
    }
    #[tokio::test]
    async fn shutdown_cancels_queued_enable_requests() {
        let m = GisMcp::default();
        let start_lock = m.start_lock.lock().await;
        let first = m.clone();
        let second = m.clone();
        let a = tokio::spawn(async move { first.enable_at("127.0.0.1:0", false).await });
        let b = tokio::spawn(async move { second.enable_at("127.0.0.1:0", false).await });
        tokio::task::yield_now().await;
        m.shutdown();
        drop(start_lock);
        assert!(a.await.unwrap().is_err());
        assert!(b.await.unwrap().is_err());
        assert!(!m.status().enabled);
        assert!(m.access().is_err());
    }
    #[tokio::test]
    async fn disable_releases_listener_before_immediate_same_port_restart() {
        let m = GisMcp::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        m.install_listener(listener, m.start_generation().unwrap(), false).unwrap();
        m.disable().await;
        assert!(!m.status().enabled);
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        m.install_listener(listener, m.start_generation().unwrap(), false).unwrap();
        assert!(m.status().enabled);
        m.disable().await;
    }
    #[tokio::test]
    async fn concurrent_enable_keeps_one_server_and_stop_cancels_pending_start() {
        let m = GisMcp::default();
        let a = m.start_generation().unwrap();
        let b = m.start_generation().unwrap();
        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unused = second.local_addr().unwrap();
        m.install_listener(first, a, false).unwrap();
        let before = m.access().unwrap();
        m.install_listener(second, b, false).unwrap();
        assert_eq!(m.access().unwrap(), before);
        assert!(tokio::net::TcpStream::connect(unused).await.is_err());
        m.shutdown();
        let generation = m.start_generation().unwrap();
        let pending = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        m.shutdown();
        assert!(m.install_listener(pending, generation, false).is_err());
        assert!(!m.status().enabled);
    }
    #[test]
    fn resolved_sources_preserve_bbox_target_exclusion() {
        let m=GisMcp::default();
        let layer=json!({"id":"point","name":"point","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{}}]});
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(layer).unwrap());
        assert!(call(&m,"spatial_query",&json!({"source":{"layerId":"point"},"target":{"layerId":"point"},"bbox":[-1,-1,1,1]})).unwrap_err().contains("二选一"));
        assert!(m.inner.lock().unwrap().results.is_empty());
        assert!(call(&m,"spatial_query",&json!({"source":{"layerId":"point"},"bbox":[-1,-1,1,1]})).is_ok());
    }
    #[test]
    fn result_source_schema_and_chain_are_validated() {
        let m = GisMcp::default();
        let layer = json!({"id":"point","name":"point","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[116.,39.]},"properties":{}}]});
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(layer).unwrap());
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
        { let mut i = m.inner.lock().unwrap();
          let mut changed = i.layers[0].value();
          changed["features"][0]["geometry"]["coordinates"] = json!([117., 39.]);
          i.layers[0] = LayerSnapshot::from_value(changed).unwrap(); }
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
        m.inner.lock().unwrap().layers.push(LayerSnapshot::from_value(layer.clone()).unwrap());
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
        { let mut i = m.inner.lock().unwrap();
          let mut changed = i.layers[0].value();
          changed["features"] = json!([{"type":"Feature"}]);
          i.layers[0] = LayerSnapshot::from_value(changed).unwrap(); }
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
        let h = tokio::spawn(async move { axum::serve(l, router(m, 0)).await.unwrap() });
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

#[cfg(test)]
mod analysis_contract_tests {
    #[test]
    fn public_analysis_schemas_keep_the_baseline() {
        let baseline: serde_json::Value = serde_json::from_str(include_str!("../../crates/spatial-core/tool-contract-baseline.json")).unwrap();
        assert_eq!(serde_json::json!(super::analysis_definitions()), baseline);
    }
}
