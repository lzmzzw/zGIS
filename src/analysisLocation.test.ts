import { expect, it } from "vitest";
import { makeLayer } from "./domain";
import { captureAnalysisLocation, locateAnalysisIssue, refreshAnalysisLocation } from "./analysisLocation";

const layer = () => makeLayer("test", ["a", "b", "c"].map(id => ({ type: "Feature" as const, id, geometry: null, properties: {} })), "geojson");
it("问题索引映射到分析子集而不是整层序号，并支持双方定位", () => {
  const source = layer();
  const snapshot = captureAnalysisLocation(source, [source.features[2], source.features[0]]);
  expect(locateAnalysisIssue(snapshot, [source], { kind: "polygon_overlap", featureIndices: [0, 1] })?.featureIds).toEqual(["c", "a"]);
  expect(locateAnalysisIssue(snapshot, [source], { kind: "invalid_geometry", featureIndex: 0 })?.fit).toBe(false);
  for (const featureIndex of [-1, 2, 0.5, "0"]) expect(locateAnalysisIssue(snapshot, [source], { featureIndex })).toBeUndefined();
});
it("数据改动或移除永久失效，样式改动不失效", () => {
  const source = layer();
  const snapshot = captureAnalysisLocation(source, source.features);
  expect(refreshAnalysisLocation(snapshot, [{ ...source, color: "#000000" }])).toBe(true);
  expect(refreshAnalysisLocation(snapshot, [{ ...source, features: [...source.features].reverse() }])).toBe(false);
  expect(refreshAnalysisLocation(snapshot, [source])).toBe(false);
  const removed = captureAnalysisLocation(source, source.features);
  expect(refreshAnalysisLocation(removed, [])).toBe(false);
});
