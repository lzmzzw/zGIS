import { expect, it, vi } from "vitest";
import VectorSource from "ol/source/Vector";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import { syncMapFeatures } from "./mapLayerSync";
import type { GeoFeature } from "./domain/types";

const point = (id: string, x = 116): GeoFeature => ({
  id,
  geometry: { type: "Point", coordinates: [x, 40, 10] },
  properties: { geometry: "业务字段", name: id },
});

it("地图同步保留 XYZ、空几何和要素身份，业务 geometry 字段不覆盖图形", () => {
  const source = new VectorSource();
  const references = new WeakMap<Feature<Geometry>, GeoFeature["geometry"]>();
  const first = point("first");
  syncMapFeatures(
    source,
    [first, { ...point("empty"), geometry: null }],
    references,
  );
  const feature = source.getFeatureById("first")!;
  expect(feature.getGeometry()?.getType()).toBe("Point");
  expect(feature.getGeometry()?.getExtent().every(Number.isFinite)).toBe(true);
  expect(source.getFeatureById("empty")?.getGeometry()).toBeUndefined();
  const unchanged = vi.spyOn(feature, "setGeometry");
  syncMapFeatures(
    source,
    [{ ...first, properties: { geometry: "新业务值" } }],
    references,
  );
  expect(unchanged).not.toHaveBeenCalled();
  expect(source.getFeatureById("first")).toBe(feature);
  expect(source.getFeatureById("empty")).toBeNull();
  syncMapFeatures(source, [point("first", 117)], references);
  expect(unchanged).toHaveBeenCalledOnce();
  expect(
    (
      feature.getGeometry() as Geometry & { getCoordinates(): number[] }
    ).getCoordinates()[2],
  ).toBe(10);
  syncMapFeatures(source, [{ ...first, geometry: null }], references);
  expect(feature.getGeometry()).toBeUndefined();
});

it("大批新增要素批量建立空间索引，拖动中不覆盖临时几何", () => {
  const source = new VectorSource();
  const references = new WeakMap<Feature<Geometry>, GeoFeature["geometry"]>();
  const add = vi.spyOn(source, "addFeatures");
  const features = Array.from({ length: 2_000 }, (_, index) =>
    point(String(index), 116 + index / 10_000),
  );
  syncMapFeatures(source, features, references);
  expect(add).toHaveBeenCalledOnce();
  expect(source.getFeatures()).toHaveLength(features.length);
  const feature = source.getFeatureById("0")!;
  const geometry = feature.getGeometry();
  syncMapFeatures(source, [point("0", 117)], references, true);
  expect(feature.getGeometry()).toBe(geometry);
  syncMapFeatures(source, [point("0", 117)], references);
  expect(feature.getGeometry()).not.toBe(geometry);
});
