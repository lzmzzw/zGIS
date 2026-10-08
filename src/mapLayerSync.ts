import Feature from "ol/Feature";
import GeoJSON from "ol/format/GeoJSON";
import type Geometry from "ol/geom/Geometry";
import type VectorSource from "ol/source/Vector";
import type { GeoFeature } from "./domain/types";

const format = new GeoJSON();
const projection = {
  dataProjection: "EPSG:4326",
  featureProjection: "EPSG:3857",
};

// 地图仅持有几何和标识；属性以文档为准，避免业务 geometry 字段覆盖 OL 几何。
export function syncMapFeatures(
  source: VectorSource,
  features: GeoFeature[],
  geometries: WeakMap<Feature<Geometry>, GeoFeature["geometry"]>,
  gestureActive = false,
): void {
  const ids = new Set(features.map((feature) => feature.id));
  for (const feature of source.getFeatures()) {
    if (!ids.has(String(feature.getId()))) source.removeFeature(feature);
  }
  const added: Feature<Geometry>[] = [];
  for (const data of features) {
    const existing = source.getFeatureById(data.id);
    if (existing) {
      if (!gestureActive && geometries.get(existing) !== data.geometry) {
        existing.setGeometry(
          data.geometry
            ? format.readGeometry(data.geometry, projection)
            : undefined,
        );
        geometries.set(existing, data.geometry);
      }
    } else {
      const feature = new Feature<Geometry>();
      feature.setId(data.id);
      if (data.geometry)
        feature.setGeometry(format.readGeometry(data.geometry, projection));
      geometries.set(feature, data.geometry);
      added.push(feature);
    }
  }
  // OL 通过 addFeatures 批量建立空间索引，避免逐条插入和重复 change 通知。
  if (added.length) source.addFeatures(added);
}
