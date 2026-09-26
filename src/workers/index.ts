import type { DocumentLayer, ImportOptions, InputFile } from "../domain";
const active = new Map<Worker, (error: Error) => void>();
export function cancelParsing(): void {
  for (const reject of [...active.values()]) reject(new Error("导入已取消"));
}
export function parseInWorker(
  files: InputFile[],
  options: ImportOptions = {},
): Promise<DocumentLayer[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parser.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      active.delete(worker);
      worker.terminate();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    active.set(worker, fail);
    worker.onmessage = (event) => {
      cleanup();
      event.data.error
        ? reject(new Error(event.data.error))
        : resolve(event.data.layers);
    };
    worker.onerror = (event) =>
      fail(new Error(event.message || "解析 Worker 失败"));
    worker.onmessageerror = () => fail(new Error("解析结果传输失败"));
    worker.postMessage({ files, options });
  });
}
