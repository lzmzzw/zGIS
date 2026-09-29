import type { GeoFeature } from "./domain";
export interface DbChange {
  kind: "insert" | "update" | "delete";
  geometry?: GeoFeature["geometry"];
  properties?: GeoFeature["properties"];
  dbKey?: unknown;
  baseline?: unknown;
  geometryChanged?: boolean;
}
export function databaseChanges(
  before: GeoFeature[],
  after: GeoFeature[],
): DbChange[] {
  const oldMap = new Map(before.map((feature) => [feature.id, feature]));
  const nowMap = new Map(after.map((feature) => [feature.id, feature]));
  const changes: DbChange[] = [];
  for (const feature of after) {
    const old = oldMap.get(feature.id);
    if (!old)
      changes.push({
        kind: "insert",
        geometry: feature.geometry,
        properties: feature.properties,
      });
    else {
      const geometryChanged =
        JSON.stringify(old.geometry) !== JSON.stringify(feature.geometry);
      if (
        geometryChanged ||
        JSON.stringify(old.properties) !== JSON.stringify(feature.properties)
      )
        changes.push({
          kind: "update",
          dbKey: old.dbKey,
          baseline: old.baseline,
          geometry: feature.geometry,
          properties: feature.properties,
          geometryChanged,
        });
    }
  }
  for (const feature of before)
    if (!nowMap.has(feature.id))
      changes.push({
        kind: "delete",
        dbKey: feature.dbKey,
        baseline: feature.baseline,
      });
  return changes;
}
