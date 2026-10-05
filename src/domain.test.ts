import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  geometryFromWkt,
  geometryToWkt,
  importCsv,
  exportCsv,
  importGeoJSON,
  exportGeoJSON,
  validateGeometry,
  importFiles,
} from "./domain";
import { zipSync, strToU8 } from "fflate";
describe("地理数据格式转换", () => {
  it.each(["EPSG:4326", "EPSG:4490", "EPSG:3857"])("%s 多维 GeoJSON 仅经明确选择导入二维副本", async (crs) => {
    const base = JSON.parse(exportGeoJSON(importCsv("x,y\n116.4,39.9"), crs));
    base.features[0].geometry.coordinates.push(12.5, 7);
    const text = JSON.stringify(base);
    expect(() => importGeoJSON(text)).toThrow("第 1 个要素");
    expect(() => importGeoJSON(text)).toThrow("4 个分量");
    const file = { name: "original.geojson", sourceId: "original-handle", bytes: Array.from(strToU8(text)) };
    const [layer] = await importFiles([file], { geoJsonXYCopy: true });
    expect(layer.name).toBe("original-二维副本.geojson");
    expect(layer.sourceId).toBeUndefined();
    expect(layer.dirty).toBe(true);
    expect(layer.warnings?.join(" ")).toContain("Z/M 未载入");
    const coordinates = (layer.features[0].geometry as { coordinates: number[] }).coordinates;
    expect(coordinates).toHaveLength(2);
    expect(coordinates[0]).toBeCloseTo(116.4, 8);
    expect(coordinates[1]).toBeCloseTo(39.9, 8);
    expect(new TextDecoder().decode(new Uint8Array(file.bytes))).toBe(text);
  });
  it("多维面洞按二维副本保持结构，无效分量不可通过降维绕过", () => {
    const data = { type: "Feature", id: "area", properties: {}, geometry: { type: "Polygon", coordinates: [
      [[0,0,0],[4,0,1],[4,4,2],[0,0,0]], [[1,1,0],[2,1,0],[2,2,0],[1,1,0]],
    ] } };
    const result = importGeoJSON(JSON.stringify(data), undefined, true)[0];
    expect(result.geometry).toEqual({ type: "Polygon", coordinates: data.geometry.coordinates.map(ring => ring.map(point => point.slice(0, 2))) });
    const bad = '{"type":"Feature","id":"bad-1","geometry":{"type":"Point","coordinates":[116,39,null]},"properties":{}}';
    expect(() => importGeoJSON(bad, undefined, true)).toThrow("ID bad-1");
    expect(() => importGeoJSON(bad, undefined, true)).toThrow("有限数值");
    expect(() => importGeoJSON(bad.replace("null", '"0"'), undefined, true)).toThrow("字符串");
    expect(() => importGeoJSON(bad.replace("null", "1e400"), undefined, true)).toThrow("有限数值");
  });
  it.each(["EPSG:4326", "EPSG:4490", "EPSG:3857"])("%s GeoJSON 坐标与标记往返，保留属性和 ID", async (crs) => {
    const features = importGeoJSON('{"type":"Feature","id":"point-1","geometry":{"type":"Point","coordinates":[116.4,39.9]},"properties":{"id":9007199254740993}}');
    const output = exportGeoJSON(features, crs);
    const document = JSON.parse(output);
    expect(Boolean(document.crs)).toBe(crs !== "EPSG:4326");
    if (crs === "EPSG:3857") expect(document.features[0].geometry.coordinates[0]).toBeCloseTo(12957588.728337, 4);
    const [layer] = await importFiles([{ name: "point.geojson", bytes: Array.from(strToU8(output)) }]);
    expect(layer.originalCrs).toBe(crs);
    const restored = layer.features[0];
    const xy = (restored.geometry as { coordinates: number[] }).coordinates;
    expect(xy[0]).toBeCloseTo(116.4, 8);
    expect(xy[1]).toBeCloseTo(39.9, 8);
    expect(restored.sourceFeatureId).toBe("point-1");
    expect(restored.properties.id).toBe("9007199254740993");
  });
  it("无标记 GeoJSON 可显式指定来源，未知和冲突标记拒绝", () => {
    const projected = '{"type":"Feature","geometry":{"type":"Point","coordinates":[111319.49079327357,0]},"properties":{}}';
    expect((importGeoJSON(projected, "EPSG:3857")[0].geometry as { coordinates: number[] }).coordinates[0]).toBeCloseTo(1, 8);
    const tagged = exportGeoJSON(importCsv("x,y\n1,2"), "EPSG:4490");
    expect(() => importGeoJSON(tagged, "EPSG:4326")).toThrow("冲突");
    expect(() => importGeoJSON(tagged.replace("4490", "9999"))).toThrow("不支持");
    expect(() => exportGeoJSON([], "EPSG:9999")).toThrow("不支持");
  });
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
    expect(() => importCsv('wkt\n"POINT ZM (1 2 3 4)"')).toThrow("M/ZM");
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

it.each(["EPSG:4326", "EPSG:4490", "EPSG:3857"])("%s XYZ 往返保留非零高程", (crs) => {
 const original = importGeoJSON('{"type":"Feature","geometry":{"type":"Point","coordinates":[116.4,39.9,123.456]},"properties":{}}');
 const restored = importGeoJSON(exportGeoJSON(original, crs));
 expect((restored[0].geometry as {coordinates:number[]}).coordinates[2]).toBe(123.456);
});
it.each(["POINT Z (1 2 123.5)", "LINESTRING Z (1 2 5, 3 4 7)", "MULTIPOLYGON Z (((0 0 1,4 0 2,4 4 3,0 0 1)))"])("WKT 高程往返 %s", (text) => {
 const geometry = geometryFromWkt(text)!;
 expect(geometryFromWkt(geometryToWkt(geometry))).toEqual(geometry);
});
it.skipIf(!existsSync("output/smoke/xiang.geojson"))("xiang 实际 XYZ 多面导入保留全部高程", async () => {
 const {readFileSync} = await import("node:fs");
 const text = readFileSync("output/smoke/xiang.geojson", "utf8");
 const original = JSON.parse(text);
 const features = importGeoJSON(text);
 expect(features).toHaveLength(19);
 const output = JSON.parse(exportGeoJSON(features, "EPSG:4490"));
 let count = 0;
 const walk = (a: any[], b: any[]) => { if(typeof a[0] === "number") {expect(b[2]).toBe(a[2]);count++;} else a.forEach((v,i)=>walk(v,b[i])); };
 original.features.forEach((f:any,i:number)=>walk(f.geometry.coordinates,output.features[i].geometry.coordinates));
 expect(count).toBe(139446);
});

it("无 Z 标记的三分量 WKT 自动识别高程", () => { expect(geometryFromWkt("POINT (1 2 123.5)")).toEqual(geometryFromWkt("POINT Z (1 2 123.5)")); });
