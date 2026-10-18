//! 用户工具箱的内存分析入口；不读取路径、MCP token 或数据库身份。
use serde_json::Value;
use tauri::State;

#[derive(Default)]
pub struct ProcessingState;

fn execute(
    operation: &str,
    parameters: &Value,
    source: &[Value],
    target: Option<&[Value]>,
) -> Result<Value, String> {
    spatial_core::with_checkpoint(crate::analysis_runtime::checkpoint, || {
        spatial_core::input::execute(operation, parameters, source, target)
    })
}

#[tauri::command]
pub async fn gis_run_analysis(
    _state: State<'_, ProcessingState>,
    operation: String,
    parameters: Value,
    source: Vec<Value>,
    target: Option<Vec<Value>>,
    job_id: Option<String>,
) -> Result<Value, String> {
    let id = job_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let guard = crate::analysis_runtime::global().start("desktop", &id)?;
    tauri::async_runtime::spawn_blocking(move || {
        guard.run(|| execute(&operation, &parameters, &source, target.as_deref()))
    })
    .await
    .map_err(|_| "空间分析执行失败，请重试")?
}

#[tauri::command]
pub fn gis_cancel_analysis(job_id: String) -> bool {
    crate::analysis_runtime::global().cancel("desktop", &job_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn point() -> Value {
        json!({"type":"Feature","id":"p","geometry":{"type":"Point","coordinates":[116.,40.,19.]},"properties":{"name":"测试"}})
    }
    #[test]
    fn shared_input_entry_keeps_desktop_cancellation_and_restores_hook() {
        let runtime =
            crate::analysis_runtime::AnalysisRuntime::new(1, std::time::Duration::from_secs(10));
        let guard = runtime.start("processing-test", "cancel").unwrap();
        let result = guard.run(|| {
            runtime.cancel("processing-test", "cancel");
            execute("layer_summary", &json!({}), &[point()], None)
        });
        assert!(result.unwrap_err().contains("ANALYSIS_CANCELLED"));
        assert!(spatial_core::checkpoint().is_ok());
        assert!(execute("layer_summary", &json!({}), &[point()], None).is_ok());
    }
    #[test]
    fn direct_analysis_preserves_input_and_returns_geometry() {
        let source = vec![point()];
        let original = source.clone();
        let result = execute("buffer", &json!({"distanceMeters":100}), &source, None).unwrap();
        assert_eq!(source, original);
        assert_eq!(result["type"], "FeatureCollection");
        assert_eq!(result["features"][0]["properties"]["name"], "测试");
        let ring = result["features"][0]["geometry"]["coordinates"][0][0]
            .as_array()
            .unwrap();
        assert!(ring
            .iter()
            .all(|c| c.as_array().unwrap().len() == 3 && c[2] == 0));
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
}
