import { describe, expect, it } from "vitest";
import {
  defaultBasemaps,
  loadBasemapPreferences,
  selectBasemap,
  moveBasemap,
  validateXyzUrl,
} from "./basemaps";

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
    const services = [
      ...defaultBasemaps,
      { ...defaultBasemaps[0], id: "custom" },
    ];
    const result = moveBasemap(services, "custom", -1);
    expect(result.map((service) => service.id)).toEqual(["custom", "osm"]);
    expect(services.map((service) => service.id)).toEqual(["osm", "custom"]);
    expect(moveBasemap(services, "osm", -1)).toBe(services);
    expect(moveBasemap(services, "unknown", 1)).toBe(services);
  });
  it("migrates legacy built-ins while retaining custom service order and global visibility", () => {
    const config = loadBasemapPreferences(
      JSON.stringify({
        services: [
          { ...defaultBasemaps[0], url: undefined },
          { id: "tdt-vec", name: "天地图矢量" },
          { ...defaultBasemaps[0], id: "custom", name: "用户底图" },
          { id: "tdt-img", name: "天地图影像" },
        ],
        selected: "tdt-img",
        visible: false,
        tdtKey: "test-only",
        annotations: true,
      }),
    );
    expect(config.services.map((service) => service.id)).toEqual([
      "osm",
      "custom",
    ]);
    expect(config.services[0].url).toBe(defaultBasemaps[0].url);
    expect(config.selected).toBe("osm");
    expect(config.visible).toBe(false);
    expect(config).not.toHaveProperty("tdtKey");
  });
  it("preserves explicit custom URLs regardless of legacy IDs", () => {
    const custom = {
      ...defaultBasemaps[0],
      id: "tdt-img",
      name: "自定义服务",
      enabled: false,
    };
    const config = loadBasemapPreferences(
      JSON.stringify({ services: [custom], selected: custom.id }),
    );
    expect(config.services).toEqual([custom]);
    expect(config.selected).toBe("none");
  });
  it("allows empty configurations and selects only enabled services", () => {
    const hidden = { ...defaultBasemaps[0], enabled: false };
    const available = { ...defaultBasemaps[0], id: "custom" };
    expect(selectBasemap([hidden, available], "osm")).toBe("custom");
    expect(selectBasemap([hidden], "osm")).toBe("none");
    expect(
      loadBasemapPreferences(JSON.stringify({ services: [], selected: "osm" }))
        .services,
    ).toEqual([]);
    expect(
      loadBasemapPreferences(JSON.stringify({ services: [], selected: "osm" }))
        .selected,
    ).toBe("none");
  });
  it("rejects corrupt service configurations rather than overwriting custom data", () => {
    for (const services of [
      null,
      [null],
      [{ id: "broken", name: "坏服务" }],
      [defaultBasemaps[0], defaultBasemaps[0]],
      [{ ...defaultBasemaps[0], enabled: "false" }],
    ]) {
      expect(() =>
        loadBasemapPreferences(JSON.stringify({ services })),
      ).toThrow("底图配置无效");
    }
  });
});
