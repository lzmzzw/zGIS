import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ParserLayerAssembler, type ParserPacket } from "./parserTransfer";
import type { DocumentLayer, InputFile } from "../domain";

type WorkerHandler = (event: MessageEvent) => Promise<void>;
let scope: { onmessage: WorkerHandler | null; postMessage: ReturnType<typeof vi.fn> };
let posted: unknown[];
let failFeatures = false;
beforeEach(async () => {
  vi.resetModules();
  posted = [];
  failFeatures = false;
  scope = { onmessage: null, postMessage: vi.fn((packet: { type?: string }) => {
    if (failFeatures && packet.type === "features") throw new DOMException("无法复制", "DataCloneError");
    // 与真实 Worker 相同，发送后由接收侧独立拥有结构化克隆结果。
    posted.push(structuredClone(packet));
  }) };
  vi.stubGlobal("self", scope);
  await import("./parser.worker");
});
afterEach(() => vi.unstubAllGlobals());
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function request(files: InputFile[], preview = false): Promise<void> {
  return scope.onmessage!({ data: { files, options: {}, preview, byteLimit: 100 * 1024 * 1024 } } as MessageEvent);
}
const ack = (sequence: number) => scope.onmessage!({ data: { type: "ack", sequence } } as MessageEvent);
function jsonFile(count = 1): InputFile {
  const text = JSON.stringify({ type: "FeatureCollection", features: Array.from({ length: count }, (_, index) => ({
    type: "Feature", id: `source-${index}`, properties: { precise: "RAW-NUMBER", text: "中😀".repeat(30) }, geometry: { type: "Point", coordinates: [116.4, 39.9, index] },
  })) }).replaceAll('"RAW-NUMBER"', "12345678901234567890.12345");
  return { name: "测试.geojson", bytes: new TextEncoder().encode(text), sourceId: "source", sourcePath: "/source.geojson", sourceHash: "fingerprint" };
}

it("实际Worker入口等待ACK逐批传回，释放输入并保留精度、XYZ和来源", async () => {
  const file = jsonFile(2200);
  const files = [file];
  const running = request(files);
  await tick();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ type: "layer", featureCount: 2200 });
  expect(file.bytes).toHaveLength(0);
  expect(files).toHaveLength(0);
  await tick();
  expect(posted).toHaveLength(1);
  const assembler = new ParserLayerAssembler();
  expect(assembler.accept(posted[0])).toEqual({ type: "ack", sequence: 0 });
  await ack(0);
  await tick();
  expect(posted).toHaveLength(2);
  expect(posted[1]).toMatchObject({ type: "features", sequence: 1, offset: 0 });
  await tick();
  expect(posted).toHaveLength(2);
  let cursor = 1;
  let result: DocumentLayer[] | undefined;
  while (!result) {
    const response = assembler.accept(posted[cursor++]);
    if (Array.isArray(response)) result = response;
    else { await ack(response.sequence); await tick(); }
  }
  await running;
  expect(result[0]).toMatchObject({ sourceKind: "geojson", sourceId: "source", sourcePath: "/source.geojson", sourceHash: "fingerprint", originalCrs: "EPSG:4326" });
  expect(result[0].features).toHaveLength(2200);
  expect(result[0].features[2199]).toMatchObject({ sourceFeatureId: "source-2199", geometry: { type: "Point", coordinates: [116.4, 39.9, 2199] }, properties: { precise: "12345678901234567890.12345" } });
  expect(posted.filter((packet) => (packet as ParserPacket).type === "features")).toHaveLength(3);
  expect(posted.at(-1)).toEqual({ type: "complete", layerCount: 1 });
});

it.each(["ack", "clone"])("实际Worker在传输异常后返回错误并清理：%s", async (failure) => {
  const file = jsonFile();
  failFeatures = failure === "clone";
  const running = request([file]);
  await tick();
  expect(posted[0]).toMatchObject({ type: "layer" });
  await ack(failure === "ack" ? 99 : 0);
  await running;
  expect(posted.at(-1)).toMatchObject({ error: failure === "ack" ? "解析结果确认顺序无效" : "解析结果传输失败" });
  expect(posted.some((packet) => (packet as { type?: string }).type === "complete")).toBe(false);
  expect(file.bytes).toHaveLength(0);
});

it("实际Worker的CSV预览协议仍无需ACK", async () => {
  const file = { name: "point.csv", bytes: new TextEncoder().encode("x,y,name\n116.4,39.9,北京\n") };
  await request([file], true);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ preview: { fields: ["x", "y", "name"], rows: [{ x: "116.4", y: "39.9", name: "北京" }], geometryTypes: ["Point"], invalidFields: [] } });
  expect(file.bytes).toHaveLength(0);
});
