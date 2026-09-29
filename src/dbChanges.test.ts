import { it, expect } from "vitest";
import { databaseChanges } from "./dbChanges";
import type { GeoFeature } from "./domain";
it("提交计划携带更新与删除的原始基线，几何变化单独标记", () => {
  const one: GeoFeature = {
    id: "1",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties: { name: "原值" },
    dbKey: [1],
    baseline: "original",
  };
  const two: GeoFeature = { ...one, id: "2", dbKey: [2] };
  const changes = databaseChanges(
    [one, two],
    [
      { ...one, properties: { name: "新值" } },
      { ...one, id: "3" },
    ],
  );
  expect(changes.map((change) => change.kind)).toEqual([
    "update",
    "insert",
    "delete",
  ]);
  expect(changes[0]).toMatchObject({
    dbKey: [1],
    baseline: "original",
    geometryChanged: false,
  });
  expect(changes[2]).toMatchObject({ dbKey: [2], baseline: "original" });
  expect(databaseChanges([one], [one])).toEqual([]);
});
