import type { GeoFeature } from "./domain/types";

const MAX_BYTES = 100 * 1024 * 1024;
const sizes = new WeakMap<GeoFeature[], number>();
const encoder = new TextEncoder();
export class McpBudgetError extends Error {
  constructor(public readonly reason: "size" | "count") {
    super(reason === "size" ? "同步图层总大小超过100MB" : "工作区超过100图层或100000要素");
  }
}
/** 与原生快照预算一致；逐个计量并缓存版本，避免先序列化超大 IPC 再遭拒绝。 */
export function assertMcpWorkspaceBudget(layers: { id: string; name: string; features: GeoFeature[] }[]): void {
  if (layers.length > 100 || layers.reduce((count, layer) => count + layer.features.length, 0) > 100_000)
    throw new McpBudgetError("count");
  let bytes = 2;
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index];
    bytes += encoder.encode(JSON.stringify({ id: layer.id, name: layer.name, features: [] })).length + Number(index > 0);
    let contentSize = sizes.get(layer.features);
    if (contentSize === undefined) {
      contentSize = 0;
      for (let n = 0; n < layer.features.length; n++) {
        const { id, geometry, properties } = layer.features[n];
        contentSize += encoder.encode(JSON.stringify({ type: "Feature", id, geometry, properties })).length + Number(n > 0);
        if (contentSize > MAX_BYTES) break;
      }
      sizes.set(layer.features, contentSize);
    }
    bytes += contentSize;
    if (bytes > MAX_BYTES) throw new McpBudgetError("size");
  }
}
