pub use spatial_core::export::*;
#[cfg(test)]
pub fn build_zip(features: &[serde_json::Value], stem: &str) -> Result<Vec<u8>, String> {
    build_zip_crs(features, stem, "EPSG:4326")
}
