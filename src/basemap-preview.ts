import { api, desktop } from "./bridge";
import type { BasemapService } from "./basemaps";

const WUHAN = [114.3055, 30.5928] as const;
const WIDTH = 288;
const HEIGHT = 144;
const TILE_SIZE = 256;

export function previewRegion(maxZoom?: number) {
  const zoom = Math.min(11, maxZoom ?? 11);
  const scale = TILE_SIZE * 2 ** zoom;
  const latitude = (WUHAN[1] * Math.PI) / 180;
  const centerX = ((WUHAN[0] + 180) / 360) * scale;
  const centerY =
    ((1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) /
      2) *
    scale;
  return { zoom, left: centerX - WIDTH / 2, top: centerY - HEIGHT / 2 };
}

function tileUrl(template: string, zoom: number, x: number, y: number) {
  return template
    .replaceAll("{z}", String(zoom))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y));
}

export function previewTileUrl(service: BasemapService) {
  if (!service.url) return undefined;
  const { zoom, left, top } = previewRegion(service.maxZoom);
  return tileUrl(
    service.url,
    zoom,
    Math.floor((left + WIDTH / 2) / TILE_SIZE),
    Math.floor((top + HEIGHT / 2) / TILE_SIZE),
  );
}

async function readTile(url: string, signal: AbortSignal) {
  if (desktop) return api.fetchBasemapTile(url);
  const response = await fetch(url, { signal, credentials: "omit" });
  if (!response.ok) throw new Error("预览获取失败");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("预览获取失败");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("预览图片过大");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const blob = new Blob(chunks, {
    type: response.headers.get("content-type") ?? "",
  });
  return URL.createObjectURL(blob);
}

export async function createBasemapPreview(
  template: string,
  maxZoom: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = window.setTimeout(abort, 8000);
  try {
    const { zoom, left, top } = previewRegion(maxZoom);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("预览生成失败");
    const tiles: Promise<void>[] = [];
    const count = 2 ** zoom;
    for (
      let y = Math.floor(top / TILE_SIZE);
      y <= Math.floor((top + HEIGHT - 1) / TILE_SIZE);
      y++
    ) {
      for (
        let x = Math.floor(left / TILE_SIZE);
        x <= Math.floor((left + WIDTH - 1) / TILE_SIZE);
        x++
      ) {
        tiles.push(
          (async () => {
            controller.signal.throwIfAborted();
            const address = tileUrl(
              template,
              zoom,
              ((x % count) + count) % count,
              Math.max(0, Math.min(count - 1, y)),
            );
            const source = await readTile(address, controller.signal);
            try {
              controller.signal.throwIfAborted();
              const image = new Image();
              image.src = source;
              await image.decode();
              controller.signal.throwIfAborted();
              if (
                !image.naturalWidth ||
                image.naturalWidth > 2048 ||
                image.naturalHeight > 2048
              )
                throw new Error("预览图片无效");
              context.drawImage(
                image,
                x * TILE_SIZE - left,
                y * TILE_SIZE - top,
                TILE_SIZE,
                TILE_SIZE,
              );
            } finally {
              if (source.startsWith("blob:")) URL.revokeObjectURL(source);
            }
          })(),
        );
      }
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = () =>
        reject(new DOMException("预览已取消", "AbortError"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      Promise.all(tiles)
        .then(() => resolve(), reject)
        .finally(() => {
          controller.signal.removeEventListener("abort", aborted);
        });
      if (controller.signal.aborted) aborted();
    });
    controller.signal.throwIfAborted();
    const image = canvas.toDataURL("image/png");
    if (image.length > 128 * 1024) throw new Error("预览图片过大");
    return image;
  } finally {
    controller.abort();
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
