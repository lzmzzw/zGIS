//! 导出当前工具契约；脚本负责写入或核对静态产物。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "{}",
        serde_json::to_string_pretty(&spatial_core::registry::metadata())?
    );
    Ok(())
}
