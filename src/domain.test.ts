import { describe, it, expect } from "vitest";
import {
  importCsv,
  exportCsv,
  importGeoJSON,
  exportGeoJSON,
  validateGeometry,
  importFiles,
} from "./domain";
import { zipSync, strToU8 } from "fflate";
describe("地理数据格式转换", () => {
  it.each(["EPSG:4326", "EPSG:4490", "EPSG:3857"])("%s CSV 导出再导入保持工作坐标", (crs) => {
    const features = importCsv("x,y\n116.4,39.9");
    const result = importCsv(exportCsv(features, { mode: "xy", crs, xColumn: "x", yColumn: "y" }), { crs });
    const coordinates = (result[0].geometry as { coordinates: number[] }).coordinates;
    expect(coordinates[0]).toBeCloseTo(116.4, 8);
    expect(coordinates[1]).toBeCloseTo(39.9, 8);
    if (crs === "EPSG:3857") expect(exportCsv(features, { mode: "xy", crs })).toContain("12957588");
  });
  it("4490 WKT 导入和默认 4326 保持经纬度顺序", () => {
    const text = 'wkt\n"POINT (116.4 39.9)"';
    expect(importCsv(text, { crs: "EPSG:4490" })[0].geometry).toEqual(importCsv(text)[0].geometry);
    expect(() => exportCsv(importCsv("x,y\n0,90"), { mode: "xy", crs: "EPSG:3857" })).toThrow("85.05112878");
  });
  it("不同 CSV 独立识别坐标列并拒绝错误映射", async () => {
    const files = [
      { name: "a.csv", bytes: Array.from(strToU8("x,y\n1,2")) },
      { name: "b.csv", bytes: Array.from(strToU8("lon,lat\n3,4")) },
    ];
    const layers = await importFiles(files, {}, [
      { xColumn: "x", yColumn: "y" },
      {},
    ]);
    expect(layers.map((layer) => layer.features[0].geometry)).toEqual([
      { type: "Point", coordinates: [1, 2] },
      { type: "Point", coordinates: [3, 4] },
    ]);
    await expect(
      importFiles(files, { xColumn: "x", yColumn: "y" }),
    ).rejects.toThrow("不存在列 x");
    expect(() => importCsv("x,y\n1,2", { xColumn: "x", yColumn: "x" })).toThrow(
      "同一列",
    );
    expect(() => importCsv("x,y\n1,2", { geometryMode: "wkt" })).toThrow(
      "WKT 列",
    );
  });
  it("CSV 保留前导零、引号、多行属性", () => {
    const features = importCsv(
      'code,note,wkt\r\n001,"a,""quoted""\nline","POINT (116 39)"',
    );
    expect(features[0].properties.code).toBe("001");
    expect(features[0].properties.note).toBe('a,"quoted"\nline');
    const roundtrip = importCsv(exportCsv(features, { mode: "wkt" }))[0];
    expect(roundtrip.properties.code).toBe("001");
    expect(roundtrip.properties.note).toBe(features[0].properties.note);
    expect(roundtrip.geometry).toEqual(features[0].geometry);
  });
  it("面洞与 Multi 几何 WKT 往返", () => {
    const features = importCsv(
      'wkt\n"POLYGON ((0 0,4 0,4 4,0 0),(1 1,2 1,2 2,1 1))"\n"MULTIPOINT ((1 2),(3 4))"',
    );
    expect(
      importCsv(exportCsv(features, { mode: "wkt" })).map((f) => f.geometry),
    ).toEqual(features.map((f) => f.geometry));
  });
  it("Web Mercator 转 WGS84", () => {
    const result = importCsv("x,y\n12913060.932,4851421.175", {
      crs: "EPSG:3857",
    });
    expect(result[0].geometry?.type).toBe("Point");
    const coordinates = (result[0].geometry as { coordinates: number[] })
      .coordinates;
    expect(coordinates[0]).toBeCloseTo(116, 3);
    expect(coordinates[1]).toBeCloseTo(39.9, 2);
  });
  it("拒绝无效几何、未知投影、非点 XY 导出", () => {
    expect(() => importCsv('wkt\n"POINT Z (1 2 3)"')).toThrow("二维");
    expect(() => importCsv("x,y\n1,2", { crs: "EPSG:UNKNOWN" })).toThrow(
      "未知坐标系",
    );
    expect(() =>
      exportCsv(importCsv('wkt\n"LINESTRING (0 0,1 1)"'), { mode: "xy" }),
    ).toThrow("Point");
    expect(
      validateGeometry({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      }),
    ).toContain("面环必须闭合且至少四个坐标");
  });
  it("GeoJSON 保留大整数和精确小数属性", () => {
    const features = importGeoJSON(
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"id":9007199254740993,"decimal":1.1234567890123456789}}',
    );
    expect(features[0].properties.id).toBe("9007199254740993");
    expect(features[0].properties.decimal).toBe("1.1234567890123456789");
    expect(importGeoJSON(exportGeoJSON(features))[0].geometry).toEqual(
      features[0].geometry,
    );
  });
  it("GeoJSON 来源 ID 独立保存，普通小数保留数值类型，属性 coordinates 不损精度", () => {
    const features = importGeoJSON(
      '{"type":"FeatureCollection","features":[{"type":"Feature","id":"city-001","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"decimal":1.25,"coordinates":[9007199254740993,1.1234567890123456789]}},{"type":"Feature","id":42,"geometry":null,"properties":{}}]}',
    );
    expect(features[0].sourceFeatureId).toBe("city-001");
    expect(features[0].id).not.toBe("city-001");
    expect(features[0].properties.decimal).toBe(1.25);
    expect(features[0].properties.coordinates).toEqual([
      "9007199254740993",
      "1.1234567890123456789",
    ]);
    const result = JSON.parse(exportGeoJSON(features));
    expect(result.features.map((f: { id: unknown }) => f.id)).toEqual([
      "city-001",
      42,
    ]);
    expect(importGeoJSON(exportGeoJSON(features))[0].properties).toEqual(
      features[0].properties,
    );
  });
  it("SHP 与 ZIP 必须带投影，ZIP 拒绝路径穿越", async () => {
    await expect(
      importFiles([{ name: "sample.shp", bytes: [] }]),
    ).rejects.toThrow("缺少 .prj");
    const missingProjection = Array.from(
      zipSync({ "sample.shp": new Uint8Array() }),
    );
    const unsafePath = Array.from(zipSync({ "../sample.prj": strToU8("x") }));
    await expect(
      importFiles([{ name: "sample.zip", bytes: missingProjection }]),
    ).rejects.toThrow("缺少 .prj");
    await expect(
      importFiles([{ name: "unsafe.zip", bytes: unsafePath }]),
    ).rejects.toThrow("不安全路径");
  });
  it("CSV 导出切换几何表达移除旧坐标，空值与源句柄保留", async () => {
    const text = "code,x,y\n001,116,39\n002,,";
    const [layer] = await importFiles([
      {
        name: "points.csv",
        sourceId: "source-1",
        bytes: Array.from(strToU8(text)),
      },
    ]);
    expect(layer.sourceId).toBe("source-1");
    expect(layer.csvConfig?.xColumn).toBe("x");
    expect(layer.features[1].geometry).toBeNull();
    const output = exportCsv(layer.features, {
      ...layer.csvConfig,
      mode: "wkt",
    });
    expect(output.split("\r\n")[0]).toBe("code,wkt");
    expect(importCsv(output)[0].properties.code).toBe("001");
  });
});
