//! 用户工具箱的内存分析入口；不读取路径、MCP token 或数据库身份。
use serde_json::Value;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Semaphore;

// 大小校验直接计数，避免为每个要素及完整结果再分配一份 JSON。
fn json_size(value: &impl serde::Serialize, limit: usize) -> Result<usize, String> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes) {
                return Err(std::io::Error::other("分析数据超过大小上限"));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| "分析数据超过大小上限")?;
    Ok(counter.bytes)
}

pub struct ProcessingState {
    slots: Arc<Semaphore>,
}
impl Default for ProcessingState {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(2)),
        }
    }
}

fn execute(
    operation: &str,
    parameters: &Value,
    source: &[Value],
    target: Option<&[Value]>,
) -> Result<Value, String> {
    let parameters = parameters.as_object().ok_or("分析参数必须是对象")?;
    if parameters.contains_key("source") || parameters.contains_key("target") {
        return Err("工具箱只接受已加载的图层内容，不接受文件或缓存引用".into());
    }
    if source.is_empty() {
        return Err("输入图层没有要素".into());
    }
    let limit = 100 * 1024 * 1024;
    let mut bytes = json_size(parameters, limit)
        .map_err(|_| "分析输入超过 100 MB，请缩小范围")?;
    for input in [Some(source), target].into_iter().flatten() {
        if input.len() > 10_000 {
            return Err("图层超过 10000 个要素，请先缩小范围".into());
        }
        for feature in input {
            let object = feature.as_object().ok_or("分析要素必须是对象")?;
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "type" | "id" | "geometry" | "properties"))
            {
                return Err("分析要素只能包含 type、id、geometry、properties".into());
            }
            if object.get("type").and_then(Value::as_str) != Some("Feature") {
                return Err("分析要素类型必须是 Feature".into());
            }
            if !object
                .get("properties")
                .is_some_and(|v| v.is_object() || v.is_null())
            {
                return Err("分析要素属性必须是对象或 null".into());
            }
            bytes += json_size(feature, limit.saturating_sub(bytes))
                .map_err(|_| "分析输入超过 100 MB，请缩小范围")?;
        }
    }
    let result = crate::spatial::analyze(
        operation,
        &Value::Object(parameters.clone()),
        source,
        target,
    )?;
    json_size(&result, limit)
        .map_err(|_| "分析结果超过 100 MB，请缩小范围")?;
    Ok(result)
}

#[tauri::command]
pub async fn gis_run_analysis(
    state: State<'_, ProcessingState>,
    operation: String,
    parameters: Value,
    source: Vec<Value>,
    target: Option<Vec<Value>>,
) -> Result<Value, String> {
    let slot = state
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| "分析任务正在运行，请稍后重试")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        execute(&operation, &parameters, &source, target.as_deref())
    })
    .await
    .map_err(|_| "空间分析执行失败，请重试")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn point() -> Value {
        json!({"type":"Feature","id":"p","geometry":{"type":"Point","coordinates":[116.,40.,19.]},"properties":{"name":"测试"}})
    }
    #[test]
    fn direct_analysis_preserves_input_and_returns_geometry() {
        let source = vec![point()];
        let original = source.clone();
        let result = execute("buffer", &json!({"distanceMeters":100}), &source, None).unwrap();
        assert_eq!(source, original);
        assert_eq!(result["type"], "FeatureCollection");
        assert_eq!(result["features"][0]["properties"]["name"], "测试");
        let ring = result["features"][0]["geometry"]["coordinates"][0][0].as_array().unwrap();
        assert!(ring.iter().all(|c| c.as_array().unwrap().len() == 3 && c[2] == 0));
    }
    #[test]
    fn rejects_handles_paths_and_unknown_parameters() {
        for parameters in [
            json!({"source":{"path":"private.geojson"},"distanceMeters":10}),
            json!({"target":{"layerId":"x"}}),
            json!({"arbitrarySql":"SELECT 1"}),
        ] {
            assert!(execute("buffer", &parameters, &[point()], None).is_err());
        }
        let mut feature = point();
        feature["dbKey"] = json!([1]);
        assert!(execute("layer_summary", &json!({}), &[feature], None).is_err());
        assert!(execute("unlisted", &json!({}), &[point()], None).is_err());
    }
    #[test]
    fn rejects_empty_oversized_and_non_feature_inputs() {
        assert!(execute("buffer", &json!({"distanceMeters":10}), &[], None).is_err());
        assert!(execute("layer_summary", &json!({}), &vec![point(); 10001], None).is_err());
        let mut feature = point();
        feature["type"] = json!("Point");
        assert!(execute("layer_summary", &json!({}), &[feature], None).is_err());
    }
    #[test]
    fn size_budget_counts_utf8_and_json_escaping_without_truncation() {
        let value = json!({"text":"中文\n\"\\", "nested":[1,null,true]});
        let bytes = serde_json::to_vec(&value).unwrap().len();
        assert_eq!(json_size(&value, bytes).unwrap(), bytes);
        assert!(json_size(&value, bytes - 1).is_err());
    }
}
