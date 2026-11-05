/** GDB runtime assets are requested only when loadGdbRuntime is called. Inputs never enter caches. */
export interface RuntimeFile {
  name: string;
  sha256: string;
  size: number;
}
export interface RuntimeManifest {
  version: string;
  files: RuntimeFile[];
}
export interface RuntimeAsset {
  name: string;
  bytes: ArrayBuffer;
}
export interface GdbRuntime {
  manifest: RuntimeManifest;
  assets: RuntimeAsset[];
  warnings: string[];
}
const MAX_RUNTIME_BYTES = 160 * 1024 * 1024;
const MANIFEST_CACHE = "zgis-gdb-manifest-v1";
const ASSET_CACHE = "zgis-gdb-assets-";
const CACHE_WARNING =
  "浏览器无法缓存 GDB 运行时，本次仍可使用；下次可能需要重新下载。";
const aborted = (signal?: AbortSignal) => {
  signal?.throwIfAborted();
};
export async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function validateRuntimeManifest(raw: unknown): RuntimeManifest {
  if (!raw || typeof raw !== "object")
    throw new Error("GDB_RUNTIME_MANIFEST_INVALID");
  const value = raw as RuntimeManifest;
  if (
    !/^[a-zA-Z0-9._-]{1,100}$/.test(value.version) ||
    !Array.isArray(value.files) ||
    value.files.length > 256
  )
    throw new Error("GDB_RUNTIME_MANIFEST_INVALID");
  const names = new Set<string>();
  let total = 0;
  for (const file of value.files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      !/^[a-zA-Z0-9_./-]+$/.test(file.name) ||
      file.name
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      names.has(file.name) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 1 ||
      (total += file.size) > MAX_RUNTIME_BYTES
    )
      throw new Error("GDB_RUNTIME_MANIFEST_INVALID");
    names.add(file.name);
  }
  if (
    !["gdb-runtime.js", "gdb-runtime.wasm", "proj/proj.db"].every((name) =>
      names.has(name),
    )
  )
    throw new Error("GDB_RUNTIME_MANIFEST_INVALID");
  return value;
}
async function boundedBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!response.ok)
    throw new Error(`GDB_RUNTIME_DOWNLOAD_FAILED: ${response.status}`);
  // Stream with a hard cap, even when the server omits or misreports Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GDB_RUNTIME_DOWNLOAD_FAILED: empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      aborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("GDB_RUNTIME_INTEGRITY_FAILED");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  aborted(signal);
  return bytes.buffer;
}
async function verified(
  response: Response,
  file: RuntimeFile,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const bytes = await boundedBytes(response, file.size, signal);
  if (bytes.byteLength !== file.size || (await sha256(bytes)) !== file.sha256)
    throw new Error("GDB_RUNTIME_INTEGRITY_FAILED");
  aborted(signal);
  return bytes;
}
export async function loadGdbRuntime(
  base: URL,
  signal?: AbortSignal,
  onStatus?: (value: string) => void,
): Promise<GdbRuntime> {
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
    : AbortSignal.timeout(120000);
  aborted(signal);
  if (base.origin !== location.origin)
    throw new Error("GDB_RUNTIME_ORIGIN_INVALID");
  onStatus?.("正在准备 GDB 运行时；首次使用需要下载，完成后会缓存。");
  const warnings: string[] = [];
  const warn = () => {
    if (!warnings.includes(CACHE_WARNING)) warnings.push(CACHE_WARNING);
  };
  let manifestCache: Cache | undefined;
  try {
    manifestCache = await caches.open(MANIFEST_CACHE);
  } catch {
    warn();
  }
  const manifestUrl = new URL("manifest.json", base).href;
  let manifest: RuntimeManifest;
  try {
    const response = await fetch(manifestUrl, {
      signal,
      cache: "no-cache",
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error(`GDB_RUNTIME_DOWNLOAD_FAILED: ${response.status}`);
    const text = new TextDecoder().decode(
      await boundedBytes(response, 128 * 1024, signal),
    );
    manifest = validateRuntimeManifest(JSON.parse(text));
  } catch (error) {
    aborted(signal);
    const cached = await manifestCache?.match(manifestUrl);
    if (!cached) throw error;
    manifest = validateRuntimeManifest(
      JSON.parse(
        new TextDecoder().decode(
          await boundedBytes(cached, 128 * 1024, signal),
        ),
      ),
    );
  }
  aborted(signal);
  let cache: Cache | undefined;
  try {
    cache = await caches.open(ASSET_CACHE + manifest.version);
  } catch {
    warn();
  }
  let allAssetsCached = cache !== undefined;
  const assets: RuntimeAsset[] = [];
  for (const file of manifest.files) {
    const url = new URL(`${manifest.version}/${file.name}`, base).href;
    let bytes: ArrayBuffer | undefined;
    let hit: Response | undefined;
    try {
      hit = await cache?.match(url);
    } catch {
      warn();
    }
    if (hit) {
      try {
        bytes = await verified(hit, file, signal);
      } catch {
        aborted(signal);
        try {
          await cache?.delete(url);
        } catch {
          warn();
        }
      }
    }
    if (!bytes) {
      bytes = await verified(
        await fetch(url, { signal, credentials: "same-origin" }),
        file,
        signal,
      );
      try {
        await cache?.put(url, new Response(bytes.slice(0)));
      } catch {
        allAssetsCached = false;
        warn();
      }
    }
    aborted(signal);
    assets.push({ name: file.name, bytes });
  }
  // Publish the offline pointer only after every asset has been verified and
  // persisted. Interrupted updates and quota failures retain the last complete
  // version, while the new in-memory runtime remains usable this session.
  if (allAssetsCached && manifestCache) {
    aborted(signal);
    try {
      await manifestCache.put(
        manifestUrl,
        new Response(JSON.stringify(manifest), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      warn();
    }
  }
  onStatus?.("GDB 运行时已就绪，正在读取本地数据。");
  return { manifest, assets, warnings };
}
