const messages: Record<string, string> = {
  字段标注: "Field labels",
  显示标注: "Show labels",
  标注字段: "Label field",
  标注字号: "Label font size",
  标注颜色: "Label color",
  标注描边颜色: "Label halo color",
  标注描边宽度: "Label halo width",
  "标注字段已不存在，暂不显示文字；可重新选择字段。":
    "The label field no longer exists. Labels are hidden until you select an available field.",
  "每层最多标注前 1000 个有效要素，每条最多 80 个字符；拥挤文字自动避让，空值、缺失和对象不显示。":
    "Labels cover the first 1,000 eligible features per layer, with up to 80 characters each. Overlapping text is hidden; null, missing and object values are not labeled.",
  图层样式: "Layer style",
  分类着色: "Categorized colors",
  着色方式: "Color mode",
  单色: "Single color",
  字段唯一值: "Unique field values",
  分类字段: "Category field",
  分类颜色: "Category colors",
  "类别 {0} 颜色": "Category {0} color",
  其他: "Other",
  "空值（null）": "Null value",
  字段缺失: "Missing field",
  "分类字段已不存在，可重新选择字段或切回单色。":
    "The category field no longer exists. Select another field or use a single color.",
  "最多保留前 32 个唯一值；额外值及对象归入其他，空值与缺失分别着色。":
    "Keeps the first 32 unique values. Additional values and objects use Other; null and missing values have separate colors.",
  按当前数据重建分类: "Rebuild categories from current data",
};
export default messages;
