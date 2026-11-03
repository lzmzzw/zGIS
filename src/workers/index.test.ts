import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelParsing, parseInWorker, previewCsvInWorker, PARSE_TIMEOUT_MS, PREVIEW_TIMEOUT_MS } from "./index";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static postError: Error | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((payload: unknown, transfers: Transferable[]) => {
    if (FakeWorker.postError) throw FakeWorker.postError;
    structuredClone(payload, { transfer: transfers ?? [] });
  });
  constructor() {
    FakeWorker.instances.push(this);
  }
}
beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.postError = undefined;
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  cancelParsing();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("传输使用紧凑可转移副本，调用方的输入可继续用于预览和重试", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const result = parseInWorker([{ name: "test.csv", bytes }]);
  const worker = FakeWorker.instances[0];
  const [payload, transfers] = worker.postMessage.mock.calls[0];
  expect(
    (payload as { files: { bytes: Uint8Array }[] }).files[0].bytes,
  ).toBeInstanceOf(Uint8Array);
  expect(transfers).toHaveLength(1);
  expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  worker.onmessage?.({ data: { type: "complete", layerCount: 0 } } as MessageEvent);
  await expect(result).resolves.toEqual([]);
  expect(worker.terminate).toHaveBeenCalledOnce();
  cancelParsing();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("postMessage 同步失败释放 Worker，后续取消不再处理已失败请求", async () => {
  FakeWorker.postError = new DOMException("无法复制", "DataCloneError");
  await expect(
    parseInWorker([{ name: "test.csv", bytes: [] }]),
  ).rejects.toThrow("无法复制");
  const worker = FakeWorker.instances[0];
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
  cancelParsing();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("预览取消与 Worker 故障只完成一次并移除全部监听", async () => {
  const controller = new AbortController();
  const result = previewCsvInWorker(
    { name: "test.csv", bytes: [] },
    {},
    controller.signal,
  );
  const worker = FakeWorker.instances[0];
  const lateError = worker.onerror;
  controller.abort();
  lateError?.({ message: "迟到错误" } as ErrorEvent);
  await expect(result).rejects.toThrow("预览已取消");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onerror).toBeNull();
  await expect(
    previewCsvInWorker({ name: "test.csv", bytes: [] }, {}, controller.signal),
  ).rejects.toThrow("预览已取消");
  expect(FakeWorker.instances).toHaveLength(1);
});

it("Worker 停滞会超时释放，且完成后不保留定时器", async () => {
  vi.useFakeTimers();
  const result = parseInWorker([{ name: "test.csv", bytes: [] }]);
  const rejected = expect(result).rejects.toThrow("文件解析超过时间预算");
  await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  const done = parseInWorker([{ name: "test.csv", bytes: [] }]);
  FakeWorker.instances[1].onmessage?.({ data: { type: "complete", layerCount: 0 } } as MessageEvent);
  await done;
  expect(vi.getTimerCount()).toBe(0);
});

const layer = { id: "layer", name: "test.csv", sourceKind: "csv", crs: "EPSG:4326", originalCrs: "EPSG:4490", visible: true, color: "#123456", dirty: false, csvConfig: { wktColumn: "shape" } };
const feature = { id: "feature", sourceFeatureId: "9007199254740993", geometry: { type: "Point", coordinates: [116.4, 39.9, 25] }, properties: { precise: "12345678901234567890.12345" } };
function message(worker: FakeWorker, data: unknown): void {
  worker.onmessage?.({ data: structuredClone(data) } as MessageEvent);
}

it("分片逐一确认，完整结束前不返回，保留XYZ、精度和图层元数据", async () => {
  const pending = parseInWorker([{ name: "test.csv", bytes: [] }]);
  const worker = FakeWorker.instances[0];
  message(worker, { type: "layer", sequence: 0, layerIndex: 0, featureCount: 1, layer, bytes: 256 });
  expect(worker.postMessage.mock.calls[1][0]).toEqual({ type: "ack", sequence: 0 });
  expect(worker.terminate).not.toHaveBeenCalled();
  message(worker, { type: "features", sequence: 1, layerIndex: 0, offset: 0, features: [feature], bytes: 256 });
  expect(worker.postMessage.mock.calls[2][0]).toEqual({ type: "ack", sequence: 1 });
  expect(worker.terminate).not.toHaveBeenCalled();
  message(worker, { type: "complete", layerCount: 1 });
  await expect(pending).resolves.toEqual([{ ...layer, features: [feature] }]);
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(["duplicate", "early-complete", "oversized"])("拒绝不完整或无界结果并清理：%s", async (kind) => {
  const pending = parseInWorker([{ name: "test.csv", bytes: [] }]);
  const worker = FakeWorker.instances[0];
  message(worker, { type: "layer", sequence: 0, layerIndex: 0, featureCount: 1, layer, bytes: 256 });
  message(worker, kind === "duplicate"
    ? { type: "layer", sequence: 0, layerIndex: 1, featureCount: 0, layer, bytes: 256 }
    : kind === "early-complete" ? { type: "complete", layerCount: 1 }
    : { type: "features", sequence: 1, layerIndex: 0, offset: 0, features: [feature], bytes: 64 * 1024 * 1024 + 1 });
  await expect(pending).rejects.toThrow("解析");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
});

it("ACK发送失败释放已接收的局部结果", async () => {
  const pending = parseInWorker([{ name: "test.csv", bytes: [] }]);
  const worker = FakeWorker.instances[0];
  FakeWorker.postError = new Error("ACK发送失败");
  message(worker, { type: "layer", sequence: 0, layerIndex: 0, featureCount: 1, layer, bytes: 256 });
  await expect(pending).rejects.toThrow("ACK发送失败");
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(["cancel", "timeout", "worker-error", "clone-error"])("部分结果仍受取消、时间预算与异常清理约束：%s", async (kind) => {
  vi.useFakeTimers();
  const pending = parseInWorker([{ name: "test.csv", bytes: [] }]);
  const rejected = expect(pending).rejects.toThrow();
  const worker = FakeWorker.instances[0];
  message(worker, { type: "layer", sequence: 0, layerIndex: 0, featureCount: 2, layer, bytes: 256 });
  message(worker, { type: "features", sequence: 1, layerIndex: 0, offset: 0, features: [feature], bytes: 256 });
  if (kind === "cancel") cancelParsing();
  else if (kind === "timeout") await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS);
  else if (kind === "worker-error") message(worker, { error: "解析错误" });
  else worker.onmessageerror?.();
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const next = parseInWorker([{ name: "next.csv", bytes: [] }]);
  message(FakeWorker.instances[1], { type: "complete", layerCount: 0 });
  await expect(next).resolves.toEqual([]);
});

it("CSV预览仍使用原协议且不发ACK", async () => {
  const pending = previewCsvInWorker({ name: "test.csv", bytes: [] }, {}, new AbortController().signal);
  const worker = FakeWorker.instances[0];
  const preview = { fields: ["x", "y"], rows: [{ x: "1", y: "2" }], options: {}, geometryTypes: ["Point"], invalidFields: [] };
  message(worker, { preview });
  await expect(pending).resolves.toEqual(preview);
  expect(worker.postMessage).toHaveBeenCalledOnce();
});

it("预览使用较短超时，并发上限不会分配额外 Worker", async () => {
  vi.useFakeTimers();
  const preview = previewCsvInWorker({ name: "test.csv", bytes: [] }, {}, new AbortController().signal);
  const imported = parseInWorker([{ name: "test.csv", bytes: [] }]);
  const previewRejected = expect(preview).rejects.toThrow("CSV 预览超过时间预算");
  const importedRejected = expect(imported).rejects.toThrow("导入已取消");
  await expect(parseInWorker([{ name: "third.csv", bytes: [] }])).rejects.toThrow("并发上限");
  expect(FakeWorker.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS);
  await previewRejected;
  cancelParsing();
  await importedRejected;
  expect(vi.getTimerCount()).toBe(0);
});
