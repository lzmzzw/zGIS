use serde_json::Value;

// 固定迁移前的具名工具契约；重构不能顺手改变已公开的参数与描述。
#[test]
fn analysis_tool_contract_stays_compatible() {
    let baseline: Value = serde_json::from_str(include_str!("../tool-contract-baseline.json")).unwrap();
    assert_eq!(serde_json::json!(spatial_core::tool_definitions()), baseline);
}

#[test]
fn every_registered_tool_rejects_unknown_arguments_without_panicking() {
    for tool in spatial_core::tool_definitions() {
        let name = tool["name"].as_str().unwrap();
        for args in [serde_json::json!({"arbitrarySql":"SELECT 1"}), serde_json::json!([]), Value::Null] {
            let result = std::panic::catch_unwind(|| spatial_core::analyze(name, &args, &[], None));
            assert!(result.is_ok(), "{name} panicked");
            assert!(result.unwrap().is_err(), "{name} accepted invalid arguments");
        }
    }
}
