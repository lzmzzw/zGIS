use serde_json::{json, Value};

fn feature(id: usize, properties: Value) -> Value {
    json!({"type":"Feature","id":id,"properties":properties,"geometry":{"type":"Point","coordinates":[116,39,17]}})
}
fn extract(source: &[Value], condition: Value) -> Result<Value, String> {
    let args = json!({"condition":condition});
    let direct = spatial_core::analyze("extract_by_attribute", &args, source, None);
    let memory = spatial_core::input::execute("extract_by_attribute", &args, source, None);
    assert_eq!(direct, memory, "core and memory entrypoints diverged");
    direct
}
fn ids(result: Value) -> Vec<usize> {
    result["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_u64().unwrap() as usize)
        .collect()
}

#[test]
fn structured_conditions_preserve_full_features_order_identity_and_xyz() {
    let source = vec![
        feature(
            4,
            json!({"type":"住宅","area":100,"other":{"nested":[1,2]}}),
        ),
        feature(2, json!({"type":"住宅","area":150})),
        feature(9, json!({"type":"商业","area":300})),
    ];
    let original = source.clone();
    let condition = json!({"all":[{"field":"type","op":"eq","value":"住宅"},{"any":[{"field":"area","op":"gte","value":100},{"field":"area","op":"lt","value":0}]}]});
    let result = extract(&source, condition).unwrap();
    assert_eq!(result["features"], json!([source[0], source[1]]));
    assert_eq!(source, original);
    assert_eq!(
        ids(extract(&source, json!({"field":"area","op":"gt","value":1000})).unwrap()),
        Vec::<usize>::new()
    );
}

#[test]
fn null_missing_empty_and_strict_types_remain_distinct() {
    let source = vec![
        feature(0, json!({"x":null})),
        feature(1, json!({})),
        feature(2, json!({"x":""})),
        feature(3, json!({"x":1})),
        feature(4, json!({"x":"1"})),
        feature(5, json!({"x":true})),
    ];
    for (op, value, expected) in [
        ("eq", json!(1), vec![3]),
        ("ne", json!(1), vec![2, 4, 5]),
        ("eq", json!("1"), vec![4]),
        ("eq", json!(""), vec![2]),
        ("eq", json!(true), vec![5]),
        ("in", json!([1, true]), vec![3, 5]),
    ] {
        assert_eq!(
            ids(extract(&source, json!({"field":"x","op":op,"value":value})).unwrap()),
            expected
        );
    }
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"is_null"})).unwrap()),
        vec![0]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"is_missing"})).unwrap()),
        vec![1]
    );
    for op in ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] {
        let value = match op {
            "in" => json!([1]),
            "contains" => json!(""),
            _ => json!(1),
        };
        assert!(
            extract(&source[..2], json!({"field":"x","op":op,"value":value})).unwrap()["features"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    assert!(
        extract(&source, json!({"field":"absent","op":"is_missing"}))
            .unwrap_err()
            .contains("不存在")
    );
}

#[test]
fn string_matching_is_case_sensitive_and_type_errors_do_not_short_circuit() {
    let source = vec![
        feature(0, json!({"x":"Abc","n":0})),
        feature(1, json!({"x":"abc","n":"100"})),
    ];
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"contains","value":"A"})).unwrap()),
        vec![0]
    );
    for key in ["all", "any"] {
        let mut condition = json!({});
        condition[key] = json!([{"field":"x","op":"eq","value":"does not match"},{"field":"n","op":"gt","value":10}]);
        assert!(extract(&source, condition).unwrap_err().contains("类型"));
    }
    assert!(extract(&source, json!({"field":"n","op":"contains","value":"1"})).is_err());
    assert!(extract(
        &[feature(0, json!({"x":[]}))],
        json!({"field":"x","op":"eq","value":1})
    )
    .is_err());
}

#[test]
fn numbers_compare_exactly_without_rounding_large_integers_or_decimals() {
    let values: Vec<Value> = serde_json::from_str(
        "[9007199254740992,9007199254740993,1,1.0,1e0,-0.0,0,1.0000000000000000001,-2,-1,1e-400]",
    )
    .unwrap();
    let source: Vec<_> = values
        .iter()
        .enumerate()
        .map(|(i, v)| feature(i, json!({"x":v})))
        .collect();
    assert_eq!(
        ids(extract(
            &source,
            json!({"field":"x","op":"eq","value":9007199254740993u64})
        )
        .unwrap()),
        vec![1]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"eq","value":1})).unwrap()),
        vec![2, 3, 4]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"eq","value":0})).unwrap()),
        vec![5, 6]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"lt","value":0})).unwrap()),
        vec![8, 9]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"lte","value":0})).unwrap()),
        vec![5, 6, 8, 9]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"gt","value":1})).unwrap()),
        vec![0, 1, 7]
    );
    assert_eq!(
        ids(extract(&source, json!({"field":"x","op":"gte","value":1})).unwrap()),
        vec![0, 1, 2, 3, 4, 7]
    );
}

#[test]
fn condition_limits_reject_unknown_operators_keys_types_and_excess_work() {
    let source = [feature(0, json!({"x":1}))];
    let leaf = json!({"field":"x","op":"eq","value":1});
    let depth4 = json!({"all":[{"any":[{"all":[leaf]}]}]});
    assert!(extract(&source, depth4.clone()).is_ok());
    assert!(extract(&source, json!({"all":[depth4]})).is_err());
    assert!(extract(&source, json!({"all":vec![leaf.clone();32]})).is_ok());
    assert!(extract(
        &source,
        json!({"all":[{"all":vec![leaf.clone();17]},{"all":vec![leaf;16]}]})
    )
    .is_err());
    assert!(extract(&source, json!({"field":"x","op":"in","value":vec![1;100]})).is_ok());
    assert!(extract(&source, json!({"field":"x","op":"in","value":vec![1;101]})).is_err());
    for condition in [
        json!(null),
        json!({}),
        json!({"all":[]}),
        json!({"all":[],"any":[]}),
        json!({"field":"x","op":"sql","value":"SELECT 1"}),
        json!({"field":"x","op":"eq","value":null}),
        json!({"field":"x","op":"eq","value":1,"extra":true}),
        json!({"field":"x","op":"is_null","value":null}),
        json!({"field":"x","op":"gt","value":"1"}),
        json!({"field":"x","op":"in","value":[]}),
        json!({"field":"x","op":"in","value":[null]}),
        json!({"field":"x","op":"contains","value":1}),
    ] {
        assert!(
            extract(&source, condition.clone()).is_err(),
            "accepted {condition}"
        );
    }
}

#[test]
fn attribute_only_logic_cannot_bypass_geometry_structure_size_or_cancellation() {
    let condition = json!({"field":"x","op":"eq","value":1});
    let good = feature(0, json!({"x":1}));
    let mut invalid = good.clone();
    invalid["geometry"] = Value::Null;
    assert!(extract(&[invalid], condition.clone()).is_err());
    let mut invalid = good.clone();
    invalid["type"] = json!("Point");
    assert!(extract(&[invalid], condition.clone()).is_err());
    assert!(extract(&vec![good.clone(); 10001], condition.clone()).is_err());
    let args = json!({"condition":condition});
    let result = spatial_core::with_checkpoint(
        || Err("ANALYSIS_CANCELLED".into()),
        || spatial_core::analyze("extract_by_attribute", &args, &[good], None),
    );
    assert!(result.unwrap_err().contains("ANALYSIS_CANCELLED"));
    assert!(spatial_core::checkpoint().is_ok());
}

#[test]
#[ignore = "explicit bounded attribute workload measurement"]
fn attribute_workload_10000_features_32_leaves() {
    let source: Vec<_> = (0..10000).map(|i| feature(i, json!({"x":i}))).collect();
    let condition = json!({"all":vec![json!({"field":"x","op":"gte","value":5000});32]});
    let start = std::time::Instant::now();
    let result = spatial_core::input::execute(
        "extract_by_attribute",
        &json!({"condition":condition}),
        &source,
        None,
    )
    .unwrap();
    assert_eq!(result["features"].as_array().unwrap().len(), 5000);
    println!(
        "10000 features / 32 leaves / 5000 matches: {:?}",
        start.elapsed()
    );
}
