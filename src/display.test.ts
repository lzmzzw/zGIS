import { describe, expect, it } from "vitest";
import Feature from "ol/Feature";
import { makeLayer, exportGeoJSON } from "./domain";
import {
  categoryColor,
  createCategorizedStyle,
  normalizeCategorizedStyle,
  reconcileDisplayFieldChange,
} from "./layerDisplay";
import { createLayerDisplayStyle } from "./mapDisplayStyle";
import { snapshotLayers, restoreLayers } from "./workspace";

const make = (values: unknown[]) =>
  makeLayer(
    "display.geojson",
    values.map((value, index) => ({
      id: String(index),
      geometry: {
        type: "Point" as const,
        coordinates: [114 + index * 0.001, 30],
      },
      properties: value === undefined ? {} : { kind: value },
    })),
    "geojson",
  );
describe("categorized display", () => {
  it("distinguishes typed values, null, missing and complex values", () => {
    const layer = make([1, "1", true, null, undefined, { nested: 1 }]);
    const style = createCategorizedStyle(layer, "kind");
    expect(style.categories.map((item) => item.value)).toEqual([1, "1", true]);
    expect(categoryColor(layer.features[0].properties, style)).not.toBe(
      categoryColor(layer.features[1].properties, style),
    );
    expect(categoryColor({ kind: null }, style)).toBe(style.nullColor);
    expect(categoryColor({}, style)).toBe(style.missingColor);
    expect(categoryColor({ kind: {} }, style)).toBe(style.otherColor);
  });
  it("bounds categories and sends later values to Other without changing properties", () => {
    const layer = make(Array.from({ length: 10000 }, (_, i) => i));
    const original = JSON.stringify(layer.features);
    const style = createCategorizedStyle(layer, "kind");
    expect(style.categories).toHaveLength(32);
    expect(
      new Set(style.categories.map((category) => category.color)).size,
    ).toBe(32);
    expect(categoryColor({ kind: 9999 }, style)).toBe(style.otherColor);
    expect(JSON.stringify(layer.features)).toBe(original);
  });
  it("safely restores old snapshots and rejects malformed display configuration", () => {
    let layer = make(["中文", 1]);
    expect(
      restoreLayers(snapshotLayers([layer]))[0].categorizedStyle,
    ).toBeUndefined();
    layer = {
      ...layer,
      categorizedStyle: createCategorizedStyle(layer, "kind"),
    };
    expect(restoreLayers(snapshotLayers([layer]))[0].categorizedStyle).toEqual(
      layer.categorizedStyle,
    );
    expect(
      normalizeCategorizedStyle({
        ...layer.categorizedStyle,
        categories: Array(33).fill({ value: 1, color: "#123456" }),
      }),
    ).toBeUndefined();
    expect(
      normalizeCategorizedStyle({
        ...layer.categorizedStyle,
        otherColor: "url(secret)",
      }),
    ).toBeUndefined();
    expect(
      normalizeCategorizedStyle({
        ...layer.categorizedStyle,
        categories: [{ value: {}, color: "#123456" }],
      }),
    ).toBeUndefined();
    expect(exportGeoJSON(layer.features)).not.toContain("categorizedStyle");
  });
  it("follows an explicit field rename and resets on deletion", () => {
    const layer = make([1]);
    layer.categorizedStyle = createCategorizedStyle(layer, "kind");
    expect(
      reconcileDisplayFieldChange(layer, "kind", "类别").categorizedStyle
        ?.field,
    ).toBe("类别");
    expect(
      reconcileDisplayFieldChange(layer, "kind").categorizedStyle,
    ).toBeUndefined();
    expect(reconcileDisplayFieldChange(layer, "another")).toBe(layer);
  });
  it("uses document properties rather than copying geometry attributes into OL", () => {
    const layer = make(["first", "second"]);
    layer.categorizedStyle = createCategorizedStyle(layer, "kind");
    const render = createLayerDisplayStyle(layer);
    expect(typeof render).toBe("function");
    if (typeof render !== "function")
      throw new Error("expected style function");
    const feature = new Feature();
    feature.setId("1");
    const result = render(feature, 1);
    expect(Array.isArray(result)).toBe(false);
    if (!result || Array.isArray(result)) throw new Error("expected one style");
    expect(result.getStroke()?.getColor()).toBe(
      layer.categorizedStyle.categories[1].color,
    );
    layer.features = [{ ...layer.features[1], properties: { kind: "first" } }];
    const updated = createLayerDisplayStyle(layer);
    if (typeof updated !== "function")
      throw new Error("expected style function");
    const next = updated(feature, 1);
    if (!next || Array.isArray(next)) throw new Error("expected one style");
    expect(next.getStroke()?.getColor()).toBe(
      layer.categorizedStyle.categories[0].color,
    );
  });
});
