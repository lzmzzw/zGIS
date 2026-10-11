import type { GeoFeature } from "./domain";
const values = new WeakMap<GeoFeature["properties"], string[]>();
export function searchFeatures(features: GeoFeature[], search: string): GeoFeature[] {
  if (!search) return features;
  const query = search.toLowerCase();
  return features.filter(feature => {
    let cached = values.get(feature.properties);
    if (!cached) {
      cached = Object.values(feature.properties).map(value =>
        (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).toLowerCase());
      values.set(feature.properties, cached);
    }
    return cached.some(value => value.includes(query));
  });
}
