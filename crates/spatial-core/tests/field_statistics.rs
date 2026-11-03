use serde_json::{json, Value};
fn feature(properties: Value) -> Value {
    json!({"type":"Feature","properties":properties,"geometry":{"type":"Point","coordinates":[116,39,17]}})
}
fn metrics() -> Value {
    json!([
        {"name":"all","op":"count_all"},{"name":"valid","op":"count_valid","field":"x"},
        {"name":"sum","op":"sum","field":"x"},{"name":"mean","op":"mean","field":"x"},
        {"name":"min","op":"min","field":"x"},{"name":"max","op":"max","field":"x"}
    ])
}
fn run(source: &[Value], args: Value) -> Result<Value, String> {
    let direct = spatial_core::analyze("field_statistics", &args, source, None);
    assert_eq!(
        direct,
        spatial_core::input::execute("field_statistics", &args, source, None)
    );
    direct
}
#[test]
fn hand_calculated_statistics_include_null_missing_and_never_mutate_input() {
    let source = vec![
        feature(json!({"x":2})),
        feature(json!({"x":4})),
        feature(json!({"x":null})),
        feature(json!({})),
    ];
    let original = source.clone();
    let result = run(&source, json!({"metrics":metrics()})).unwrap();
    assert_eq!(source, original);
    assert_eq!(result["type"], "table");
    assert_eq!(result["inputCount"], 4);
    assert_eq!(result["groupCount"], 1);
    assert_eq!(result["numericModel"], "finite_f64_safe_integer_guard");
    let row = &result["rows"][0];
    assert_eq!(row["group"], json!({"type":"all"}));
    assert_eq!(row["inputCount"], 4);
    assert_eq!(row["values"]["all"], 4);
    assert_eq!(row["values"]["valid"], 2);
    assert_eq!(row["values"]["sum"].as_f64(), Some(6.0));
    assert_eq!(row["values"]["mean"].as_f64(), Some(3.0));
    assert_eq!(row["values"]["min"], 2);
    assert_eq!(row["values"]["max"], 4);
    for key in ["valid", "sum", "mean", "min", "max"] {
        assert_eq!(
            row["counts"][key],
            json!({"validCount":2,"nullCount":1,"missingCount":1})
        );
    }
    assert!(result.get("features").is_none());
}
#[test]
fn typed_groups_separate_missing_null_boolean_numbers_and_strings() {
    let source = vec![
        feature(json!({"g":1,"x":2})),
        feature(json!({"g":"1","x":3})),
        feature(json!({"g":null,"x":4})),
        feature(json!({"x":5})),
        feature(json!({"g":true,"x":6})),
        feature(json!({"g":1.0,"x":7})),
    ];
    let result = run(&source, json!({"groupBy":"g","metrics":metrics()})).unwrap();
    assert_eq!(result["groupCount"], 5);
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(
        rows.iter()
            .map(|r| r["group"]["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["missing", "null", "boolean", "number", "string"]
    );
    let numeric = rows
        .iter()
        .find(|r| r["group"]["type"] == "number")
        .unwrap();
    assert_eq!(numeric["inputCount"], 2);
    assert_eq!(numeric["values"]["sum"].as_f64(), Some(9.0));
    assert_eq!(
        run(&source, json!({"groupBy":"g","metrics":metrics()})).unwrap(),
        result
    );
}
#[test]
fn empty_numeric_groups_return_null_and_count_valid_accepts_non_numeric_values() {
    let source = [feature(json!({"x":null})), feature(json!({}))];
    let result = run(&source, json!({"metrics":metrics()})).unwrap();
    let values = &result["rows"][0]["values"];
    assert_eq!(values["valid"], 0);
    for name in ["sum", "mean", "min", "max"] {
        assert!(values[name].is_null());
    }
    for x in [
        json!("100"),
        json!(true),
        json!({"nested":1}),
        json!([1]),
        json!(9007199254740993u64),
    ] {
        let source = [feature(json!({"x":x}))];
        assert_eq!(
            run(
                &source,
                json!({"metrics":[{"name":"n","op":"count_valid","field":"x"}]})
            )
            .unwrap()["rows"][0]["values"]["n"],
            1
        );
        assert!(run(&source, json!({"metrics":metrics()})).is_err());
    }
}
#[test]
fn numeric_precision_overflow_underflow_and_exact_extrema_are_explicit() {
    for raw in [
        "9007199254740993",
        "-9007199254740993",
        "9007199254740991.1",
        "1e-400",
        "1e400",
    ] {
        let x: Value = serde_json::from_str(raw).unwrap();
        assert!(
            run(&[feature(json!({"x":x}))], json!({"metrics":metrics()})).is_err(),
            "accepted {raw}"
        );
    }
    let source = [
        feature(json!({"x":9007199254740991u64})),
        feature(json!({"x":1})),
    ];
    assert!(run(&source, json!({"metrics":metrics()}))
        .unwrap_err()
        .contains("安全精度"));
    let source = [
        feature(json!({"x":1e15})),
        feature(json!({"x":1})),
        feature(json!({"x":-1e15})),
    ];
    assert_eq!(
        run(&source, json!({"metrics":metrics()})).unwrap()["rows"][0]["values"]["sum"].as_f64(),
        Some(1.0)
    );
    let a: Value = serde_json::from_str("1.0000000000000000001").unwrap();
    let b: Value = serde_json::from_str("1.0000000000000000002").unwrap();
    let result = run(
        &[feature(json!({"x":a})), feature(json!({"x":b}))],
        json!({"metrics":metrics()}),
    )
    .unwrap();
    assert_eq!(result["rows"][0]["values"]["min"], a);
    assert_eq!(result["rows"][0]["values"]["max"], b);
}
#[test]
fn grouping_metric_and_feature_budgets_fail_without_partial_reports() {
    let source: Vec<_> = (0..1001).map(|n| feature(json!({"g":n,"x":n}))).collect();
    let args = json!({"groupBy":"g","metrics":metrics()});
    assert_eq!(
        run(&source[..1000], args.clone()).unwrap()["groupCount"],
        1000
    );
    assert!(run(&source, args).unwrap_err().contains("1000"));
    assert!(run(
        &[feature(json!({"g":"a".repeat(4097),"x":1}))],
        json!({"groupBy":"g","metrics":metrics()})
    )
    .is_err());
    assert!(run(
        &[feature(json!({"g":[],"x":1}))],
        json!({"groupBy":"g","metrics":metrics()})
    )
    .is_err());
    assert!(run(
        &source[..1],
        json!({"groupBy":"absent","metrics":metrics()})
    )
    .is_err());
    for invalid in [
        json!([]),
        json!([{"name":"n","op":"count_all","field":"x"}]),
        json!([{"name":"n","op":"sum"}]),
        json!([{"name":"n","op":"count_all"},{"name":"n","op":"count_all"}]),
        json!([{"name":"n","op":"median","field":"x"}]),
        json!([{"name":"n","op":"count_all","script":"run"}]),
    ] {
        assert!(run(&source[..1], json!({"metrics":invalid})).is_err());
    }
    let eight: Vec<_> = (0..8)
        .map(|i| json!({"name":format!("n{i}"),"op":"count_all"}))
        .collect();
    assert!(run(&source[..1], json!({"metrics":eight})).is_ok());
    let nine: Vec<_> = (0..9)
        .map(|i| json!({"name":format!("n{i}"),"op":"count_all"}))
        .collect();
    assert!(run(&source[..1], json!({"metrics":nine})).is_err());
    let mut invalid = source[0].clone();
    invalid["geometry"] = Value::Null;
    assert!(run(&[invalid], json!({"metrics":metrics()})).is_err());
    assert!(run(
        &vec![source[0].clone(); 100001],
        json!({"metrics":metrics()})
    )
    .is_err());
    let result = spatial_core::with_checkpoint(
        || Err("ANALYSIS_CANCELLED".into()),
        || {
            spatial_core::analyze(
                "field_statistics",
                &json!({"metrics":metrics()}),
                &source,
                None,
            )
        },
    );
    assert!(result.unwrap_err().contains("ANALYSIS_CANCELLED"));
    assert!(spatial_core::checkpoint().is_ok());
}
#[test]
#[ignore = "explicit streaming statistics workload measurement"]
fn statistics_workload_10000_features_1000_groups_8_metrics() {
    let source: Vec<_> = (0..10000)
        .map(|i| feature(json!({"g":i%1000,"x":i})))
        .collect();
    let metrics: Vec<_> = (0..8)
        .map(|i| json!({"name":format!("sum{i}"),"op":"sum","field":"x"}))
        .collect();
    let start = std::time::Instant::now();
    let result = spatial_core::input::execute(
        "field_statistics",
        &json!({"groupBy":"g","metrics":metrics}),
        &source,
        None,
    )
    .unwrap();
    assert_eq!(result["groupCount"], 1000);
    println!(
        "10000 features / 1000 groups / 8 metrics: {:?}",
        start.elapsed()
    );
}
