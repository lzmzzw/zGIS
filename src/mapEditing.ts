import type { Geometry, Position } from "geojson";

/** 只记录已点击节点；坐标为 WGS84，不包含跟随鼠标的预览点。 */
export interface DrawDraft {
  type: "LineString" | "Polygon";
  coordinates: Position[];
}

export function geometryVertices(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  const ring = (coordinates: Position[]) => coordinates.slice(0, -1);
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
      return geometry.coordinates.flat();
    case "Polygon":
      return geometry.coordinates.flatMap(ring);
    case "MultiPolygon":
      return geometry.coordinates.flatMap((polygon) => polygon.flatMap(ring));
    case "GeometryCollection":
      return geometry.geometries.flatMap(geometryVertices);
  }
}

export function canFinishDraft(draft: DrawDraft | null | undefined): boolean {
  return Boolean(
    draft && draft.coordinates.length >= (draft.type === "Polygon" ? 3 : 2),
  );
}

function firstCoordinate(coordinates: unknown): Position | undefined {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number") return coordinates as Position;
  for (const part of coordinates) {
    const coordinate = firstCoordinate(part);
    if (coordinate) return coordinate;
  }
}

function referenceCoordinate(geometry: Geometry | null): Position | undefined {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    for (const part of geometry.geometries) {
      const coordinate = referenceCoordinate(part);
      if (coordinate) return coordinate;
    }
    return;
  }
  return firstCoordinate(geometry.coordinates);
}

/** 空新图层延续 XYZ 默认值；已有二维图层添加 XY，已有高程图层添加 XYZ。 */
export function prepareDrawnGeometry(
  geometry: Geometry,
  references: Iterable<Geometry | null>,
): Geometry {
  let dimension = 3;
  let hasReference = false;
  for (const reference of references) {
    const coordinate = referenceCoordinate(reference);
    if (!coordinate || coordinate.length < 2) continue;
    if (!hasReference) dimension = 2;
    hasReference = true;
    if (coordinate.length >= 3) {
      dimension = 3;
      break;
    }
  }
  const applyDimension = (coordinates: unknown): unknown => {
    if (!Array.isArray(coordinates)) return coordinates;
    if (typeof coordinates[0] === "number")
      return dimension === 2
        ? coordinates.slice(0, 2)
        : [coordinates[0], coordinates[1], coordinates[2] ?? 0];
    return coordinates.map(applyDimension);
  };
  const convert = (part: Geometry): Geometry =>
    part.type === "GeometryCollection"
      ? { ...part, geometries: part.geometries.map(convert) }
      : ({
          ...part,
          coordinates: applyDimension(part.coordinates),
        } as Geometry);
  return convert(geometry);
}

function sameXY(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** OpenLayers 插入顶点默认填 0；只修复新增点的额外维度，原顶点仍由 OL 保留。 */
function preserveInsertedOrdinates(
  before: Position[],
  after: Position[],
  insertion?: Position,
): Position[] {
  if (
    after.length !== before.length + 1 ||
    !before.some((point) => point.length > 2)
  )
    return after;
  let index = 0;
  while (index < before.length && sameXY(before[index], after[index])) index++;
  if (index === 0 || index >= before.length) return after;
  if (
    !before
      .slice(index)
      .every((point, offset) => sameXY(point, after[index + offset + 1]))
  )
    return after;
  const a = before[index - 1];
  const b = before[index];
  const point = after[index];
  const location = insertion ?? point;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((location[0] - a[0]) * dx + (location[1] - a[1]) * dy) /
              lengthSquared,
          ),
        );
  const repaired = point.slice(0, 2);
  for (
    let dimension = 2;
    dimension < Math.max(a.length, b.length);
    dimension++
  ) {
    const start = a[dimension] ?? b[dimension];
    const end = b[dimension] ?? a[dimension];
    repaired.push(start + (end - start) * t);
  }
  return after.map((coordinate, offset) =>
    offset === index ? repaired : coordinate,
  );
}

export function preserveInsertedDimensions(
  before: Geometry,
  after: Geometry,
  insertion?: Position,
): Geometry {
  if (before.type !== after.type) return after;
  switch (after.type) {
    case "LineString":
      return before.type === "LineString"
        ? {
            ...after,
            coordinates: preserveInsertedOrdinates(
              before.coordinates,
              after.coordinates,
              insertion,
            ),
          }
        : after;
    case "Polygon":
    case "MultiLineString":
      if (before.type !== "Polygon" && before.type !== "MultiLineString")
        return after;
      return {
        ...after,
        coordinates: after.coordinates.map((part, index) =>
          before.coordinates[index]
            ? preserveInsertedOrdinates(
                before.coordinates[index],
                part,
                insertion,
              )
            : part,
        ),
      };
    case "MultiPolygon":
      return before.type === "MultiPolygon"
        ? {
            ...after,
            coordinates: after.coordinates.map((polygon, polygonIndex) =>
              polygon.map((part, ringIndex) =>
                before.coordinates[polygonIndex]?.[ringIndex]
                  ? preserveInsertedOrdinates(
                      before.coordinates[polygonIndex][ringIndex],
                      part,
                      insertion,
                    )
                  : part,
              ),
            ),
          }
        : after;
    case "GeometryCollection":
      return before.type === "GeometryCollection"
        ? {
            ...after,
            geometries: after.geometries.map((geometry, index) =>
              before.geometries[index]
                ? preserveInsertedDimensions(
                    before.geometries[index],
                    geometry,
                    insertion,
                  )
                : geometry,
            ),
          }
        : after;
    default:
      return after;
  }
}
