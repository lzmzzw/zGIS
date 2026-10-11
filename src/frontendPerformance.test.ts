import { describe, expect, it } from "vitest";
import { createRecoveryWriter } from "./recoveryWriter";
import { searchFeatures } from "./attributeSearch";
import { makeLayer, type GeoFeature } from "./domain";
import { restoreWorkspace, snapshotWorkspace } from "./workspace";
import { sameFeatures } from "./featureEquality";

describe("recovery and search performance contracts", () => {
  it("coalesces pending autosaves but never drops explicit barriers", async () => {
    const calls: string[] = [], release: (() => void)[] = [];
    const write = createRecoveryWriter(content => { calls.push(content); return new Promise<void>(resolve => release.push(resolve)); });
    const promises = [write("first"), write("old"), write("latest"), write("exit", true), write("after")];
    expect(calls).toEqual(["first"]);
    for (const expected of ["latest", "exit", "after"]) {
      release.shift()!(); await Promise.resolve(); await Promise.resolve();
      expect(calls.at(-1)).toBe(expected);
    }
    release.shift()!(); expect(await Promise.all(promises)).toEqual(["first", "latest", "latest", "exit", "after"]);
    expect(calls).toEqual(["first", "latest", "exit", "after"]);
  });
  it("continues after a failed write and rejects its callers", async () => {
    let calls = 0;
    const write = createRecoveryWriter(async () => { if (!calls++) throw new Error("disk full"); });
    const failed = write("failed");
    const next = write("retry", true);
    await expect(failed).rejects.toThrow("disk full"); await next;
  });
  it("preserves XYZ, stable publication IDs and edited immutable versions", () => {
    const feature: GeoFeature = { id: "f", geometry: { type: "Point", coordinates: [100, 30, 8] }, properties: { name: "Before" } };
    const layer = makeLayer("result", [feature], "geojson", { id: "mcp-publication-abc", dirty: true });
    const tree = [{ kind: "layer" as const, id: layer.id }];
    snapshotWorkspace([layer], tree);
    const next = { ...layer, features: [{ ...feature, properties: { name: "After" } }] };
    const raw = snapshotWorkspace([next], tree, { layerId: layer.id, tool: "select", snapping: false, history: { undo: [layer.features], redo: [], baseline: { features: layer.features, dirty: true } } });
    const restored = restoreWorkspace(raw);
    expect(restored.layers[0].id).toBe(layer.id);
    expect(restored.layers[0].features[0].properties.name).toBe("After");
    expect(restored.session?.history?.undo[0][0].geometry).toEqual(feature.geometry);
    expect(searchFeatures(layer.features, "before")).toHaveLength(1);
    expect(searchFeatures(next.features, "before")).toHaveLength(0);
    expect(searchFeatures(next.features, "AFTER")).toHaveLength(1);
    expect(sameFeatures(layer.features, [...layer.features])).toBe(true);
    expect(sameFeatures(layer.features, next.features)).toBe(false);
    expect(sameFeatures(layer.features, structuredClone(layer.features))).toBe(true);
    expect(sameFeatures(layer.features, [{ ...feature, geometry: { type: "Point", coordinates: [100, 30, 9] } }])).toBe(false);
  });
});
