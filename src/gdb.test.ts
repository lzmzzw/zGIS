import { describe, expect, it } from "vitest";
import {
  assertWritableLayer,
  isGdbLayer,
  makeGdbLayer,
  safeGdbSource,
  validateGdbBounds,
  type GdbCatalog,
  type GdbReadResult,
} from "./gdb";
import { exportGeoJSON, makeLayer } from "./domain";
import {
  restoreLayers,
  restoreWorkspace,
  snapshotLayers,
  snapshotWorkspace,
} from "./workspace";
import { layerSource } from "./layerSource";

const catalog: GdbCatalog = {
  sourceId: "ephemeral-handle",
  path: "C:/数据/源.gdb.zip",
  fingerprint: "fingerprint",
  layers: [],
  warnings: [],
};
const result: GdbReadResult = {
  features: [
    {
      id: "row-1",
      sourceFeatureId: "9007199254740993",
      geometry: { type: "Point", coordinates: [116, 39, 12] },
      properties: {
        name: "道路",
        code: "9007199254740993",
        missing: null,
        empty: "",
      },
    },
  ],
  sourceCrs: "EPSG:4490",
  sourceCrsWkt: 'GEOGCS["CGCS2000"]',
  fields: [
    {
      name: "name",
      type: "String",
      nullable: true,
      alias: "名称",
      domain: '{"1":"道路"}',
    },
    { name: "code", type: "Integer64", nullable: false },
  ],
  geometryType: "Point Z",
  warnings: ["CGCS2000 approximation"],
  truncated: true,
  loadedCount: 1,
  readLimit: 1,
  bounds: [110, 30, 120, 40],
  sourceFingerprint: "fingerprint",
  transformation: "Approximate XY; Z unchanged",
};
const options = {
  layerName: "道路",
  fields: ["name", "code"],
  limit: 1,
  bounds: [110, 30, 120, 40],
  allowApproximateDatum: true,
};

describe("GDB identity and recovery", () => {
  it("accepts the native worker's null bounds as an unfiltered snapshot", () => {
    const layer = makeGdbLayer(catalog, { ...options, bounds: undefined }, { ...result, bounds: null });
    expect(layer.gdb?.bounds).toBeUndefined();
    expect(restoreLayers(snapshotLayers([layer]))[0].gdb?.bounds).toBeUndefined();
    expect(() => assertWritableLayer(layer)).toThrow("GDB 图层只读");
  });

  it("preserves read scope, types, source IDs, XYZ and null/empty across recovery without a live handle", () => {
    const layer = makeGdbLayer(catalog, options, result);
    expect(layerSource(layer)).toBe("gdb");
    expect(layer.sourceId).toBeUndefined();
    expect(layer.gdb).toMatchObject({
      layerName: "道路",
      readLimit: 1,
      loadedCount: 1,
      truncated: true,
      bounds: options.bounds,
      fields: result.fields,
      allowApproximateDatum: true,
    });
    const raw = snapshotLayers([layer]);
    expect(raw).not.toContain("ephemeral-handle");
    const restored = restoreLayers(raw)[0];
    expect(restored.sourceKind).toBe("gdb");
    expect(restored.sourcePath).toBe(catalog.path);
    expect(restored.gdb).toEqual(layer.gdb);
    expect(restored.features[0]).toMatchObject({
      ...result.features[0],
      id: layer.features[0].id,
    });
    expect(restored.dirty).toBe(false);
    expect(restored.warnings?.join(" ")).toContain("只读快照");
    expect(() => assertWritableLayer(restored)).toThrow("GDB 图层只读");
  });
  it("does not grant write access when paths are lost or sourceKind is disguised", () => {
    const layer = makeGdbLayer(catalog, options, result);
    expect(
      isGdbLayer({ ...layer, sourcePath: undefined, sourceId: undefined }),
    ).toBe(true);
    expect(isGdbLayer({ ...layer, sourceKind: "geojson" })).toBe(true);
    const raw = JSON.parse(snapshotLayers([layer]));
    raw[0].sourceKind = "geojson";
    expect(restoreLayers(JSON.stringify(raw))[0].sourceKind).toBe("gdb");
    delete raw[0].gdb;
    expect(() => restoreLayers(JSON.stringify(raw))).toThrow(
      "GDB 来源元数据无效",
    );
  });
  it("rejects tampered source metadata, field duplicates and count mismatches", () => {
    const layer = makeGdbLayer(catalog, options, result);
    expect(() =>
      safeGdbSource({
        ...layer.gdb,
        fields: [result.fields[0], result.fields[0]],
      }),
    ).toThrow("GDB 字段元数据无效");
    expect(() => safeGdbSource({ ...layer.gdb, readLimit: 100001 })).toThrow(
      "GDB 来源元数据无效",
    );
    const data = JSON.parse(snapshotLayers([layer]));
    data[0].features = [];
    expect(() => restoreLayers(JSON.stringify(data))).toThrow(
      "GDB 恢复副本与来源元数据不一致",
    );
    expect(() =>
      makeGdbLayer(catalog, options, { ...result, loadedCount: 2 }),
    ).toThrow("GDB 读取结果无效");
  });
  it("rejects edit sessions both when writing and restoring a GDB snapshot", () => {
    const layer = makeGdbLayer(catalog, options, result);
    const tree = [{ kind: "layer" as const, id: layer.id }];
    const session = {
      layerId: layer.id,
      tool: "modify" as const,
      snapping: false,
    };
    expect(() => snapshotWorkspace([layer], tree, session)).toThrow(
      "GDB 只读图层不能恢复编辑会话",
    );
    const data = JSON.parse(snapshotWorkspace([layer], tree));
    data.session = session;
    expect(() => restoreWorkspace(JSON.stringify(data))).toThrow(
      "GDB 只读图层不能恢复编辑会话",
    );
  });
  it("exports only loaded features without changing GDB identity; analysis copies remain writable", () => {
    const layer = makeGdbLayer(catalog, options, result);
    const before = snapshotLayers([layer]);
    const exported = JSON.parse(exportGeoJSON(layer.features));
    expect(exported.features).toHaveLength(1);
    expect(exported.features[0].geometry.coordinates).toEqual([116, 39, 12]);
    expect(exported.features[0].properties).toMatchObject({
      code: "9007199254740993",
      missing: null,
      empty: "",
    });
    expect(snapshotLayers([layer])).toBe(before);
    const analysis = makeLayer("analysis.geojson", layer.features, "geojson");
    expect(isGdbLayer(analysis)).toBe(false);
    expect(() => assertWritableLayer(analysis)).not.toThrow();
  });
});

it("validates extent, rejects antimeridian crossing, non-finite and incomplete bounds", () => {
  expect(validateGdbBounds([-180, -90, 180, 90])).toEqual([-180, -90, 180, 90]);
  for (const invalid of [
    [170, -10, -170, 10],
    [110, 20, 110, 30],
    [110, 20, 120],
    [NaN, 20, 120, 30],
    [-181, -90, 180, 90],
  ])
    expect(() => validateGdbBounds(invalid)).toThrow("GDB 范围");
});
