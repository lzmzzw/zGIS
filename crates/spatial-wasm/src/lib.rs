use wasm_bindgen::prelude::*;
use serde_json::Value;
fn error(e: impl std::fmt::Display) -> JsValue { JsValue::from_str(&e.to_string()) }
#[wasm_bindgen]
pub fn analyze(operation: &str, parameters: &str, source: &str, target: Option<String>) -> Result<String, JsValue> {
    const LIMIT: usize = 100 * 1024 * 1024;
    if parameters.len().saturating_add(source.len()).saturating_add(target.as_ref().map_or(0, String::len)) > LIMIT {
        return Err(error("分析输入超过 100 MB，请缩小范围"));
    }
    let parameters: Value = serde_json::from_str(parameters).map_err(error)?;
    let source: Vec<Value> = serde_json::from_str(source).map_err(error)?;
    let target: Option<Vec<Value>> = target.map(|v| serde_json::from_str(&v)).transpose().map_err(error)?;
    let result = spatial_core::input::execute(operation, &parameters, &source, target.as_deref()).map_err(error)?;
    serde_json::to_string(&result).map_err(error)
}
#[wasm_bindgen]
pub fn export_shapefile(features: &str, stem: &str, crs: &str) -> Result<Vec<u8>, JsValue> {
    let features: Vec<Value> = serde_json::from_str(features).map_err(error)?;
    spatial_core::export::build_zip_crs(&features, stem, crs).map_err(error)
}
