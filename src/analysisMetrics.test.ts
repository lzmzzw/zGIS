import { expect, it } from "vitest";
import { metricsError, normalizedMetrics } from "./AnalysisMetrics";
it("统计指标名称与字段校验不允许无效提交，count_all不携带字段", () => {
  expect(metricsError([{ name: "total", op: "sum", field: "v" }], ["v"])).toBe("");
  expect(metricsError([{ name: "total", op: "sum", field: "removed" }], ["v"])).not.toBe("");
  expect(metricsError([{ name: " n", op: "count_all" }, { name: "n ", op: "count_all" }], [])).not.toBe("");
  expect(normalizedMetrics([{ name: " n ", op: "count_all", field: "old" }])).toEqual([{ name: "n", op: "count_all" }]);
});
