import type { RuntimeAsset } from "./gdbRuntime";
interface FileInput {
  path: string;
  file: File;
}
interface Fs {
  mkdirTree(path: string): void;
  writeFile(path: string, bytes: Uint8Array): void;
}
interface Module {
  FS: Fs;
  cwrap(
    name: string,
    result: string | null,
    args: string[],
  ): (...values: unknown[]) => number;
  UTF8ToString(pointer: number): string;
}
let module: Module | undefined;
let blobUrl: string | undefined;
const worker = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
};
async function initialize(assets: RuntimeAsset[], files: FileInput[]) {
  const js = assets.find((asset) => asset.name === "gdb-runtime.js");
  const wasm = assets.find((asset) => asset.name === "gdb-runtime.wasm");
  if (!js || !wasm) throw new Error("GDB_RUNTIME_MANIFEST_INVALID");
  blobUrl = URL.createObjectURL(
    new Blob([js.bytes], { type: "text/javascript" }),
  );
  const wasmUrl = URL.createObjectURL(
    new Blob([wasm.bytes], { type: "application/wasm" }),
  );
  try {
    const glue = await import(/* @vite-ignore */ blobUrl);
    module = await glue.default({
      wasmBinary: new Uint8Array(wasm.bytes),
      locateFile: (name: string) => {
        if (name === "gdb-runtime.wasm") return wasmUrl;
        throw new Error("GDB_RUNTIME_UNEXPECTED_RESOURCE");
      },
      print: () => {},
      printErr: () => {},
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
    URL.revokeObjectURL(wasmUrl);
    blobUrl = undefined;
  }
  const fs = module!.FS;
  fs.mkdirTree("/gdal/data");
  fs.mkdirTree("/gdal/proj");
  fs.mkdirTree("/data");
  for (const asset of assets) {
    if (!asset.name.startsWith("data/") && !asset.name.startsWith("proj/"))
      continue;
    const destination = `/gdal/${asset.name}`;
    fs.mkdirTree(destination.slice(0, destination.lastIndexOf("/")));
    fs.writeFile(destination, new Uint8Array(asset.bytes));
  }
  let total = 0;
  for (const input of files) {
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    if (
      bytes.length !== input.file.size ||
      (total += bytes.length) > 100 * 1024 * 1024
    )
      throw new Error("GDB_INPUT_LIMIT");
    const destination = `/data/${input.path}`;
    fs.mkdirTree(destination.slice(0, destination.lastIndexOf("/")));
    fs.writeFile(destination, bytes);
  }
}
worker.onmessage = async (event: MessageEvent) => {
  const { id, operation, assets, files, request } = event.data;
  try {
    if (operation === "init") {
      await initialize(assets, files);
      worker.postMessage({ id, ok: true });
      return;
    }
    if (!module) throw new Error("GDB_RUNTIME_UNAVAILABLE");
    const execute = module.cwrap("zgis_gdb_execute", "number", ["string"]);
    const release = module.cwrap("zgis_gdb_free", null, ["number"]);
    const pointer = execute(JSON.stringify(request));
    if (!pointer) throw new Error("GDB_RUNTIME_EMPTY_RESULT");
    let result;
    try {
      result = JSON.parse(module.UTF8ToString(pointer));
    } finally {
      release(pointer);
    }
    worker.postMessage({ id, ...result });
  } catch (error) {
    worker.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
