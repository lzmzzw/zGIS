import init, { analyze, export_shapefile } from "./wasm/spatial_wasm";
import wasmUrl from "./wasm/spatial_wasm_bg.wasm?url";
// WASM 仅在任务 Worker 中加载；销毁 Worker 即停止同步 WASM 计算。
self.onmessage = async ({ data }) => {
  try {
    await init({ module_or_path: wasmUrl });
    const result =
      data.kind === "shapefile"
        ? export_shapefile(JSON.stringify(data.source), data.stem, data.crs)
        : JSON.parse(
            analyze(
              data.operation,
              JSON.stringify(data.parameters),
              JSON.stringify(data.source),
              data.target ? JSON.stringify(data.target) : undefined,
            ),
          );
    if (result instanceof Uint8Array)
      self.postMessage(
        { jobId: data.jobId, result },
        { transfer: [result.buffer] },
      );
    else self.postMessage({ jobId: data.jobId, result });
  } catch (error) {
    self.postMessage({
      jobId: data.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
