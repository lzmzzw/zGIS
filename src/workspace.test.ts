import { expect, it } from "vitest";
import { makeLayer } from "./domain";
import { restoreLayers, snapshotLayers } from "./workspace";

it("恢复只保留内容和样式，数据库身份及基线不进入快照", () => {
  const layer = makeLayer(
    "database",
    [
      {
        id: "f",
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { a: 1 },
        dbKey: [1],
        baseline: "secret-baseline",
      },
    ],
    "postgis",
    { sourceId: "source", opacity: 0.5, strokeWidth: 4 },
  );
  const snapshot = snapshotLayers([layer]);
  expect(snapshot).not.toContain("baseline");
  expect(snapshot).not.toContain("sourceId");
  expect(snapshot).not.toContain("dbKey");
  const [restored] = restoreLayers(snapshot);
  expect(restored).toMatchObject({
    sourceKind: "geojson",
    dirty: true,
    restored: true,
    opacity: 0.5,
    strokeWidth: 4,
  });
  expect(restored.db).toBeUndefined();
  expect(restored.features[0].properties).toEqual({ a: 1 });
});

it("无效恢复内容被拒绝，不静默跳过或降低维度", () => {
  expect(() => restoreLayers("{}")).toThrow("图层列表");
  expect(() =>
    restoreLayers(
      '[{"name":"bad","features":[{"geometry":{"type":"Point","coordinates":[1,2,3,4]},"properties":{}}]}]',
    ),
  ).toThrow("XYZ");
});

it("XYZ 恢复保留高程", () => {
 const layer = makeLayer("height", [{id:"z", geometry:{type:"Point",coordinates:[1,2,12.5]},properties:{}}], "geojson");
 expect(restoreLayers(snapshotLayers([layer]))[0].features[0].geometry).toEqual(layer.features[0].geometry);
});
