use serde_json::{json, Value};
fn polygon(x: f64, properties: Value) -> Value {
    json!({"type":"Feature","id":format!("source{x}"),"properties":properties,"geometry":{"type":"Polygon","coordinates":[[[x,0,17],[x+2.0,0,17],[x+2.0,2,17],[x,2,17],[x,0,17]]]}})
}
fn point(x: f64, properties: Value) -> Value {
    json!({"type":"Feature","properties":properties,"geometry":{"type":"Point","coordinates":[x,1,99]}})
}
fn metrics() -> Value {
    json!([
        {"name":"count","op":"count_all"},{"name":"valid","op":"count_valid","field":"x"},
        {"name":"sum","op":"sum","field":"x"},{"name":"mean","op":"mean","field":"x"},
        {"name":"min","op":"min","field":"x"},{"name":"max","op":"max","field":"x"}
    ])
}
fn run(source: &[Value], target: &[Value], args: Value) -> Result<Value, String> {
    let result = spatial_core::analyze("spatial_join", &args, source, Some(target));
    assert_eq!(
        result,
        spatial_core::input::execute("spatial_join", &args, source, Some(target))
    );
    result
}
#[test]
fn default_output_retains_old_contract_exactly() {
    let source = [polygon(0.0, json!({"_zgis_join":"keep","name":"source"}))];
    let target = [point(1.0, json!({"x":"not_numeric"}))];
    let output = run(&source, &target, json!({})).unwrap();
    let mut expected = source[0].clone();
    expected["properties"]["_zgis_join_"] = json!({"count":1,"targetIndices":[0]});
    assert_eq!(
        output,
        json!({"type":"FeatureCollection","features":[expected]})
    );
}
#[test]
fn per_target_feature_aggregates_keep_source_geometry_and_use_uniform_safe_fields() {
    let source = [
        polygon(0.0, json!({"sum":123,"count":4})),
        polygon(1.0, json!({"sum_":456})),
        polygon(10.0, json!({})),
    ];
    let mut multi = point(1.5, json!({"x":7}));
    multi["geometry"] = json!({"type":"MultiPoint","coordinates":[[1.5,1,7],[1.7,1,8]]});
    let target = [
        multi,
        point(0.5, json!({"x":3})),
        point(0.7, json!({"x":null})),
        point(0.8, json!({})),
        point(100.0, json!({"x":100})),
    ];
    let old_source = source.clone();
    let old_target = target.clone();
    let output = run(&source, &target, json!({"aggregations":metrics()})).unwrap();
    assert_eq!(source, old_source);
    assert_eq!(target, old_target);
    assert_eq!(output["features"].as_array().unwrap().len(), 3);
    assert_eq!(output["analysis"]["aggregationFields"]["sum"], "sum__");
    assert_eq!(output["analysis"]["aggregationFields"]["count"], "count_");
    assert_eq!(
        output["analysis"]["aggregationScope"],
        "target_features_per_source"
    );
    for (i, original) in source.iter().enumerate() {
        assert_eq!(output["features"][i]["geometry"], original["geometry"]);
        assert_eq!(output["features"][i]["id"], original["id"]);
        for (key, value) in original["properties"].as_object().unwrap() {
            assert_eq!(&output["features"][i]["properties"][key], value);
        }
    }
    let first = &output["features"][0]["properties"];
    assert_eq!(first["count_"], 4);
    assert_eq!(first["valid"], 2);
    assert_eq!(first["sum__"].as_f64(), Some(10.0));
    assert_eq!(first["mean"].as_f64(), Some(5.0));
    assert_eq!(first["min"], 3);
    assert_eq!(first["max"], 7);
    assert_eq!(
        first["_zgis_join"],
        json!({"count":4,"targetIndices":[0,1,2,3]})
    );
    let second = &output["features"][1]["properties"];
    assert_eq!(second["count_"], 1);
    assert_eq!(second["sum__"].as_f64(), Some(7.0));
    let empty = &output["features"][2]["properties"];
    assert_eq!(empty["count_"], 0);
    assert_eq!(empty["valid"], 0);
    for key in ["sum__", "mean", "min", "max"] {
        assert!(empty[key].is_null());
    }
}
#[test]
fn aggregation_names_never_replace_join_metadata_or_other_metrics() {
    let source = [
        polygon(
            0.0,
            json!({"_zgis_join":"original","_zgis_join_":"original2"}),
        ),
        polygon(1.0, json!({})),
    ];
    let target = [point(1.5, json!({}))];
    let output=run(&source,&target,json!({"aggregations":[{"name":"_zgis_join","op":"count_all"},{"name":"_zgis_join_","op":"count_all"}]})).unwrap();
    let fields = &output["analysis"]["aggregationFields"];
    assert_eq!(fields["_zgis_join"], "_zgis_join___");
    assert_eq!(fields["_zgis_join_"], "_zgis_join____");
    assert_eq!(
        output["features"][0]["properties"]["_zgis_join"],
        "original"
    );
    assert_eq!(
        output["features"][0]["properties"]["_zgis_join__"]["count"],
        1
    );
    for i in [0, 1] {
        assert_eq!(output["features"][i]["properties"]["_zgis_join___"], 1);
        assert_eq!(output["features"][i]["properties"]["_zgis_join____"], 1);
    }
}
#[test]
fn invalid_targets_fail_before_matching_and_sum_budgets_are_per_source() {
    let source = [polygon(0.0, json!({}))];
    let target = [point(1.0, json!({"x":1})), point(100.0, json!({"x":"bad"}))];
    assert!(run(&source, &target, json!({"aggregations":metrics()})).is_err());
    assert!(run(&source, &target, json!({"aggregations":[]})).is_err());
    assert!(run(
        &source,
        &target,
        json!({"aggregations":[{"name":"x","op":"sum","field":"absent"}]})
    )
    .is_err());
    let target = [point(0.5, json!({"x":5e15})), point(1.5, json!({"x":5e15}))];
    assert!(run(&source, &target, json!({"aggregations":metrics()}))
        .unwrap_err()
        .contains("安全精度"));
    let source = [polygon(0.0, json!({})), polygon(3.0, json!({}))];
    let target = [point(0.5, json!({"x":5e15})), point(3.5, json!({"x":5e15}))];
    assert!(run(&source, &target, json!({"aggregations":metrics()})).is_ok());
    let result = spatial_core::with_checkpoint(
        || Err("ANALYSIS_CANCELLED".into()),
        || {
            spatial_core::analyze(
                "spatial_join",
                &json!({"aggregations":metrics()}),
                &source,
                Some(&target),
            )
        },
    );
    assert!(result.unwrap_err().contains("ANALYSIS_CANCELLED"));
    assert!(spatial_core::checkpoint().is_ok());
}
