const messages: Record<string, string> = {
  字段概览: "Field profile",
  关闭字段概览: "Close field profile",
  未选择图层: "No layer selected",
  请选择一个已加载图层: "Select a loaded layer",
  "统计当前已加载图层的全部要素，不随地图范围或选择变化。":
    "Profiles all loaded features, regardless of map extent or selection.",
  概览字段: "Profile field",
  没有可统计字段: "No fields to profile",
  "有效（非空）": "Valid (non-null)",
  空值: "Null",
  缺失: "Missing",
  "已统计 {0} 个要素": "Profiled {0} features",
  类型分布: "Value types",
  数字: "Number",
  数组: "Array",
  对象: "Object",
  其他类型: "Other types",
  中位数: "Median",
  数值分布: "Numeric distribution",
  "等间隔直方图，合计 {0} 个数值": "Equal-interval histogram of {0} values",
  查看分布数据: "View histogram data",
  区间: "Interval",
  "均值与中位数使用浮点近似，不用于精确财务计算；显示舍入不修改原值。":
    "Mean and median use floating-point approximations, not exact financial calculations. Display rounding does not change source values.",
  "存在非有限数值或不安全整数，未计算数值统计。":
    "Numeric statistics were skipped because nonfinite or unsafe numeric values are present.",
  "仅纯数值字段计算数值统计；文本不会自动转换为数字。":
    "Numeric statistics require a numeric field. Text is never converted to numbers.",
  常见值: "Common values",
  "显示频次最高的8个标量值，共 {0} 个不同标量值。":
    "Shows the 8 most frequent scalar values out of {0} distinct scalar values.",
  没有可展示的标量值: "No scalar values to display",
  请选择包含安全数值的纯数值字段:
    "Select a numeric field containing safe numbers",
  按此字段分级着色: "Classify colors by this field",
  "字段概览最多统计10000个已加载要素，请先缩小图层":
    "Field profiles support up to 10,000 loaded features. Reduce the layer first.",
  "字段目录超过概览预算，请缩小字段范围":
    "The field catalog exceeds the profile budget. Reduce the field scope.",
  字段名称不适用于概览: "This field name cannot be profiled",
  "所选字段文本超过概览预算，未返回部分统计":
    "Selected field text exceeds the profile budget. No partial statistics were returned.",
  "颜色、透明度或线宽无效": "Invalid color, opacity, or stroke width",
  分类与分级样式不能同时启用:
    "Categorized and graduated styles cannot both be active",
  "样式配置无效，请检查字段与参数":
    "Invalid style configuration. Check the fields and parameters.",
  "样式引用的字段已不存在，请重新选择":
    "A style field no longer exists. Select another field.",
  "分级字段没有安全数值，请重新选择":
    "The classification field has no safe numbers. Select another field.",
  无法创建分级样式: "Unable to create graduated style",
  图层检查器: "Layer inspector",
  预览中: "Preview",
  关闭检查器: "Close inspector",
  "修改即时预览；应用后保存显示设置，取消不改变图层。":
    "Changes preview immediately. Apply saves the display settings; Cancel leaves the layer unchanged.",
  基础样式: "Base style",
  着色与标注: "Colors and labels",
  当前预览尚未应用: "Preview has not been applied",
  应用样式: "Apply style",
  颜色: "Color",
  不透明度: "Opacity",
  线宽: "Stroke width",
};
export default messages;
