import { describe, expect, it, vi } from "vitest";
import { collectText, smallText, textChunks, type TextContent } from "./textContent";
import { snapshotWorkspaceContent, restoreWorkspace } from "./workspace";
import { exportCsv, exportCsvContent, exportGeoJSON, exportGeoJSONContent, makeLayer, type GeoFeature } from "./domain";

describe("bounded text generation", () => {
  it("preserves Unicode across incoming fragments and bounded outgoing chunks", () => {
    const parts = ["中\ud83d", "\ude00abc", "\ud800", "-end"];
    const content: TextContent = { *chunks() { yield* parts; } };
    for (const limit of [2, 3, 4, 7, 16]) {
      const chunks = [...textChunks(content, limit)];
      expect(chunks.join("")).toBe(parts.join(""));
      expect(chunks.every(c => c.length <= limit)).toBe(true);
      expect(chunks.map(c => new TextDecoder().decode(new TextEncoder().encode(c))).join(""))
        .toBe(new TextDecoder().decode(new TextEncoder().encode(parts.join(""))));
    }
  });
  it("stops small journal collection early and can replay the same source", () => {
    let generated = 0;
    const source: TextContent = { *chunks() { for (let i = 0; i < 100; i++) { generated++; yield "x".repeat(256 * 1024); } } };
    expect(smallText(source, 512 * 1024)).toBeUndefined();
    expect(generated).toBeLessThan(5);
    expect([...textChunks({ *chunks() { yield ""; } })]).toEqual([]);
    expect(smallText({ *chunks() { yield "small"; } }, 5)).toBe("small");
  });
  it("freezes snapshot revision and history lists while retaining immutable feature versions", () => {
    const first: GeoFeature = { id: "f", geometry: { type: "Point", coordinates: [100, 30, 9] }, properties: { note: "中文😀", code: "9007199254740993" } };
    const layer = makeLayer("layer", [first], "geojson", { id: "layer", dirty: true });
    const undo = [[first]];
    const source = snapshotWorkspaceContent([layer], [{ kind: "layer", id: "layer" }], {
      layerId: "layer", tool: "select", snapping: false, history: { undo, redo: [] },
    });
    const before = collectText(source);
    undo.push([{ ...first, properties: { note: "later" } }]);
    const after = collectText(source);
    expect(after).toBe(before);
    const restored = restoreWorkspace(after);
    expect(restored.session?.history?.undo).toHaveLength(1);
    expect(restored.layers[0].features[0]).toMatchObject(first);
  });
  it("does not encode complete feature arrays and can stop before visiting later records", () => {
    const features = Array.from({ length: 5000 }, (_, i): GeoFeature => ({ id: `f${i}`, geometry: null, properties: { note: "n".repeat(2048), index: i } }));
    const layer = makeLayer("large", features, "geojson");
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const source = snapshotWorkspaceContent([layer], [{ kind: "layer", id: layer.id }]);
      expect(stringify.mock.calls.some(([v]) => v?.properties?.note)).toBe(false);
      const iterator = textChunks(source);
      expect(iterator.next().value?.length).toBeLessThanOrEqual(256 * 1024);
      iterator.return(undefined);
      const records = stringify.mock.calls.filter(([v]) => v?.properties?.note);
      expect(records.length).toBeGreaterThan(0);
      expect(records.length).toBeLessThan(200);
      expect(stringify.mock.calls.some(([v]) => Array.isArray(v) && v.length > 100)).toBe(false);
    } finally { stringify.mockRestore(); }
  });
});

describe("incremental file export", () => {
  const features: GeoFeature[] = [
    { id: "a", sourceFeatureId: "9007199254740993", geometry: { type: "Point", coordinates: [116, 40, 7] }, properties: { name: 'a,"b', nested: { exact: "0.1000000000000000001" }, x: 5, y: 6 } },
    { id: "b", geometry: null, properties: { later: "新\n行😀", name: null } },
  ];
  it.each(["EPSG:4326", "EPSG:4490", "EPSG:3857"])("matches complete GeoJSON semantics for %s", crs => {
    const source = exportGeoJSONContent(features, crs);
    expect(JSON.parse(collectText(source))).toEqual(JSON.parse(exportGeoJSON(features, crs)));
    expect(collectText(source)).toBe(collectText(source));
  });
  it("preserves ordered CSV fields, nested values, quotes, multi-line text and geometry columns", () => {
    const source = exportCsvContent(features, { mode: "wkt", xColumn: "x", yColumn: "y", wktColumn: "shape" });
    const raw = collectText(source);
    expect(raw).toBe('name,nested,shape,later\r\n"a,""b","{""exact"":""0.1000000000000000001""}",POINT Z(116 40 7),\r\n,,,"新\n行😀"');
    expect(exportCsv(features, { mode: "wkt", xColumn: "x", yColumn: "y", wktColumn: "shape" })).toBe(raw);
    expect(collectText(exportCsvContent([], { mode: "wkt" }))).toBe("");
  });
  it("rejects invalid later geometry during incremental output without mutating the source", () => {
    const before = structuredClone(features);
    expect(() => collectText(exportCsvContent(features, { mode: "xy" }))).toThrow("高程");
    expect(features).toEqual(before);
  });
});
