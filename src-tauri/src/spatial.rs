//! 桌面宿主适配；算法唯一源码在 spatial-core。
pub use spatial_core::tool_definitions;
pub fn analyze(name: &str, args: &serde_json::Value, source: &[serde_json::Value], target: Option<&[serde_json::Value]>) -> Result<serde_json::Value, String> {
    spatial_core::with_checkpoint(crate::analysis_runtime::checkpoint, || spatial_core::analyze(name, args, source, target))
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_adapter_retains_host_cancellation() {
        let runtime = crate::analysis_runtime::AnalysisRuntime::new(1, std::time::Duration::from_secs(10));
        let guard = runtime.start("desktop-test", "cancel").unwrap();
        let result = guard.run(|| {
            runtime.cancel("desktop-test", "cancel");
            super::analyze("layer_summary", &serde_json::json!({}), &[serde_json::json!({"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}})], None)
        });
        assert!(result.unwrap_err().contains("ANALYSIS_CANCELLED"));
        assert!(spatial_core::checkpoint().is_ok());
    }
}
