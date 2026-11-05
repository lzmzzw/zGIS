import { describe, expect, it } from "vitest";
import errors from "./errors";
import { translate } from "./index";
import { safeDatabaseIdentity } from "../databaseRecovery";

describe("service diagnostic translations", () => {
  it("covers every production native and shared-core Chinese diagnostic", () => {
    const sources = import.meta.glob<string>([
      "../../src-tauri/src/*.rs", "../../crates/spatial-core/src/*.rs",
      "!../../src-tauri/src/macos_menu.rs",
    ], { query: "?raw", import: "default", eager: true });
    const nativeTitles = new Set(["导出 Shapefile ZIP", "另存 SHP：选择目标文件夹", "打开空间文件", "另存图层", "打开 GDB ZIP", "打开 GDB 文件夹"]);
    for (const [path, contents] of Object.entries(sources)) {
      const production = contents.split(/#\[cfg\(test\)\]\s*mod \w+/)[0];
      for (const match of production.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
        const canonical = match[1];
        if (!/[\u4e00-\u9fff]/.test(canonical) || nativeTitles.has(canonical)) continue;
        // SQL placeholders are actual preview data; the Agent prompt is a protocol instruction.
        if (canonical.startsWith("CASE WHEN") || canonical.startsWith("你是") || canonical === "[已脱敏]") continue;
        const sample = canonical.replace(/\{[^{}]*\}/g, "PROBE");
        expect(translate(sample, "en"), `${path}: ${canonical}`).not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it("provides English text with identical named placeholders for every diagnostic", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\d+|[a-zA-Z_]\w*)\}/g)].map((match) => match[1]).sort();
    for (const [source, target] of Object.entries(errors)) {
      expect(target, source).not.toMatch(/[\u4e00-\u9fff]/);
      expect(placeholders(target), source).toEqual(placeholders(source));
    }
  });

  it("translates nested diagnostics while retaining opaque Chinese field names", () => {
    expect(translate("要素 3: 无效几何", "en")).toBe("Feature 3: Invalid geometry");
    expect(translate("CSV 第 7 行：X/Y 坐标缺失", "en")).toBe("CSV row 7: X/Y coordinates are missing");
    expect(translate("字段 中文业务名称 不允许 NULL", "en")).toBe("Field 中文业务名称 does not allow NULL");
    expect(translate("不支持文件：中文文件.geojson", "en")).toBe("Unsupported file: 中文文件.geojson");
    expect(translate("Feature 3: Invalid geometry", "zh-CN")).toBe("要素 3: 无效几何");
  });

  it("translates GeoJSON locations without translating business IDs", () => {
    expect(translate("GeoJSON 第 2 个要素（ID 中文业务） · geometry.coordinates：坐标数组为空或结构无效", "en"))
      .toBe("GeoJSON feature 2（ID 中文业务） · geometry.coordinates: Coordinate array is empty or invalid");
  });

  it("translates all controlled recovery labels from actual validation failures", () => {
    const valid = { engine: "postgis", keyColumns: ["id"], columns: [{ name: "业务字段", type: "text", nullable: true }],
      sourceId: "source", schema: "public", table: "业务表", geometryColumn: "geom", geometryKind: "geometry", srid: 4326 };
    const invalid = [
      { ...valid, keyColumns: [null] },
      { ...valid, columns: [{ ...valid.columns[0], name: null }] },
      { ...valid, columns: [{ ...valid.columns[0], type: null }] },
      { ...valid, sourceId: null }, { ...valid, schema: null }, { ...valid, table: null }, { ...valid, geometryColumn: null },
    ];
    for (const identity of invalid) {
      let diagnostic = "";
      try { safeDatabaseIdentity(identity, "postgis"); } catch (error) { diagnostic = (error as Error).message; }
      expect(diagnostic).toMatch(/^恢复数据库/);
      expect(translate(diagnostic, "en"), diagnostic).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("translates parameter and nested spatial/export errors while retaining user field names", () => {
    for (const diagnostic of [
      "distanceMeters 必须 > 0 且 <= 100000", "predicate 必须为字符串", "spatial_query 的 bbox 与 target 必须二选一",
      "要素 4: 仅支持 XY/XYZ 坐标，不支持 M/ZM", "简化结果未通过校验，请降低容差: 面环必须闭合",
      "字段结构已提交；数据修改未完成或结果待核对。请重新读取图层，禁止直接重试原变更。几何字段不允许NULL",
    ]) expect(translate(diagnostic, "en"), diagnostic).not.toMatch(/[\u4e00-\u9fff]/);
    expect(translate("字段 中文业务名：属性类型不一致", "en")).toBe("Field 中文业务名: Inconsistent property types");
  });
});
