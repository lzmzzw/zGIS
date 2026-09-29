import {
  exportGeoJSON,
  importGeoJSON,
  makeLayer,
  type DocumentLayer,
} from "./domain";

// Recovery stores document content and visual settings, never source handles or database state.
export function snapshotLayers(layers: DocumentLayer[]): string {
  return JSON.stringify(
    layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      features: layer.features.map(
        ({ id, geometry, properties, sourceFeatureId }) => ({
          id,
          geometry,
          properties,
          sourceFeatureId,
        }),
      ),
      visible: layer.visible,
      color: layer.color,
      opacity: layer.opacity,
      strokeWidth: layer.strokeWidth,
      sourceKind: "geojson",
      restoredFrom: layer.restoredFrom ?? layer.sourceKind,
      crs: "EPSG:4326",
      dirty: layer.dirty,
    })),
  );
}

export function restoreLayers(raw: string): DocumentLayer[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("恢复文件必须是图层列表");
  return data.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.name !== "string" ||
      !Array.isArray(value.features)
    )
      throw new Error("恢复图层结构无效");
    const features = importGeoJSON(exportGeoJSON(value.features));
    return makeLayer(value.name, features, "geojson", {
      visible: value.visible !== false,
      color:
        typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
          ? value.color
          : "#5479b6",
      opacity:
        typeof value.opacity === "number" &&
        value.opacity >= 0 &&
        value.opacity <= 1
          ? value.opacity
          : 1,
      strokeWidth:
        typeof value.strokeWidth === "number" &&
        value.strokeWidth >= 1 &&
        value.strokeWidth <= 8
          ? value.strokeWidth
          : 2,
      dirty: true,
      restored: true,
      restoredFrom:
        typeof value.restoredFrom === "string"
          ? value.restoredFrom
          : typeof value.sourceKind === "string"
            ? value.sourceKind
            : "geojson",
      warnings: ["已恢复为本地 GeoJSON 副本，请另存文件。"],
    });
  });
}

export type ExitAction = "save" | "keep" | "submit" | "discard";
