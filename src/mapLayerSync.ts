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
const synced = new WeakMap<VectorSource, { features: GeoFeature[]; revision: number }>();

function upsertMapFeature(
  source: VectorSource, data: GeoFeature,
  geometries: WeakMap<Feature<Geometry>, GeoFeature["geometry"]>,
  added: Feature<Geometry>[], gestureActive: boolean,
) {
  const existing = source.getFeatureById(data.id);
  if (existing) {
    if (!gestureActive && geometries.get(existing) !== data.geometry) {
      existing.setGeometry(data.geometry ? format.readGeometry(data.geometry, projection) : undefined);
      geometries.set(existing, data.geometry);
    }
  } else {
    const feature = new Feature<Geometry>();
    feature.setId(data.id);
    if (data.geometry) feature.setGeometry(format.readGeometry(data.geometry, projection));
    geometries.set(feature, data.geometry);
    added.push(feature);
  }
}

// 地图仅持有几何和标识；属性以文档为准，避免业务 geometry 字段覆盖 OL 几何。
export function syncMapFeatures(
  source: VectorSource,
  features: GeoFeature[],
  geometries: WeakMap<Feature<Geometry>, GeoFeature["geometry"]>,
  gestureActive = false,
): void {
  const previous = synced.get(source);
  if (!gestureActive && previous?.features === features && previous.revision === source.getRevision()) return;
  const ids = new Set(features.map((feature) => feature.id));
  for (const feature of source.getFeatures()) {
    if (!ids.has(String(feature.getId()))) source.removeFeature(feature);
  }
  const added: Feature<Geometry>[] = [];
  for (const data of features) upsertMapFeature(source, data, geometries, added, gestureActive);
  // OL 通过 addFeatures 批量建立空间索引，避免逐条插入和重复 change 通知。
  if (added.length) source.addFeatures(added);
  if (!gestureActive) synced.set(source, { features, revision: source.getRevision() });
}

/** 大图层分片投影、移除和索引；取消只停止显示同步，文档始终保留全部数据。 */
export function scheduleMapFeatures(
  source: VectorSource,
  features: GeoFeature[],
  geometries: WeakMap<Feature<Geometry>, GeoFeature["geometry"]>,
  complete: () => void,
  gestureActive: () => boolean = () => false,
): () => void {
  synced.delete(source);
  const ids = new Set<string>();
  const previous = source.getFeatures();
  let phase = 0, index = 0, cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const step = () => {
    if (cancelled) return;
    if (gestureActive()) { timer = setTimeout(step, 16); return; }
    const start = performance.now();
    const added: Feature<Geometry>[] = [];
    let count = 0;
    do {
      if (phase === 0) {
        if (index < features.length) ids.add(features[index++].id);
        else { phase = 1; index = 0; }
      } else if (phase === 1) {
        if (index < previous.length) {
          const feature = previous[index++];
          if (!ids.has(String(feature.getId()))) source.removeFeature(feature);
        } else { phase = 2; index = 0; }
      } else if (index < features.length) {
        upsertMapFeature(source, features[index++], geometries, added, false);
      } else { phase = 3; break; }
    } while (++count < 512 && performance.now() - start < 8);
    if (added.length) source.addFeatures(added);
    if (phase === 3) {
      synced.set(source, { features, revision: source.getRevision() });
      complete();
    } else timer = setTimeout(step, 0);
  };
  timer = setTimeout(step, 0);
  return () => { cancelled = true; clearTimeout(timer); };
}
