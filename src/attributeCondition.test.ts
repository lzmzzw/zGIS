import { expect, it } from "vitest";
import { conditionValue, newCondition } from "./AttributeConditionEditor";
import { restoreAnalysisSourceIds } from "./analysisResult";
import type { GeoFeature } from "./domain/types";

it("条件编辑器区分标量类型、空值、IN与AND/OR", () => {
  const rule = { ...newCondition("v"), kind: "rule" as const, field: "v", op: "gt", type: "number" as const, text: "10" };
  expect(conditionValue({ kind: "all", children: [rule, { ...rule, op: "is_missing" }] }, ["v"])).toEqual({ all: [{ field: "v", op: "gt", value: 10 }, { field: "v", op: "is_missing" }] });
  expect(() => conditionValue({ ...rule, text: "9007199254740993" }, ["v"])).toThrow();
  expect(() => conditionValue({ ...rule, op: "in", text: "[null]" }, ["v"])).toThrow();
  expect(() => conditionValue(rule, [])).toThrow();
});
it("保真工具恢复原数字和文本id，无id不凭空添加且不改变源或其他工具", () => {
  const input: GeoFeature[] = [42, "code", undefined].map((sourceFeatureId, index) => ({ id: `internal-${index}`, sourceFeatureId, geometry: null, properties: {} }));
  const raw = { type: "FeatureCollection", features: input.map(({ id, geometry, properties }) => ({ type: "Feature", id, geometry, properties })) };
  const result = restoreAnalysisSourceIds("extract_by_attribute", raw, input);
  expect((result.features as { id?: unknown }[]).map(f => f.id)).toEqual([42, "code", undefined]);
  expect(restoreAnalysisSourceIds("buffer", raw, input)).toBe(raw);
  expect(raw.features[0].id).toBe("internal-0");
});
