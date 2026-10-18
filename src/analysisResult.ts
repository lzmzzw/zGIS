import { getAnalysisTool } from "./analysisTools";

export interface AnalysisDetail {
  label: string;
  value: string;
  translate?: boolean;
}
export interface AnalysisExplanation {
  details: AnalysisDetail[];
  warnings: string[];
}
interface AnalysisContext {
  operation: string;
  parameters: Record<string, unknown>;
  selectedOnly: boolean;
  inputCount: number;
  targetCount?: number;
}
const models: Record<string, string> = {
  local_equirectangular_approximation: "局部等距圆柱近似",
  WGS84_ellipsoidal_geodesic: "WGS84 椭球测地距离",
  point_geodesic_other_pair_local_approximation:
    "点对使用椭球距离，其他几何对使用局部近似",
  "WGS84 planar": "WGS84 经纬度平面关系",
};
const parameterLabels: Record<string, string> = {
  distanceMeters: "缓冲距离（米）",
  toleranceMeters: "简化容差（米）",
  groupBy: "分组字段",
  predicate: "空间关系",
};
const predicates: Record<string, string> = {
  intersects: "相交或接触",
  within: "输入在目标内部",
  contains: "输入包含目标",
  touches: "仅边界接触",
  disjoint: "与全部目标不相交",
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Only known result metadata and tool parameters enter this presentation model. */
export function explainAnalysisResult(
  raw: unknown,
  context: AnalysisContext,
): AnalysisExplanation {
  const result = object(raw);
  const analysis = object(result.analysis);
  const tool = getAnalysisTool(context.operation);
  const details: AnalysisDetail[] = [];
  const warnings: string[] = [];
  const addCount = (label: string, value: unknown) => {
    if (count(value)) details.push({ label, value: String(value) });
  };
  details.push({
    label: "输入范围",
    value: context.selectedOnly ? "仅选中要素" : "当前已加载要素",
    translate: true,
  });
  addCount("输入要素", context.inputCount);
  if (tool?.requiresTarget) addCount("目标要素", context.targetCount);
  if (result.type === "FeatureCollection" && Array.isArray(result.features))
    addCount("输出要素", result.features.length);
  const model = analysis.distanceModel ?? result.relationModel;
  if (typeof model === "string" && models[model]) {
    details.push({ label: "计算模型", value: models[model], translate: true });
    if (model.includes("approximation"))
      warnings.push(
        "结果包含局部平面近似，请结合数据范围核对，不用于高精度测量。",
      );
  }
  if (analysis.units === "meters")
    details.push({ label: "距离单位", value: "米", translate: true });
  addCount("移除要素", analysis.removedCount);
  if (analysis.removedTruncated === true)
    warnings.push("移除明细仅包含部分要素，移除总数以统计值为准。");
  // No source ids, paths, database identities or unrelated form parameters.
  for (const key of tool?.parameters ?? []) {
    const value = context.parameters[key];
    if (
      (key === "distanceMeters" || key === "toleranceMeters") &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      details.push({ label: parameterLabels[key], value: String(value) });
    else if (key === "groupBy" && typeof value === "string")
      details.push({ label: parameterLabels[key], value });
    else if (
      key === "predicate" &&
      typeof value === "string" &&
      predicates[value]
    )
      details.push({
        label: parameterLabels[key],
        value: predicates[value],
        translate: true,
      });
  }
  if (Array.isArray(result.checks))
    warnings.push(
      "检查仅覆盖列出的检查项；无效几何不参与成对检查，未检查面缝隙或共享边界一致性。",
    );
  return { details, warnings };
}

/** Canonical phrases remain translatable when the UI locale changes. */
export function analysisLayerNotes(explanation: AnalysisExplanation): string[] {
  return [
    ...explanation.details
      .filter(({ label }) =>
        ["计算模型", "距离单位", "移除要素"].includes(label),
      )
      .map(({ label, value }) => `${label}：${value}`),
    ...explanation.warnings,
  ];
}
