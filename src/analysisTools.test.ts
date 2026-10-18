import { expect, it } from "vitest";
import {
  analysisTools,
  getAnalysisTool,
  validAnalysisNumber,
} from "./analysisTools";
import baseline from "./analysisTools.baseline.json";
import catalog from "./generated/analysis-catalog.json";

it("工具契约迁移保留 GUI 顺序、几何限制、参数与结果类型", () => {
  expect(
    analysisTools.filter(({ id }) => baseline.some((entry) => entry.id === id)).map(
      ({
        id,
        requiresTarget,
        sourceKinds,
        targetKinds,
        metric,
        parameters,
        report,
      }) => ({
        id,
        requiresTarget,
        sourceKinds,
        targetKinds,
        metric,
        parameters: id === "spatial_join" ? parameters.filter(parameter => parameter !== "aggregations") : parameters,
        report,
      }),
    ),
  ).toEqual(baseline);
});

it("空间关联仅增补可选聚合参数，默认谓词契约保持不变", () => {
  const tool = getAnalysisTool("spatial_join")!;
  expect(tool.parameters).toEqual(["predicate", "aggregations"]);
  expect(tool.parameterSchema.required).not.toContain("aggregations");
});

it("数值表单使用注册表的开下界与闭上界，拒绝空值和非有限数", () => {
  const tool = getAnalysisTool("buffer")!;
  for (const value of ["", " ", "NaN", "Infinity", "0", "-1", "100001"])
    expect(validAnalysisNumber(tool, "distanceMeters", value)).toBe(false);
  for (const value of ["0.1", "100000"])
    expect(validAnalysisNumber(tool, "distanceMeters", value)).toBe(true);
  expect(validAnalysisNumber(tool, "groupBy", "1")).toBe(false);
});

it("界面恰好展示注册表明确开放的工具，包括显式开放的清理入口", () => {
  expect(analysisTools.map(({ id }) => id).sort()).toEqual(
    catalog
      .filter(({ gui }) => gui)
      .map(({ id }) => id)
      .sort(),
  );
  expect(getAnalysisTool("clean_geometries")?.report).toBeUndefined();
  expect(analysisTools.some(({ id }) => id === "clean_geometries")).toBe(true);
});
