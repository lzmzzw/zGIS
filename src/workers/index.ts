import type { DocumentLayer, ImportOptions, InputFile } from "../domain";
import { MAX_FILE_BYTES } from "../fileLimits";
import { csvPreviewInput } from "./csvPreview";
import { ParserLayerAssembler } from "./parserTransfer";
const active = new Map<Worker, (error: Error) => void>();
const MAX_PARSER_WORKERS = 2;
export const PARSE_TIMEOUT_MS = 5 * 60 * 1000;
export const PREVIEW_TIMEOUT_MS = 15 * 1000;
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
  sampleLimited?: boolean;
}
export function previewCsvInWorker(
  file: InputFile,
  options: ImportOptions,
  signal: AbortSignal,
): Promise<CsvPreview> {
  try {
    if (signal.aborted) return Promise.reject(new Error("预览已取消"));
    const sample = csvPreviewInput(file);
    return requestWorker({ files: [sample.file], options, preview: true, sampleLimited: sample.limited }, signal);
  } catch (error) {
    return Promise.reject(error);
  }
}
interface WorkerRequest {
  files: InputFile[];
  options: ImportOptions;
  perFileOptions?: ImportOptions[];
  preview?: boolean;
  sampleLimited?: boolean;
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
    if (active.size >= MAX_PARSER_WORKERS) {
      reject(new Error("解析任务已达到并发上限，请等待或取消当前导入"));
      return;
    }
    if (payload.files.reduce((total, file) => total + file.bytes.length, 0) > MAX_FILE_BYTES) {
      reject(new Error(`单次导入文件总大小不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB。`));
      return;
    }
    const worker = new Worker(new URL("./parser.worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;
    const assembler = new ParserLayerAssembler();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      active.delete(worker);
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      assembler.clear();
      cleanup();
      reject(error);
    };
    const abort = () => fail(new Error("预览已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    active.set(worker, fail);
    timer = setTimeout(
      () => fail(new Error(payload.preview ? "CSV 预览超过时间预算，请检查记录大小或稍后重试" : "文件解析超过时间预算，请拆分文件后重试")),
      payload.preview ? PREVIEW_TIMEOUT_MS : PARSE_TIMEOUT_MS,
    );
    worker.onmessage = (event) => {
      if (settled) return;
      try {
        if (event.data?.error) throw new Error(typeof event.data.error === "string" ? event.data.error : "解析 Worker 失败");
        if (payload.preview) {
          if (!event.data?.preview) throw new Error("CSV 预览结果传输失败");
          settled = true;
          cleanup();
          resolve(event.data.preview);
          return;
        }
        const result = assembler.accept(event.data);
        if (Array.isArray(result)) {
          settled = true;
          cleanup();
          resolve(result as T);
        } else worker.postMessage(result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("解析结果传输失败"));
      }
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
        { ...payload, files, byteLimit: MAX_FILE_BYTES },
        files.map((file) => file.bytes.buffer),
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
