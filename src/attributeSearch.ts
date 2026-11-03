import type { GeoFeature } from "./domain";
const values = new WeakMap<GeoFeature["properties"], string[]>();
export function matchesFeature(feature: GeoFeature, query: string): boolean {
  let cached = values.get(feature.properties);
  if (!cached) {
    cached = Object.values(feature.properties).map(value =>
      (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).toLowerCase());
    // 大文本仍完整匹配，但不再为每次属性版本长期保留第二份大字符串。
    if (cached.reduce((size, value) => size + value.length, 0) <= 8192)
      values.set(feature.properties, cached);
  }
  return cached.some(value => value.includes(query));
}
export function searchFeatures(features: GeoFeature[], search: string): GeoFeature[] {
  if (!search) return features;
  const query = search.toLowerCase();
  return features.filter(feature => matchesFeature(feature, query));
}

/** 每片最多扫描 512 条并交还事件循环；取消后不发布旧查询结果。 */
export async function searchFeaturesCooperatively(
  features: GeoFeature[], search: string, signal: AbortSignal,
): Promise<GeoFeature[] | undefined> {
  const query = search.toLowerCase();
  const result: GeoFeature[] = [];
  let index = 0;
  while (index < features.length) {
    if (signal.aborted) return;
    const start = performance.now();
    let count = 0;
    do {
      const feature = features[index++];
      if (matchesFeature(feature, query)) result.push(feature);
    } while (index < features.length && ++count < 512 && performance.now() - start < 8);
    if (index < features.length) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return signal.aborted ? undefined : result;
}
