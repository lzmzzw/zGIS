import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelParsing, parseInWorker, previewCsvInWorker } from "./index";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static postError: Error | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((payload: unknown, transfers: Transferable[]) => {
    if (FakeWorker.postError) throw FakeWorker.postError;
    structuredClone(payload, { transfer: transfers });
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
  worker.onmessage?.({ data: { layers: [] } } as MessageEvent);
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
