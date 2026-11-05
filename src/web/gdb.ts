import type {
  GdbAdapter,
  GdbCatalog,
  GdbReadOptions,
  GdbReadResult,
} from "../gdb";
import { loadGdbRuntime, sha256 } from "./gdbRuntime";
export interface BrowserGdbFile {
  path: string;
  file: File;
}
export interface BrowserGdbInput {
  files: BrowserGdbFile[];
  path: string;
  fingerprint: string;
}
export async function prepareBrowserGdbFiles(
  files: File[],
  zipped: boolean,
  signal?: AbortSignal,
): Promise<BrowserGdbInput> {
  if (!files.length || files.length > 10000)
    throw new Error("GDB_INPUT_LIMIT: choose 1–10000 files");
  let total = 0;
  const paths = new Set<string>();
  let root = "";
  const inputs = files
    .map((file) => {
      const path = zipped ? file.name : file.webkitRelativePath;
      const parts = path.split("/");
      if (
        !path ||
        path.includes("\\") ||
        parts.some(
          (part) =>
            !part || part === "." || part === ".." || part.includes("\0"),
        ) ||
        path.length > 4096 ||
        paths.has(path)
      )
        throw new Error("GDB_INPUT_PATH_INVALID");
      paths.add(path);
      if (zipped) {
        if (
          files.length !== 1 ||
          parts.length !== 1 ||
          !/\.gdb\.zip$/i.test(file.name)
        )
          throw new Error("GDB_INPUT_PATH_INVALID: choose one .gdb.zip");
        root = file.name;
      } else {
        if (
          parts.length < 2 ||
          !/\.gdb$/i.test(parts[0]) ||
          (root && root !== parts[0])
        )
          throw new Error("GDB_INPUT_PATH_INVALID: choose one .gdb folder");
        root = parts[0];
      }
      if (
        file.size < 0 ||
        !Number.isSafeInteger(file.size) ||
        (total += file.size) > 100 * 1024 * 1024
      )
        throw new Error("GDB_INPUT_LIMIT: 100 MiB");
      return { path, file };
    })
    .filter((input) => !input.path.toLowerCase().endsWith(".lock"));
  if (!inputs.length) throw new Error("GDB_INPUT_PATH_INVALID: empty source");
  // File handles are immutable browser snapshots; fingerprint combines each content digest and relative path.
  const descriptors: string[] = [];
  for (const input of inputs) {
    signal?.throwIfAborted();
    const bytes = await input.file.arrayBuffer();
    if (bytes.byteLength !== input.file.size)
      throw new Error("GDB_INPUT_CHANGED");
    descriptors.push(`${input.path}\0${await sha256(bytes)}`);
    signal?.throwIfAborted();
  }
  const fingerprint = await sha256(
    new TextEncoder().encode(descriptors.sort().join("\n")).buffer,
  );
  return { files: inputs, path: root, fingerprint };
}
export function pickBrowserGdbFiles(
  zipped: boolean,
  signal: AbortSignal,
): Promise<File[] | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.hidden = true;
    if (zipped) input.accept = ".gdb.zip";
    else {
      input.setAttribute("webkitdirectory", "");
      input.multiple = true;
    }
    let settled = false;
    const finish = (files: File[] | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      input.remove();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(files);
    };
    const abort = () =>
      finish(
        null,
        signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
    input.onchange = () =>
      finish(input.files?.length ? Array.from(input.files) : null);
    input.addEventListener("cancel", () => finish(null), { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    document.body.append(input);
    input.click();
  });
}
export function createBrowserGdbAdapter(
  onStatus: (value: string) => void,
): GdbAdapter & { dispose(): void } {
  let source:
    (BrowserGdbInput & { id: string; warnings: string[] }) | undefined;
  let worker: Worker | undefined;
  let active:
    | {
        id: string;
        controller: AbortController;
        reject?: (error: Error) => void;
      }
    | undefined;
  let serial = 0;
  const terminate = () => {
    worker?.terminate();
    worker = undefined;
  };
  const fail = (error: Error) => {
    terminate();
    active?.reject?.(error);
  };
  const run = <T>(
    payload: object,
    signal: AbortSignal,
    transfers: Transferable[] = [],
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => fail(new Error("GDB_TIMEOUT")), 120000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (active) active.reject = undefined;
      };
      const abort = () => {
        cleanup();
        terminate();
        reject(new Error("GDB_CANCELLED"));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      active!.reject = (error) => {
        cleanup();
        reject(error);
      };
      signal.addEventListener("abort", abort, { once: true });
      worker!.onerror = () => fail(new Error("GDB_WORKER_FAILED"));
      worker!.onmessage = (event) => {
        if (event.data.id !== id) return;
        if (signal.aborted) {
          abort();
          return;
        }
        cleanup();
        event.data.ok
          ? resolve(event.data.result as T)
          : reject(new Error(event.data.error || "GDB_READ_FAILED"));
      };
      worker!.postMessage({ id, ...payload }, transfers);
    });
  async function initialize(signal: AbortSignal) {
    if (worker) return;
    if (!source) throw new Error("GDB_SOURCE_UNAVAILABLE");
    const runtime = await loadGdbRuntime(
      new URL(
        "gdb-runtime/",
        new URL(import.meta.env.BASE_URL, document.baseURI),
      ),
      signal,
      onStatus,
    );
    source.warnings = runtime.warnings;
    signal.throwIfAborted();
    worker = new Worker(new URL("./gdb.worker.ts", import.meta.url), {
      type: "module",
    });
    await run(
      { operation: "init", assets: runtime.assets, files: source.files },
      signal,
      runtime.assets.map((asset) => asset.bytes),
    );
  }
  function begin(id: string) {
    if (active) throw new Error("GDB_BUSY");
    active = { id, controller: new AbortController() };
    return active.controller.signal;
  }
  return {
    async openGdb(id, zipped) {
      const signal = begin(id);
      try {
        const files = await pickBrowserGdbFiles(zipped, signal);
        if (!files) return null;
        const prepared = await prepareBrowserGdbFiles(files, zipped, signal);
        signal.throwIfAborted();
        terminate();
        source = { ...prepared, id: crypto.randomUUID(), warnings: [] };
        await initialize(signal);
        const result = await run<Pick<GdbCatalog, "layers" | "warnings">>(
          { request: { operation: "catalog", path: `/data/${source.path}` } },
          signal,
        );
        signal.throwIfAborted();
        return {
          ...result,
          sourceId: source.id,
          path: source.path,
          fingerprint: source.fingerprint,
          warnings: [...result.warnings, ...source.warnings],
        };
      } finally {
        if (active?.id === id) active = undefined;
      }
    },
    async readGdb(id: string, sourceId: string, options: GdbReadOptions) {
      const signal = begin(id);
      try {
        if (!source || source.id !== sourceId)
          throw new Error("GDB_SOURCE_UNAVAILABLE");
        await initialize(signal);
        const result = await run<GdbReadResult>(
          {
            request: {
              operation: "read",
              path: `/data/${source.path}`,
              ...options,
            },
          },
          signal,
        );
        signal.throwIfAborted();
        return {
          ...result,
          sourceFingerprint: source.fingerprint,
          warnings: [...result.warnings, ...source.warnings],
        };
      } finally {
        if (active?.id === id) active = undefined;
      }
    },
    async cancelGdb(id) {
      if (active?.id === id) {
        active.controller.abort();
        terminate();
      }
    },
    dispose() {
      active?.controller.abort();
      terminate();
      source = undefined;
    },
  };
}
