import { expect, it } from "vitest";
import { assertMcpWorkspaceBudget } from "./mcpWorkspaceBudget";
import type { GeoFeature } from "./domain/types";

it("MCP预算包含UTF-8及元数据，旧属性版本缓存不会漏过新版本", () => {
  const feature: GeoFeature = { id: "1", geometry: null, properties: { text: "中文" } };
  const layer = { id: "layer", name: "测试", features: [feature] };
  expect(() => assertMcpWorkspaceBudget([layer])).not.toThrow();
  const tooLarge = { ...feature, properties: { text: "中".repeat(36 * 1024 * 1024) } };
  expect(() => assertMcpWorkspaceBudget([{ ...layer, features: [tooLarge] }])).toThrow("超过100MB");
  expect(() => assertMcpWorkspaceBudget([layer])).not.toThrow();
});
it("MCP快照总要素预算在任何IPC构造前失败", () => {
  const feature: GeoFeature = { id: "1", geometry: null, properties: {} };
  expect(() => assertMcpWorkspaceBudget([{ id: "a", name: "a", features: Array(100001).fill(feature) }])).toThrow("100000要素");
});
