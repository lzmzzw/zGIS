import { describe, expect, it } from "vitest";
import Feature from "ol/Feature";
import { makeLayer, exportGeoJSON } from "./domain";
import {
  createCategorizedStyle,
  createGraduatedStyle,
  graduatedIndex,
  layerLegendItems,
  normalizeGraduatedStyle,
  isDisplayNumber,
  parseManualBreaks,
} from "./layerDisplay";
import { snapshotLayers, restoreLayers } from "./workspace";
import { createLayerDisplayStyle } from "./mapDisplayStyle";

const layerOf = (values: unknown[]) =>
  makeLayer(
    "numeric.geojson",
    values.map((value, index) => ({
      id: String(index),
      properties: value === undefined ? {} : { value },
      geometry: { type: "Point" as const, coordinates: [114, 30, 9] },
    })),
    "geojson",
  );
describe("graduated colors and legends", () => {
  it("rejects empty manual tokens instead of silently introducing zero", () => {
    for (const input of ["-10,", ",10", "1,,3", "1; ;3", "，", "0x10", "1,Infinity"])
      expect(() => parseManualBreaks(input)).toThrow("严格递增");
    expect(parseManualBreaks(" -10, 0; 1e1 \n20 ")).toEqual([-10, 0, 10, 20]);
    expect(parseManualBreaks("   ")).toEqual([]);
  });
  it("builds equal intervals and assigns exact bounds to the lower class", () => {
    const style = createGraduatedStyle(
      layerOf([-10, 0, 10, 20]),
      "value",
      "equal_interval",
      3,
    );
    expect(style.breaks).toEqual([0, 10]);
    expect(
      [-20, 0, 1, 10, 11, 30].map((value) => graduatedIndex({ value }, style)),
    ).toEqual([0, 0, 1, 1, 2, 2]);
    expect(style.colors).toHaveLength(3);
  });
  it("uses nearest-rank quantiles without splitting ties and collapses constants", () => {
    const style = createGraduatedStyle(
      layerOf([1, 1, 1, 2, 3, 4]),
      "value",
      "quantile",
      3,
    );
    expect(style.breaks).toEqual([1, 2]);
    expect(
      createGraduatedStyle(layerOf([7, 7, 7]), "value", "quantile", 5).breaks,
    ).toEqual([]);
    expect(
      createGraduatedStyle(layerOf([7, 7]), "value", "equal_interval", 5)
        .colors,
    ).toHaveLength(1);
    expect(
      createGraduatedStyle(layerOf([1, 1, 1, 1, 2]), "value", "quantile", 5)
        .breaks,
    ).toEqual([1]);
  });
  it("rejects unsafe inputs and distinguishes null, missing and unsupported values", () => {
    const layer = layerOf([
      0,
      10,
      null,
      undefined,
      "5",
      {},
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]);
    const style = createGraduatedStyle(layer, "value", "equal_interval", 2);
    expect(style.breaks).toEqual([5]);
    expect(
      layer.features.map((feature) =>
        graduatedIndex(feature.properties, style),
      ),
    ).toEqual([0, 1, "null", "missing", "other", "other", "other", "other"]);
    expect(isDisplayNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isDisplayNumber(-Number.MAX_SAFE_INTEGER - 1)).toBe(false);
    expect(() => createGraduatedStyle(layerOf([null, "5"]), "value")).toThrow(
      "没有可分级",
    );
    expect(() =>
      createGraduatedStyle(layer, "value", "equal_interval", 33),
    ).toThrow("1至32");
  });
  it("validates manual breaks and retains them after data changes and recovery", () => {
    const source = layerOf([1, 5, 20]);
    const style = createGraduatedStyle(source, "value", "manual", 3, [3, 9]);
    const layer = { ...source, graduatedStyle: style };
    const changed = { ...layer, features: layerOf([-100, 1000]).features };
    expect(restoreLayers(snapshotLayers([changed]))[0].graduatedStyle).toEqual(
      style,
    );
    expect(
      restoreLayers(snapshotLayers([source]))[0].graduatedStyle,
    ).toBeUndefined();
    expect(exportGeoJSON(layer.features)).not.toContain("breaks");
    for (const breaks of [
      [1, 1],
      [9, 3],
      [NaN],
      [Number.MAX_SAFE_INTEGER + 1],
      Array.from({ length: 32 }, (_, i) => i),
    ]) {
      expect(() =>
        createGraduatedStyle(source, "value", "manual", 3, breaks),
      ).toThrow();
      expect(normalizeGraduatedStyle({ ...style, breaks })).toBeUndefined();
    }
    expect(
      normalizeGraduatedStyle({ ...style, colors: ["#ffffff"] }),
    ).toBeUndefined();
    expect(
      normalizeGraduatedStyle({ ...style, missingColor: "url(secret)" }),
    ).toBeUndefined();
  });
  it("renders graduated colors from source properties and leaves geometry unchanged", () => {
    const layer = layerOf([1, 5, 20]);
    layer.graduatedStyle = createGraduatedStyle(
      layer,
      "value",
      "manual",
      3,
      [3, 9],
    );
    const before = JSON.stringify(layer.features);
    const render = createLayerDisplayStyle(layer);
    if (typeof render !== "function") throw new Error("expected function");
    const feature = new Feature();
    feature.setId("1");
    const style = render(feature, 1);
    if (!style || Array.isArray(style)) throw new Error("expected one style");
    expect(style.getStroke()?.getColor()).toBe(layer.graduatedStyle.colors[1]);
    expect(JSON.stringify(layer.features)).toBe(before);
  });
  it("counts every feature once without filtering and follows missing/restored fields", () => {
    const layer = layerOf([1, 5, 20, null, undefined, "5"]);
    layer.graduatedStyle = createGraduatedStyle(
      layer,
      "value",
      "manual",
      3,
      [3, 9],
    );
    const entries = layerLegendItems(layer);
    expect(entries.map((entry) => entry.count)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(entries.map((entry) => entry.label).slice(0, 3)).toEqual([
      "≤ 3",
      "(3, 9]",
      "> 9",
    ]);
    expect(entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(
      layer.features.length,
    );
    const removed = {
      ...layer,
      features: layer.features.map((feature) => ({
        ...feature,
        properties: {},
      })),
    };
    expect(
      layerLegendItems(removed).find((entry) => entry.key === "missing")?.count,
    ).toBe(6);
    expect(layerLegendItems({ ...removed, features: layer.features })).toEqual(
      entries,
    );
    const categorized = layerOf([1, "1", true, null, undefined, {}]);
    categorized.categorizedStyle = createCategorizedStyle(categorized, "value");
    expect(layerLegendItems(categorized).map((entry) => entry.count)).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    expect(layerLegendItems(layerOf([1, 2]))[0].count).toBe(2);
  });
});
