import type { DocumentLayer, ImportOptions, InputFile } from "../domain";
const active = new Map<Worker, (error: Error) => void>();
export function cancelParsing(): void {
  for (const reject of [...active.values()]) reject(new Error("导入已取消"));
}
export function parseInWorker(
  files: InputFile[],
  options: ImportOptions = {},
  perFileOptions?: ImportOptions[],
): Promise<DocumentLayer[]> {
  return requestWorker({ files, options, perFileOptions });
}
export interface CsvPreview {
  fields: string[];
  rows: Record<string, string>[];
  options: ImportOptions;
  geometryTypes: string[];
  validationError?: string;
  invalidFields: string[];
}
export function previewCsvInWorker(
  file: InputFile,
  options: ImportOptions,
  signal: AbortSignal,
): Promise<CsvPreview> {
  return requestWorker({ files: [file], options, preview: true }, signal);
}
interface WorkerRequest {
  files: InputFile[];
  options: ImportOptions;
  perFileOptions?: ImportOptions[];
  preview?: boolean;
}
function requestWorker<T>(
  payload: WorkerRequest,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("预览已取消"));
      return;
    }
    const worker = new Worker(new URL("./parser.worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;
    const cleanup = () => {
      active.delete(worker);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new Error("预览已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    active.set(worker, fail);
    worker.onmessage = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      event.data.error
        ? reject(new Error(event.data.error))
        : resolve(event.data.preview ?? event.data.layers);
    };
    worker.onerror = (event) =>
      fail(new Error(event.message || "解析 Worker 失败"));
    worker.onmessageerror = () => fail(new Error("解析结果传输失败"));
    try {
      // 使用独立的紧凑缓冲区并转移所有权，保留调用方文件以便重试/切换预览。
      const files = payload.files.map((file) => ({
        ...file,
        bytes: new Uint8Array(file.bytes),
      }));
      worker.postMessage(
        { ...payload, files },
        files.map((file) => file.bytes.buffer),
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
