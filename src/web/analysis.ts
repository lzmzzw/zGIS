import type { GeoFeature } from "../domain/types";

const MAX_JOBS = 2;
const TIMEOUT_MS = 120_000;
interface Job {
  worker: Worker;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const jobs = new Map<string, Job>();
const earlyCancelled = new Map<string, number>();
const features = (input: GeoFeature[]) =>
  input.map(({ id, geometry, properties }) => ({
    type: "Feature",
    id,
    geometry,
    properties,
  }));
function execute(
  payload: Record<string, unknown>,
  jobId: string = crypto.randomUUID(),
): Promise<unknown> {
  const now = Date.now();
  for (const [id, expiry] of earlyCancelled)
    if (expiry <= now) earlyCancelled.delete(id);
  if (!jobId || jobId.length > 256)
    return Promise.reject(new Error("无效分析任务标识"));
  if (jobs.has(jobId))
    return Promise.reject(new Error("ANALYSIS_DUPLICATE: 任务标识正在使用"));
  if (earlyCancelled.delete(jobId))
    return Promise.reject(new Error("ANALYSIS_CANCELLED: 分析已取消"));
  if (jobs.size >= MAX_JOBS)
    return Promise.reject(
      new Error("ANALYSIS_BUSY: 分析任务正在运行，请稍后重试"),
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./analysis.worker.ts", import.meta.url),
      { type: "module" },
    );
    const cleanup = () => {
      const job = jobs.get(jobId);
      if (job?.worker !== worker) return false;
      clearTimeout(job.timer);
      jobs.delete(jobId);
      worker.terminate();
      return true;
    };
    const fail = (message: string) => {
      if (cleanup()) reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail("ANALYSIS_TIMEOUT: 分析超过时间预算"),
      TIMEOUT_MS,
    );
    jobs.set(jobId, { worker, reject, timer });
    worker.onmessage = ({
      data,
    }: MessageEvent<{ jobId: string; result?: unknown; error?: string }>) => {
      if (data.jobId !== jobId || !cleanup()) return;
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || "空间分析引擎运行失败");
    };
    worker.onmessageerror = () => fail("空间分析结果传输失败");
    try {
      worker.postMessage({ ...payload, jobId });
    } catch (error) {
      fail(String(error));
    }
  });
}
export function runAnalysis(
  operation: string,
  parameters: Record<string, unknown>,
  source: GeoFeature[],
  target?: GeoFeature[],
  jobId?: string,
): Promise<unknown> {
  return execute(
    {
      kind: "analysis",
      operation,
      parameters,
      source: features(source),
      target: target ? features(target) : null,
    },
    jobId,
  );
}
export async function cancelAnalysis(jobId: string): Promise<boolean> {
  if (!jobId || jobId.length > 256) return false;
  const job = jobs.get(jobId);
  if (job) {
    clearTimeout(job.timer);
    jobs.delete(jobId);
    job.worker.terminate();
    job.reject(new Error("ANALYSIS_CANCELLED: 分析已取消"));
    return true;
  }
  for (const [id, expiry] of earlyCancelled)
    if (expiry <= Date.now()) earlyCancelled.delete(id);
  if (earlyCancelled.size >= 256) return false;
  earlyCancelled.set(jobId, Date.now() + 30_000);
  return true;
}
export async function exportShapefile(
  source: GeoFeature[],
  stem: string,
  crs = "EPSG:4326",
  jobId?: string,
): Promise<Uint8Array> {
  return (await execute(
    { kind: "shapefile", source: features(source), stem, crs },
    jobId,
  )) as Uint8Array;
}
