import { afterEach, expect, it, vi } from "vitest";
import VectorSource from "ol/source/Vector";
import type Feature from "ol/Feature";
import type Geometry from "ol/geom/Geometry";
import { scheduleMapFeatures } from "./mapLayerSync";
import { searchFeatures, searchFeaturesCooperatively } from "./attributeSearch";
import type { GeoFeature } from "./domain/types";

const features = (count: number): GeoFeature[] => Array.from({ length: count }, (_, index) => ({
  id: String(index),
  geometry: { type: "Point", coordinates: [100 + index / 100_000, 30, index] },
  properties: { name: `feature-${index}`, nested: { code: index }, missing: null },
}));
afterEach(() => vi.useRealTimers());

it("大图层搜索在片间响应取消，完整结果与逐字段搜索一致", async () => {
  vi.useFakeTimers();
  const input = features(10_000);
  const cancelled = new AbortController();
  const first = searchFeaturesCooperatively(input, "feature", cancelled.signal);
  cancelled.abort();
  await vi.runAllTimersAsync();
  expect(await first).toBeUndefined();
  const next = searchFeaturesCooperatively(input, "FEATURE-99", new AbortController().signal);
  await vi.runAllTimersAsync();
  expect(await next).toEqual(searchFeatures(input, "FEATURE-99"));
  expect((await next)?.at(-1)?.id).toBe("9999");
});

it("大图层分片显示保留全部要素、XYZ和要素身份", async () => {
  vi.useFakeTimers();
  const source = new VectorSource();
  const refs = new WeakMap<Feature<Geometry>, GeoFeature["geometry"]>();
  const input = features(10_000);
  const complete = vi.fn();
  scheduleMapFeatures(source, input, refs, complete);
  expect(source.getFeatures()).toHaveLength(0);
  await vi.runAllTimersAsync();
  expect(complete).toHaveBeenCalledOnce();
  expect(source.getFeatures()).toHaveLength(input.length);
  const original = source.getFeatureById("9999")!;
  expect((original.getGeometry() as Geometry & { getCoordinates(): number[] }).getCoordinates()[2]).toBe(9999);
  scheduleMapFeatures(source, input.slice(5000), refs, complete);
  await vi.runAllTimersAsync();
  expect(source.getFeatures()).toHaveLength(5000);
  expect(source.getFeatureById("9999")).toBe(original);
  expect(source.getFeatureById("0")).toBeNull();
});

it("取消旧显示作业后只完成新版本，手势期间暂停写入", async () => {
  vi.useFakeTimers();
  const source = new VectorSource();
  const refs = new WeakMap<Feature<Geometry>, GeoFeature["geometry"]>();
  const obsolete = vi.fn(), complete = vi.fn();
  const cancel = scheduleMapFeatures(source, features(3000), refs, obsolete);
  await vi.advanceTimersToNextTimerAsync();
  cancel();
  let gesture = true;
  scheduleMapFeatures(source, features(2001), refs, complete, () => gesture);
  await vi.advanceTimersByTimeAsync(32);
  expect(complete).not.toHaveBeenCalled();
  gesture = false;
  await vi.runAllTimersAsync();
  expect(obsolete).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
  expect(source.getFeatures()).toHaveLength(2001);
});
