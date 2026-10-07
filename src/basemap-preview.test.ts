import { describe, expect, it } from "vitest";
import { defaultBasemaps } from "./basemaps";
import {
  createBasemapPreview,
  previewRegion,
  previewTileUrl,
} from "./basemap-preview";

describe("Wuhan basemap preview", () => {
  it("centers the viewport on Wuhan and respects service zoom limits", () => {
    for (const maxZoom of [undefined, 0, 5, 19]) {
      const region = previewRegion(maxZoom);
      expect(region.zoom).toBe(Math.min(11, maxZoom ?? 11));
      const scale = 256 * 2 ** region.zoom;
      expect(((region.left + 144) / scale) * 360 - 180).toBeCloseTo(
        114.3055,
        6,
      );
      const latitude =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (region.top + 72)) / scale))) *
          180) /
        Math.PI;
      expect(latitude).toBeCloseTo(30.5928, 6);
    }
  });
  it("replaces path and query placeholders with the same Wuhan tile coordinates", () => {
    const service = {
      ...defaultBasemaps[0],
      url: "https://example.com/{z}/{x}/{y}?z={z}&x={x}&y={y}",
    };
    const region = previewRegion(service.maxZoom);
    const x = Math.floor((region.left + 144) / 256);
    const y = Math.floor((region.top + 72) / 256);
    expect(previewTileUrl(service)).toBe(
      `https://example.com/11/${x}/${y}?z=11&x=${x}&y=${y}`,
    );
    expect(previewTileUrl({ ...service, url: undefined })).toBeUndefined();
  });
  it("rejects an already cancelled save before starting any image work", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createBasemapPreview(
        defaultBasemaps[0].url!,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
