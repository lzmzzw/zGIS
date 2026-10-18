const messages: Record<string, string> = {
  "请选择有效的分级字段。": "Select a valid classification field.",
  "分级数量须为1至32。": "Choose between 1 and 32 classes.",
  "断点须为最多31个严格递增的安全数值。":
    "Provide up to 31 strictly increasing safe numeric breakpoints.",
  "该字段没有可分级的安全数值。":
    "This field has no safe numeric values to classify.",
  全部数值: "All numeric values",
  全部要素: "All features",
  非数值或超出安全范围: "Non-numeric or outside the safe range",
  分级字段: "Classification field",
  "分级字段已不存在，暂用缺失颜色；可重新选择字段。":
    "The classification field no longer exists. The missing-value color is used until you select another field.",
  分级方法: "Classification method",
  等间隔: "Equal intervals",
  分位数: "Quantiles",
  手动断点: "Manual breaks",
  分级数量: "Number of classes",
  内部分割点: "Internal breakpoints",
  应用断点: "Apply breakpoints",
  "断点保存后不随数据变化重算；相同断点合并，常量字段显示一级。区间左开右闭，首尾覆盖所有安全数值。":
    "Saved breaks do not change with the data. Duplicate breaks merge; constant fields use one class. Intervals exclude the lower bound and include the upper bound, with unbounded first and last intervals.",
  "只使用有限安全数值，不转换文本；空值、缺失与非数值分别显示。":
    "Uses only finite safe numbers, without converting text. Null, missing and non-numeric values have separate colors.",
  分级颜色: "Class colors",
  "分级 {0} 颜色": "Class {0} color",
  按当前数据重建分级: "Rebuild classes from current data",
  数值分级: "Graduated colors",
  图例: "Legend",
  图例明细: "Legend entries",
};

export default messages;
