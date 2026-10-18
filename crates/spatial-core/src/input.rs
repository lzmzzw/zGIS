use serde_json::Value;
// 大小校验直接计数，避免为每个要素及完整结果再分配一份 JSON。
fn json_size(value: &impl serde::Serialize, limit: usize) -> Result<usize, String> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes) {
                return Err(std::io::Error::other("分析数据超过大小上限"));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| "分析数据超过大小上限")?;
    Ok(counter.bytes)
}

pub fn execute(
    operation: &str,
    parameters: &Value,
    source: &[Value],
    target: Option<&[Value]>,
) -> Result<Value, String> {
    validate_features(parameters, source, target)?;
    let limit = 100 * 1024 * 1024;
    let result = crate::analyze(operation, parameters, source, target)?;
    json_size(&result, limit).map_err(|_| "分析结果超过 100 MB，请缩小范围")?;
    Ok(result)
}

// 纯属性工具的直接 core/MCP 入口也必须守住 Feature 与输入字节边界。
pub(crate) fn validate_features(
    parameters: &Value,
    source: &[Value],
    target: Option<&[Value]>,
) -> Result<(), String> {
    let parameters = parameters.as_object().ok_or("分析参数必须是对象")?;
    if parameters.contains_key("source") || parameters.contains_key("target") {
        return Err("工具箱只接受已加载的图层内容，不接受文件或缓存引用".into());
    }
    if source.is_empty() {
        return Err("输入图层没有要素".into());
    }
    let limit = 100 * 1024 * 1024;
    let mut bytes = json_size(parameters, limit).map_err(|_| "分析输入超过 100 MB，请缩小范围")?;
    for input in [Some(source), target].into_iter().flatten() {
        if input.len() > 10_000 {
            return Err("图层超过 10000 个要素，请先缩小范围".into());
        }
        for feature in input {
            crate::checkpoint()?;
            let object = feature.as_object().ok_or("分析要素必须是对象")?;
            if object
                .keys()
                .any(|key| !matches!(key.as_str(), "type" | "id" | "geometry" | "properties"))
            {
                return Err("分析要素只能包含 type、id、geometry、properties".into());
            }
            if object.get("type").and_then(Value::as_str) != Some("Feature") {
                return Err("分析要素类型必须是 Feature".into());
            }
            if !object
                .get("properties")
                .is_some_and(|v| v.is_object() || v.is_null())
            {
                return Err("分析要素属性必须是对象或 null".into());
            }
            bytes += json_size(feature, limit.saturating_sub(bytes))
                .map_err(|_| "分析输入超过 100 MB，请缩小范围")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn size_budget_counts_utf8_and_json_escaping_without_truncation() {
        let value = serde_json::json!({"text":"中文\n\"\\", "nested":[1,null,true]});
        let bytes = serde_json::to_vec(&value).unwrap().len();
        assert_eq!(super::json_size(&value, bytes).unwrap(), bytes);
        assert!(super::json_size(&value, bytes - 1).is_err());
    }
}
