import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  loadGdbRuntime,
  sha256,
  validateRuntimeManifest,
  type RuntimeManifest,
} from "./gdbRuntime";
const base = new URL("https://example.test/zgis/gdb-runtime/");
let stores: Map<string, Map<string, Response>>;
let assets: Map<string, Uint8Array>;
let manifest: RuntimeManifest;
let fetcher: Mock<(url: string) => Promise<Response>>;
let failedCacheWrites: Set<string>;
beforeEach(async () => {
  stores = new Map();
  failedCacheWrites = new Set();
  assets = new Map();
  const files = [];
  for (const name of ["gdb-runtime.js", "gdb-runtime.wasm", "proj/proj.db"]) {
    const bytes = new TextEncoder().encode(`verified ${name}`);
    assets.set(name, bytes);
    files.push({
      name,
      size: bytes.length,
      sha256: await sha256(bytes.buffer),
    });
  }
  manifest = { version: "gdal-3.13.3-proj-9.8.1-r1", files };
  vi.stubGlobal("location", { origin: base.origin });
  vi.stubGlobal("caches", {
    open: vi.fn(async (name: string) => {
      const entries = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, entries);
      return {
        match: async (key: string) => entries.get(key)?.clone(),
        put: async (key: string, value: Response) => {
          if (failedCacheWrites.has(name)) throw new Error("quota");
          entries.set(key, value.clone());
        },
        delete: async (key: string) => entries.delete(key),
      };
    }),
  });
  fetcher = vi.fn(async (url: string) => {
    if (url.endsWith("manifest.json"))
      return new Response(JSON.stringify(manifest));
    const name = url.split(`${manifest.version}/`)[1];
    return new Response(assets.get(name)!.slice());
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => vi.unstubAllGlobals());
describe("lazy GDB runtime cache", () => {
  it("makes no requests until called and uses subdirectory URLs, then works offline from verified cache", async () => {
    expect(fetcher).not.toHaveBeenCalled();
    const first = await loadGdbRuntime(base);
    expect(first.assets).toHaveLength(3);
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith(base.href)),
    ).toBe(true);
    fetcher.mockRejectedValue(new TypeError("offline"));
    const second = await loadGdbRuntime(base);
    expect(second.assets.map((a) => a.bytes.byteLength)).toEqual(
      first.assets.map((a) => a.bytes.byteLength),
    );
  });
  it("discards corrupted cached bytes and fetches a fresh copy", async () => {
    await loadGdbRuntime(base);
    const store = stores.get(`zgis-gdb-assets-${manifest.version}`)!;
    const url = new URL(`${manifest.version}/gdb-runtime.wasm`, base).href;
    store.set(url, new Response("broken"));
    fetcher.mockClear();
    await loadGdbRuntime(base);
    expect(fetcher.mock.calls.map(([value]) => value)).toEqual([
      new URL("manifest.json", base).href,
      url,
    ]);
    expect(await sha256(await store.get(url)!.clone().arrayBuffer())).toBe(
      manifest.files[1].sha256,
    );
  });
  it("keeps the last complete runtime offline after an interrupted version update", async () => {
    const first = await loadGdbRuntime(base);
    manifest = { ...manifest, version: "gdal-update-v2" };
    const online = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string) => {
      if (url.endsWith("gdb-runtime.wasm")) throw new TypeError("connection lost");
      return online(url);
    });
    await expect(loadGdbRuntime(base)).rejects.toThrow("connection lost");
    fetcher.mockRejectedValue(new TypeError("offline"));
    const offline = await loadGdbRuntime(base);
    expect(offline.manifest.version).toBe(first.manifest.version);
    expect(offline.assets).toHaveLength(3);
  });
  it("does not replace the complete offline runtime when a new version exceeds cache quota", async () => {
    const first = await loadGdbRuntime(base);
    manifest = { ...manifest, version: "gdal-update-v2" };
    failedCacheWrites.add(`zgis-gdb-assets-${manifest.version}`);
    const updated = await loadGdbRuntime(base);
    expect(updated.manifest.version).toBe("gdal-update-v2");
    expect(updated.assets).toHaveLength(3);
    expect(updated.warnings).toHaveLength(1);
    fetcher.mockRejectedValue(new TypeError("offline"));
    const offline = await loadGdbRuntime(base);
    expect(offline.manifest.version).toBe(first.manifest.version);
    expect(offline.assets).toHaveLength(3);
  });
  it("never caches an oversized or hash-mismatched response", async () => {
    assets.set("gdb-runtime.wasm", new Uint8Array(manifest.files[1].size + 1));
    await expect(loadGdbRuntime(base)).rejects.toThrow("INTEGRITY_FAILED");
    expect(
      stores
        .get(`zgis-gdb-assets-${manifest.version}`)
        ?.has(new URL(`${manifest.version}/gdb-runtime.wasm`, base).href),
    ).toBe(false);
  });
  it("continues for this session with an explicit warning when CacheStorage is unavailable", async () => {
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("quota");
      },
    });
    const result = await loadGdbRuntime(base);
    expect(result.assets).toHaveLength(3);
    expect(result.warnings).toHaveLength(1);
  });
  it("aborts before downloading and rejects unsafe manifests and cross-origin runtimes", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadGdbRuntime(base, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() =>
      validateRuntimeManifest({
        ...manifest,
        files: [{ ...manifest.files[0], name: "../bad.js" }],
      }),
    ).toThrow();
    expect(() =>
      validateRuntimeManifest({
        ...manifest,
        files: [...manifest.files, manifest.files[0]],
      }),
    ).toThrow();
    await expect(
      loadGdbRuntime(new URL("https://other.test/gdb-runtime/")),
    ).rejects.toThrow("ORIGIN_INVALID");
  });
});
