import { describe, expect, it } from "vitest";
import { defaultBasemaps, moveBasemap, validateXyzUrl } from "./basemaps";

describe("basemap services", () => {
  it("accepts XYZ templates and rejects incomplete, unsafe and credential URLs", () => {
    expect(
      validateXyzUrl("https://tiles.example.com/{z}/{x}/{y}.png?token=abc"),
    ).toBe(true);
    expect(validateXyzUrl("http://localhost:8080/{z}/{x}/{y}")).toBe(true);
    for (const url of [
      "https://tiles.example.com/{z}/{x}",
      "file:///tiles/{z}/{x}/{y}",
      "javascript:{z}/{x}/{y}",
      "https://user:password@example.com/{z}/{x}/{y}",
      "invalid",
    ])
      expect(validateXyzUrl(url)).toBe(false);
  });
  it("reorders services without mutating input or crossing boundaries", () => {
    const result = moveBasemap(defaultBasemaps, "tdt-img", -1);
    expect(result.map((service) => service.id)).toEqual([
      "osm",
      "tdt-img",
      "tdt-vec",
    ]);
    expect(defaultBasemaps.map((service) => service.id)).toEqual([
      "osm",
      "tdt-vec",
      "tdt-img",
    ]);
    expect(moveBasemap(defaultBasemaps, "osm", -1)).toBe(defaultBasemaps);
    expect(moveBasemap(defaultBasemaps, "unknown", 1)).toBe(defaultBasemaps);
  });
});
