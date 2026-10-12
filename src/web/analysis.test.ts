import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cancelAnalysis, exportShapefile, runAnalysis } from "./analysis";
import type { GeoFeature } from "../domain/types";
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
}
const source: GeoFeature[] = [
  {
    id: "p",
    geometry: { type: "Point", coordinates: [116, 40, 8] },
    properties: { name: "测试" },
    dbKey: "must-not-send",
    baseline: {},
  },
];
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("发送标准 Feature，完成后终止 Worker 且迟到响应不重复完成", async () => {
  const promise = runAnalysis(
    "buffer",
    { distanceMeters: 10 },
    source,
    undefined,
    "normal",
  );
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage.mock.calls[0][0].source).toEqual([
    {
      type: "Feature",
      id: "p",
      geometry: source[0].geometry,
      properties: source[0].properties,
    },
  ]);
  worker.onmessage?.({ data: { jobId: "other", result: 0 } } as MessageEvent);
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.onmessage?.({
    data: { jobId: "normal", result: { features: [] } },
  } as MessageEvent);
  await expect(promise).resolves.toEqual({ features: [] });
  worker.onmessage?.({
    data: { jobId: "normal", result: "late" },
  } as MessageEvent);
  expect(worker.terminate).toHaveBeenCalledOnce();
});
it("取消真实终止 Worker，释放容量且旧 Worker 无法完成同 ID 新任务", async () => {
  const first = runAnalysis("buffer", {}, source, undefined, "cancel-reuse");
  const rejected = expect(first).rejects.toThrow("ANALYSIS_CANCELLED");
  const old = FakeWorker.instances[0];
  expect(await cancelAnalysis("cancel-reuse")).toBe(true);
  await rejected;
  expect(old.terminate).toHaveBeenCalledOnce();
  const next = runAnalysis("buffer", {}, source, undefined, "cancel-reuse");
  old.onmessage?.({
    data: { jobId: "cancel-reuse", result: "stale" },
  } as MessageEvent);
  const current = FakeWorker.instances[1];
  current.onmessage?.({
    data: { jobId: "cancel-reuse", result: "current" },
  } as MessageEvent);
  await expect(next).resolves.toBe("current");
});
it("限制两个并发任务，拒绝重复 ID，SHP 导出可以取消", async () => {
  const a = runAnalysis("buffer", {}, source, undefined, "slot-a");
  const b = exportShapefile(source, "test", "EPSG:4326", "slot-b");
  const rejectA = expect(a).rejects.toThrow("ANALYSIS_CANCELLED");
  const rejectB = expect(b).rejects.toThrow("ANALYSIS_CANCELLED");
  await expect(
    runAnalysis("buffer", {}, source, undefined, "slot-a"),
  ).rejects.toThrow("ANALYSIS_DUPLICATE");
  await expect(
    runAnalysis("buffer", {}, source, undefined, "slot-c"),
  ).rejects.toThrow("ANALYSIS_BUSY");
  await cancelAnalysis("slot-a");
  await cancelAnalysis("slot-b");
  await rejectA;
  await rejectB;
});
it("120 秒超时终止 Worker；提前取消收据阻止随后启动", async () => {
  vi.useFakeTimers();
  const pending = runAnalysis("buffer", {}, source, undefined, "timeout");
  const rejected = expect(pending).rejects.toThrow("ANALYSIS_TIMEOUT");
  await vi.advanceTimersByTimeAsync(120_000);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  await cancelAnalysis("early");
  await expect(
    runAnalysis("buffer", {}, source, undefined, "early"),
  ).rejects.toThrow("ANALYSIS_CANCELLED");
});
it("Worker 故障释放容量并保留失败原因", async () => {
  const pending = runAnalysis("buffer", {}, source, undefined, "failure");
  const rejected = expect(pending).rejects.toThrow("WASM load failed");
  FakeWorker.instances[0].onerror?.({
    message: "WASM load failed",
    preventDefault: vi.fn(),
  } as unknown as ErrorEvent);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
