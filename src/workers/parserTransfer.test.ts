import { expect, it } from "vitest";
import type { DocumentLayer, GeoFeature } from "../domain";
import {
  PARSER_BATCH_BYTES, PARSER_BATCH_FEATURES, PARSER_SINGLE_FEATURE_BYTES,
  ParserLayerAssembler, ParserPacketSender, parserValueBytes, transferParserLayers,
  type ParserComplete, type ParserPacket,
} from "./parserTransfer";

function feature(index: number, text = "精确文本😀"): GeoFeature {
  return { id: `f${index}`, sourceFeatureId: "9007199254740993", geometry: { type: "Point", coordinates: [116.4, 39.9, index] }, properties: { text, precise: "12345678901234567890.123456789" } };
}
function layer(features: GeoFeature[]): DocumentLayer {
  return { id: "layer", name: "道路", features, sourceKind: "shp", visible: true, color: "#123456", dirty: false, crs: "EPSG:4326", originalCrs: "完整的SHP PRJ", sourceId: "source", sourcePath: "/道路.zip", sourceHash: "fingerprint", zipMember: "道路", warnings: ["完整提示"], fieldNames: ["precise", "text"] };
}
const tick = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

it("无需生成JSON的字节计量匹配UTF8、转义、嵌套和重复引用", () => {
  const shared = { value: "\u0000\b\t\n\f\r\"\\\ud800\udfff中文😀" };
  for (const value of [null, true, false, -0, 1e-7, [undefined, 1, 2], { skip: undefined, a: shared, b: shared }, feature(1)]) {
    expect(parserValueBytes(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
  }
  expect(parserValueBytes("a".repeat(1000), 8)).toBe(9);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => parserValueBytes(cyclic)).toThrow("不支持的结构");
});

it("双界限分批、ACK背压与源引用释放，结果保留精度、XYZ和SHP元数据", async () => {
  const features = Array.from({ length: PARSER_BATCH_FEATURES + 3 }, (_, index) => feature(index));
  const source = layer(features);
  const expected = structuredClone(source);
  const layers = [source];
  const packets: (ParserPacket | ParserComplete)[] = [];
  const sender = new ParserPacketSender((packet) => packets.push(structuredClone(packet)));
  const running = transferParserLayers(layers, (packet) => sender.send(packet), (packet) => packets.push(packet));
  expect(packets).toHaveLength(1);
  expect(packets[0].type).toBe("layer");
  await tick();
  expect(packets).toHaveLength(1);
  sender.acknowledge(0);
  await tick();
  expect(packets).toHaveLength(2);
  const first = packets[1] as Extract<ParserPacket, { type: "features" }>;
  expect(first.features).toHaveLength(PARSER_BATCH_FEATURES);
  expect(first.bytes).toBeLessThanOrEqual(PARSER_BATCH_BYTES);
  expect(features[0]).toBeDefined();
  await tick();
  expect(packets).toHaveLength(2);
  sender.acknowledge(1);
  await tick();
  expect(features[0]).toBeUndefined();
  expect(features[PARSER_BATCH_FEATURES - 1]).toBeUndefined();
  expect(features[PARSER_BATCH_FEATURES]).toBeDefined();
  expect(packets).toHaveLength(3);
  sender.acknowledge(2);
  await running;
  expect(features).toHaveLength(0);
  expect(layers).toHaveLength(0);
  expect(packets.at(-1)).toEqual({ type: "complete", layerCount: 1 });
  const assembler = new ParserLayerAssembler();
  for (const packet of packets.slice(0, -1)) expect(assembler.accept(packet)).toEqual({ type: "ack", sequence: (packet as ParserPacket).sequence });
  expect(assembler.accept(packets.at(-1))).toEqual([expected]);
});

it("按字节先分批，大于普通批次的单要素完整独批", async () => {
  const normal = feature(1, "中".repeat(400_000));
  const large = feature(3, "x".repeat(PARSER_BATCH_BYTES + 100));
  const layers = [layer([normal, feature(2, "中".repeat(400_000)), large, feature(4)])];
  const messages: ParserPacket[] = [];
  await transferParserLayers(layers, async (packet) => { messages.push(structuredClone(packet)); }, () => {});
  const batches = messages.filter((message) => message.type === "features");
  expect(batches.map((batch) => batch.features.length)).toEqual([1, 1, 1, 1]);
  expect(batches[2].features[0]).toEqual(large);
  expect(batches[2].bytes).toBeGreaterThan(PARSER_BATCH_BYTES);
  expect(batches[2].bytes).toBeLessThanOrEqual(PARSER_SINGLE_FEATURE_BYTES);
  for (const batch of batches) expect(batch.bytes).toBe(parserValueBytes(batch.features));
});

it("传输失败、取消和错误ACK释放等待及未发送结果", async () => {
  for (const reason of ["post", "cancel", "wrong-ack"]) {
    const features = [feature(1), feature(2)];
    const layers = [layer(features)];
    const sender = new ParserPacketSender(() => { if (reason === "post") throw new Error("clone"); });
    const running = transferParserLayers(layers, (packet) => sender.send(packet), () => {});
    const failed = expect(running).rejects.toThrow(reason === "post" ? "传输失败" : reason === "cancel" ? "已取消" : "确认顺序");
    if (reason === "cancel") sender.cancel(new Error("已取消"));
    if (reason === "wrong-ack") sender.acknowledge(1);
    await failed;
    expect(layers).toHaveLength(0);
    expect(features).toHaveLength(0);
  }
});

it("空图层仍传输元数据，已完成图层在下一图层确认前释放", async () => {
  const first = layer([]), second = { ...layer([]), id: "second" };
  const layers = [first, second];
  const packets: ParserPacket[] = [];
  const sender = new ParserPacketSender((packet) => packets.push(packet));
  const running = transferParserLayers(layers, (packet) => sender.send(packet), () => {});
  sender.acknowledge(0);
  await tick();
  expect(layers[0]).toBeUndefined();
  expect(packets).toHaveLength(2);
  expect(packets[1]).toMatchObject({ type: "layer", layerIndex: 1, featureCount: 0 });
  sender.acknowledge(1);
  await running;
  expect(layers).toHaveLength(0);
});

it("超大单要素在发送前明确失败，不发送截断结果", async () => {
  const layers = [layer([feature(1, "x".repeat(PARSER_SINGLE_FEATURE_BYTES))])];
  const packets: ParserPacket[] = [];
  await expect(transferParserLayers(layers, async (packet) => { packets.push(packet); }, () => {})).rejects.toThrow("单个要素超过 64 MiB");
  expect(packets.map((packet) => packet.type)).toEqual(["layer"]);
  expect(layers).toHaveLength(0);
});
