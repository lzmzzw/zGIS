import type { Geometry } from "geojson";
import type { DocumentLayer } from "./domain/types";

export type GeometryKind = "point" | "line" | "polygon";

export function layerGeometryKinds(layer: DocumentLayer): GeometryKind[] {
  const kinds = new Set<GeometryKind>();
  const visit = (geometry: Geometry | null) => {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection")
      geometry.geometries.forEach(visit);
    else if (geometry.type === "Point" || geometry.type === "MultiPoint")
      kinds.add("point");
    else if (
      geometry.type === "LineString" ||
      geometry.type === "MultiLineString"
    )
      kinds.add("line");
    else kinds.add("polygon");
  };
  for (const feature of layer.features) {
    visit(feature.geometry);
    if (kinds.size === 3) break;
  }
  if (!kinds.size && layer.geometryType)
    kinds.add(
      layer.geometryType === "Point"
        ? "point"
        : layer.geometryType === "LineString"
          ? "line"
          : "polygon",
    );
  return (["point", "line", "polygon"] as const).filter((kind) =>
    kinds.has(kind),
  );
}
