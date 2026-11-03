import type { DocumentLayer, GeoFeature } from "../domain";

// 普通批次限制 JSON 等价的 UTF-8 字节数；超大单要素独占一批，不截断属性或坐标。
export const PARSER_BATCH_BYTES = 2 * 1024 * 1024;
export const PARSER_BATCH_FEATURES = 1024;
export const PARSER_SINGLE_FEATURE_BYTES = 64 * 1024 * 1024;
type LayerMetadata = Omit<DocumentLayer, "features">;

export type ParserPacket =
  | { type: "layer"; sequence: number; layerIndex: number; featureCount: number; layer: LayerMetadata; bytes: number }
  | { type: "features"; sequence: number; layerIndex: number; offset: number; features: GeoFeature[]; bytes: number };
export interface ParserComplete { type: "complete"; layerCount: number }
export interface ParserAck { type: "ack"; sequence: number }

/** 不分配完整序列化字符串，计量 JSON 数据的传输预算。 */
export function parserValueBytes(value: unknown, limit = PARSER_SINGLE_FEATURE_BYTES): number {
  let bytes = 0;
  const ancestors = new Set<object>();
  const add = (count: number) => { bytes = Math.min(limit + 1, bytes + count); };
  const string = (text: string) => {
    add(2);
    for (let index = 0; index < text.length && bytes <= limit; index++) {
      const code = text.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(2);
      else if (code < 32) add(6);
      else if (code < 128) add(1);
      else if (code < 2048) add(2);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); index++; }
        else add(6);
      } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
      else add(3);
    }
  };
  const visit = (item: unknown, depth: number): void => {
    if (bytes > limit) return;
    if (item === null || item === undefined) { add(4); return; }
    if (typeof item === "string") { string(item); return; }
    if (typeof item === "boolean") { add(item ? 4 : 5); return; }
    if (typeof item === "number") { add(Number.isFinite(item) ? String(item).length : 4); return; }
    if (typeof item !== "object" || depth > 256 || ancestors.has(item))
      throw new Error("解析结果包含不支持的结构");
    ancestors.add(item);
    add(2);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length && bytes <= limit; index++) {
        if (index) add(1);
        visit(item[index], depth + 1);
      }
    } else {
      let count = 0;
      for (const key of Object.keys(item)) {
        if (bytes > limit) break;
        const child = (item as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if (count++) add(1);
        string(key);
        add(1);
        visit(child, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return bytes;
}

/** 只允许一个未确认包；ACK 错序或发送失败终止整个传输。 */
export class ParserPacketSender {
  private pending?: { sequence: number; resolve: () => void; reject: (error: Error) => void };
  private failure?: Error;
  constructor(private readonly post: (packet: ParserPacket) => void) {}

  send(packet: ParserPacket): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("解析结果确认尚未完成"));
    return new Promise((resolve, reject) => {
      this.pending = { sequence: packet.sequence, resolve, reject };
      try { this.post(packet); }
      catch { this.cancel(new Error("解析结果传输失败")); }
    });
  }

  acknowledge(sequence: unknown): void {
    if (!Number.isSafeInteger(sequence) || !this.pending || this.pending.sequence !== sequence) {
      this.cancel(new Error("解析结果确认顺序无效"));
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve();
  }

  cancel(error: Error): void {
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

/** ACK 后立即移除 Worker 中对应的源要素，避免整层同时驻留两侧。 */
export async function transferParserLayers(
  layers: DocumentLayer[],
  send: (packet: ParserPacket) => Promise<void>,
  complete: (packet: ParserComplete) => void,
): Promise<void> {
  const layerCount = layers.length;
  let sequence = 0;
  try {
    for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
      const { features, ...layer } = layers[layerIndex];
      const metadataBytes = parserValueBytes(layer);
      if (metadataBytes > PARSER_SINGLE_FEATURE_BYTES) throw new Error("图层元数据超过 64 MiB 传输上限");
      await send({ type: "layer", sequence: sequence++, layerIndex, layer, featureCount: features.length, bytes: metadataBytes });
      let measuredIndex = -1, measuredBytes = 0;
      for (let offset = 0; offset < features.length;) {
        let end = offset;
        let bytes = 2;
        const batch: GeoFeature[] = [];
        while (end < features.length && batch.length < PARSER_BATCH_FEATURES) {
          const feature = features[end];
          if (measuredIndex !== end) {
            measuredIndex = end;
            measuredBytes = parserValueBytes(feature, PARSER_SINGLE_FEATURE_BYTES - 2);
          }
          const featureBytes = measuredBytes;
          if (featureBytes + 2 > PARSER_SINGLE_FEATURE_BYTES)
            throw new Error("单个要素超过 64 MiB 传输上限，请拆分属性或几何后重试");
          const nextBytes = bytes + featureBytes + (batch.length ? 1 : 0);
          if (batch.length && nextBytes > PARSER_BATCH_BYTES) break;
          batch.push(feature);
          bytes = nextBytes;
          end++;
        }
        await send({ type: "features", sequence: sequence++, layerIndex, offset, features: batch, bytes });
        for (let index = offset; index < end; index++) features[index] = undefined as unknown as GeoFeature;
        batch.length = 0;
        offset = end;
      }
      features.length = 0;
      layers[layerIndex] = undefined as unknown as DocumentLayer;
    }
    complete({ type: "complete", layerCount });
  } finally {
    // 包括部分传输失败；调用方不再复用此 Worker 的解析工作副本。
    for (const layer of layers) if (layer) layer.features.length = 0;
    layers.length = 0;
  }
}

/** 主线程只拼接已确认批次；失败时可一次释放全部局部图层。 */
export class ParserLayerAssembler {
  private layers: DocumentLayer[] = [];
  private sequence = 0;
  private expectedFeatures = 0;

  clear(): void { this.layers = []; }

  accept(value: unknown): ParserAck | DocumentLayer[] {
    if (!value || typeof value !== "object") throw new Error("解析结果传输协议无效");
    const packet = value as ParserPacket | ParserComplete;
    if (packet.type === "complete") {
      if (packet.layerCount !== this.layers.length || !this.layerComplete()) throw new Error("解析结果尚未完整传输");
      const layers = this.layers;
      this.layers = [];
      return layers;
    }
    if (packet.sequence !== this.sequence || !Number.isSafeInteger(packet.bytes) || packet.bytes < 2)
      throw new Error("解析结果分片顺序或预算无效");
    if (packet.type === "layer") {
      if (packet.layerIndex !== this.layers.length || !this.layerComplete() ||
          !Number.isSafeInteger(packet.featureCount) || packet.featureCount < 0 ||
          !packet.layer || typeof packet.layer !== "object" || "features" in packet.layer ||
          packet.bytes > PARSER_SINGLE_FEATURE_BYTES)
        throw new Error("解析图层元数据无效");
      this.layers.push({ ...packet.layer, features: [] });
      this.expectedFeatures = packet.featureCount;
    } else if (packet.type === "features") {
      const layer = this.layers[packet.layerIndex];
      if (packet.layerIndex !== this.layers.length - 1 || !layer || packet.offset !== layer.features.length ||
          !Array.isArray(packet.features) || !packet.features.length || packet.features.length > PARSER_BATCH_FEATURES ||
          layer.features.length + packet.features.length > this.expectedFeatures ||
          packet.bytes > (packet.features.length === 1 ? PARSER_SINGLE_FEATURE_BYTES : PARSER_BATCH_BYTES))
        throw new Error("解析要素分片无效");
      for (const feature of packet.features) layer.features.push(feature);
    } else throw new Error("解析结果传输协议无效");
    this.sequence++;
    return { type: "ack", sequence: packet.sequence };
  }

  private layerComplete(): boolean {
    return !this.layers.length || this.layers[this.layers.length - 1].features.length === this.expectedFeatures;
  }
}
