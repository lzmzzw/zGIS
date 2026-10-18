use serde_json::Value;

#[test]
fn every_registered_tool_rejects_unknown_arguments_without_panicking() {
    for tool in spatial_core::registry::ANALYSES {
        let name = tool.id();
        for args in [
            serde_json::json!({"arbitrarySql":"SELECT 1"}),
            serde_json::json!([]),
            Value::Null,
        ] {
            let result = std::panic::catch_unwind(|| spatial_core::analyze(name, &args, &[], None));
            assert!(result.is_ok(), "{name} panicked");
            assert!(
                result.unwrap().is_err(),
                "{name} accepted invalid arguments"
            );
        }
    }
}

#[test]
fn pure_parameters_reject_references_and_wrong_types_in_both_entrypoints() {
    use serde_json::json;
    let features =
        [json!({"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}})];
    for (name, args) in [
        ("buffer", json!({"distanceMeters":"10"})),
        ("buffer", json!({"distanceMeters":null})),
        ("simplify", json!({"toleranceMeters":100001})),
        ("dissolve", json!({"groupBy":7})),
        ("spatial_query", json!({"predicate":"unsupported"})),
        ("spatial_query", json!({"predicate":false})),
        ("spatial_query", json!({"bbox":[0,0,"1",1]})),
        ("spatial_query", json!({"bbox":[0,0,1]})),
        (
            "layer_summary",
            json!({"source":{"path":"private.geojson"}}),
        ),
        ("layer_summary", json!({"target":{"resultId":"cached"}})),
    ] {
        assert!(
            spatial_core::analyze(name, &args, &features, None).is_err(),
            "{name}: {args}"
        );
        assert!(
            spatial_core::input::execute(name, &args, &features, None).is_err(),
            "{name}: {args}"
        );
    }
    assert!(spatial_core::input::execute(
        "spatial_query",
        &json!({"bbox":[-1,-1,1,1]}),
        &features,
        Some(&features)
    )
    .is_err());
    assert!(spatial_core::input::execute(
        "spatial_query",
        &json!({"bbox":[-1,-1,1,1]}),
        &features,
        None
    )
    .is_ok());
}

#[test]
fn registry_is_unique_and_does_not_expand_gui_exposure() {
    use std::collections::HashSet;
    let mut ids = HashSet::new();
    for spec in spatial_core::registry::ANALYSES {
        assert!(ids.insert(spec.id()));
        let schema = spec.parameter_schema();
        assert!(schema["properties"].get("source").is_none());
        assert!(schema["properties"].get("target").is_none());
        for parameter in spec.parameters {
            if let Some(default) = parameter.schema().get("default") {
                let mut args = serde_json::json!({});
                args[parameter.key()] = default.clone();
                assert!(spec.validate(&args).is_ok());
            }
        }
    }
    assert_eq!(ids.len(), 24);
    let metadata = spatial_core::registry::metadata();
    assert_eq!(metadata.iter().filter(|s| s["gui"] == true).count(), 24);
    assert_eq!(
        metadata
            .iter()
            .find(|s| s["id"] == "clean_geometries")
            .unwrap()["gui"],
        true
    );
}
