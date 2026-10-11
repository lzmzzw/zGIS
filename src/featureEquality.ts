import type { GeoFeature } from "./domain";
const encoded = new WeakMap<GeoFeature, string>();
function encode(feature: GeoFeature) {
  let value = encoded.get(feature);
  if (value === undefined) { value = JSON.stringify(feature); encoded.set(feature, value); }
  return value;
}
// Immutable frames share unchanged features. Compare only replaced objects deeply.
export function sameFeatures(left: GeoFeature[], right: GeoFeature[]): boolean {
  return left === right || (left.length === right.length && left.every((feature, index) =>
    feature === right[index] || encode(feature) === encode(right[index])));
}
