import { expect, it } from "vitest";
import { analysisTools } from "./analysisTools";
import baseline from "./analysisTools.baseline.json";

it("工具契约迁移保留 GUI 顺序、几何限制、参数与结果类型", () => {
  expect(analysisTools.map(({ id, requiresTarget, sourceKinds, targetKinds, metric, parameters, report }) => ({
    id, requiresTarget, sourceKinds, targetKinds, metric, parameters, report,
  }))).toEqual(baseline);
});
