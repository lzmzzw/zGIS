import { describe, expect, it } from "vitest";
import type { DocumentLayer } from "./domain/types";
import { createGraduatedStyle } from "./layerDisplay";
import { layerDisplayPatch, validateLayerDisplayPatch } from "./LayerInspector";

const source = (): DocumentLayer => ({
  id: "layer",
  name: "Layer",
  visible: true,
  color: "#123456",
  sourceKind: "geojson",
  crs: "EPSG:4326",
  dirty: false,
  features: [1, 2, 3].map((x) => ({
    id: String(x),
    geometry: null,
    properties: { x },
  })),
});
describe("layer inspector draft", () => {
  it("clones only display settings so edits do not mutate source data or style", () => {
    const layer = source();
    layer.graduatedStyle = createGraduatedStyle(layer, "x");
    const draft = layerDisplayPatch(layer);
    expect(draft.opacity).toBe(1);
    expect(draft.strokeWidth).toBe(2);
    expect(draft).not.toHaveProperty("features");
    draft.graduatedStyle!.colors[0] = "#ffffff";
    expect(layer.graduatedStyle.colors[0]).not.toBe("#ffffff");
    expect(layer.dirty).toBe(false);
  });
  it("rejects stale fields and invalid basic settings before apply", () => {
    const layer = source();
    const draft = layerDisplayPatch(layer);
    expect(validateLayerDisplayPatch(layer, draft)).toBeUndefined();
    expect(
      validateLayerDisplayPatch(layer, { ...draft, opacity: NaN }),
    ).toBeTruthy();
    expect(
      validateLayerDisplayPatch(layer, { ...draft, strokeWidth: 0 }),
    ).toBeTruthy();
    draft.graduatedStyle = createGraduatedStyle(layer, "x");
    expect(validateLayerDisplayPatch(layer, draft)).toBeUndefined();
    expect(validateLayerDisplayPatch({ ...layer, features: [] }, draft)).toBe(
      "样式引用的字段已不存在，请重新选择",
    );
    expect(
      validateLayerDisplayPatch(
        { ...layer, features: [], fieldNames: ["x"] },
        draft,
      ),
    ).toBe("分级字段没有安全数值，请重新选择");
  });
});
