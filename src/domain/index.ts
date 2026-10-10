import Papa from "papaparse";
import WKT from "ol/format/WKT";
import proj4 from "proj4";
import shp from "shpjs";
import { parse, LosslessNumber, isSafeNumber } from "lossless-json";
import { unzipSync } from "fflate";
import type { Geometry } from "geojson";
import type {
  DocumentLayer,
  GeoFeature,
  ImportOptions,
  InputFile,
} from "./types";
export type {
  DocumentLayer,
  GeoFeature,
  ImportOptions,
  InputFile,
} from "./types";
// CGCS2000: no survey-grade datum/epoch transformation is applied.
proj4.defs("EPSG:4490", "+proj=longlat +ellps=GRS80 +no_defs +type=crs");
const wkt = new WKT();
let sequence = 0;
const id = () => `feature-${Date.now()}-${++sequence}`;
const allowed = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);
export function validateGeometry(geometry: Geometry | null): string[] {
  if (!geometry) return [];
  if (!allowed.has(geometry.type))
    return ["不支持 GeometryCollection 或特殊几何"];
  const errors: string[] = [];
  const dimensions = new Set<number>();
  const check = (value: unknown): void => {
    if (!Array.isArray(value) || value.length === 0) {
      errors.push("坐标数组不能为空");
      return;
    }
    if (typeof value[0] === "number") {
      dimensions.add(value.length);
      if (value.length !== 2 && value.length !== 3) errors.push(`坐标有 ${value.length} 个分量，仅支持二维或带高程的 XYZ 坐标`);
      if (value.some((v) => typeof v !== "number" || !Number.isFinite(v)))
        errors.push("坐标分量必须是有限数值");
    } else value.forEach(check);
  };
  check(
    (geometry as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates,
  );
  if (dimensions.size > 1) errors.push("同一几何不能混合二维与 XYZ 坐标");
  const line = (points: number[][]) => {
    if (points.length < 2) errors.push("线至少需要两个顶点");
  };
  const ring = (points: number[][]) => {
    if (
      points.length < 4 ||
      JSON.stringify(points[0]) !== JSON.stringify(points.at(-1))
    )
      errors.push("面环必须闭合且至少四个坐标");
  };
  if (geometry.type === "LineString") line(geometry.coordinates);
  if (geometry.type === "MultiLineString") geometry.coordinates.forEach(line);
  if (geometry.type === "Polygon") geometry.coordinates.forEach(ring);
  if (geometry.type === "MultiPolygon")
    geometry.coordinates.forEach((p) => p.forEach(ring));
  return [...new Set(errors)];
}
export const cloneFeatures = (features: GeoFeature[]): GeoFeature[] =>
  structuredClone(features);
function assertGeometry(geometry: Geometry | null): void {
  const errors = validateGeometry(geometry);
  if (errors.length) throw new Error(errors.join("；"));
}
function transformGeometry(
  geometry: Geometry | null,
  from: string,
  to: string,
): Geometry | null {
  if (!geometry || from === to) return geometry;
  if (!proj4.defs(from) || !proj4.defs(to))
    throw new Error(`未知坐标系：${from} → ${to}`);
  const copy = structuredClone(geometry);
  const walk = (coords: unknown[]): unknown[] => {
    if (typeof coords[0] !== "number")
      return coords.map((c) => walk(c as unknown[]));
    if (to === "EPSG:3857" && Math.abs(coords[1] as number) > 85.0511287798066)
      throw new Error("EPSG:3857 不支持超出 ±85.05112878° 的纬度");
    return [...proj4(from, to, (coords as number[]).slice(0, 2)), ...coords.slice(2)];
  };
  (copy as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates =
    walk(
      (copy as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates,
    ) as never;
  assertGeometry(copy);
  return copy;
}
export function geometryFromWkt(
  value: string,
  crs = "EPSG:4326",
): Geometry | null {
  if (!value.trim()) return null;
  if (/^\s*\w+\s+(M|ZM)\b/i.test(value)) throw new Error("暂不支持 WKT M/ZM；不会把测量值当高程或静默丢弃");
  // Some exporters omit the Z marker while writing three ordinates.
  if (!/^\s*\w+\s+Z\b/i.test(value)) {
    const positions = value.slice(value.indexOf("(")).split(/[(),]/).map(part => part.trim()).filter(Boolean);
    if (positions.length && positions.every(part => part.split(/\s+/).length === 3 && part.split(/\s+/).every(n => Number.isFinite(Number(n)))))
      value = value.replace(/^(\s*\w+)/, "$1 Z");
  }
  const geom = wkt.readGeometry(value);
  if (!geom) throw new Error("WKT 解析失败");
  const type = geom.getType();
  const geometry = {
    type,
    coordinates: (
      geom as unknown as { getCoordinates(): unknown }
    ).getCoordinates(),
  } as Geometry;
  assertGeometry(geometry);
  return transformGeometry(geometry, crs, "EPSG:4326");
}
export function importCsv(
  text: string,
  options: ImportOptions = {},
): GeoFeature[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  const errors = parsed.errors.filter(
    (e) => e.code !== "UndetectableDelimiter",
  );
  if (errors.length)
    throw new Error(
      errors
        .map((e) => `CSV 第 ${(e.row ?? 0) + 2} 行：${e.message}`)
        .join("；"),
    );
  if (Object.keys(parsed.meta.renamedHeaders ?? {}).length)
    throw new Error("CSV 包含重复列名，请先调整列名");
  const fields = parsed.meta.fields ?? [];
  const find = (names: string[]) =>
    fields.find((f) => names.includes(f.toLowerCase()));
  const wc =
    options.geometryMode === "xy"
      ? undefined
      : options.wktColumn || find(["wkt", "geometry", "geom"]);
  const xc = options.xColumn || find(["longitude", "lon", "lng", "x", "经度"]);
  const yc = options.yColumn || find(["latitude", "lat", "y", "纬度"]);
  if (options.geometryMode === "wkt" && !wc) throw new Error("请选择 WKT 列");
  if (!wc && (!xc || !yc)) throw new Error("请选择 WKT 列或 X/Y 坐标列");
  for (const column of wc ? [wc] : [xc!, yc!])
    if (!fields.includes(column)) throw new Error(`不存在列 ${column}`);
  if (!wc && xc === yc) throw new Error("X 和 Y 不能使用同一列");
  const crs = options.crs ?? "EPSG:4326";
  return parsed.data.map((row, index) => {
    try {
      let geometry: Geometry | null;
      if (wc) {
        if (!(wc in row)) throw new Error(`不存在列 ${wc}`);
        geometry = geometryFromWkt(row[wc], crs);
      } else {
        if (!row[xc!] && !row[yc!]) geometry = null;
        else {
          if (!row[xc!]?.trim() || !row[yc!]?.trim())
            throw new Error("X/Y 坐标缺失");
          geometry = transformGeometry(
            {
              type: "Point",
              coordinates: [Number(row[xc!]), Number(row[yc!])],
            },
            crs,
            "EPSG:4326",
          );
          assertGeometry(geometry);
        }
      }
      return { id: id(), geometry, properties: { ...row } };
    } catch (error) {
      throw new Error(`CSV 第 ${index + 2} 行：${(error as Error).message}`);
    }
  });
}
function plain(value: unknown, coordinate = false): unknown {
  if (value instanceof LosslessNumber) {
    const n = Number(value.value);
    return coordinate || isSafeNumber(value.value) ? n : value.value;
  }
  if (Array.isArray(value)) return value.map((v) => plain(v, coordinate));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, plain(v, coordinate)]),
    );
  return value;
}
export function parseProperties(text: string): Record<string, unknown> {
  const result = plain(parse(text));
  if (!result || Array.isArray(result) || typeof result !== "object")
    throw new Error("属性必须是 JSON 对象");
  return result as Record<string, unknown>;
}
export function geoJsonCrs(text: string, explicit?: string): string {
  const data = parse(text) as { crs?: { type?: string; properties?: { name?: string } } };
  let declared: string | undefined;
  if (data.crs !== undefined) {
    const name = data.crs?.type === "name" ? data.crs.properties?.name : undefined;
    const code = typeof name === "string" ? name.match(/^(?:EPSG:|urn:ogc:def:crs:EPSG:(?:[^:]*):|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/)(4326|4490|3857)$/i)?.[1] : undefined;
    if (code) declared = `EPSG:${code}`;
    else if (name === "urn:ogc:def:crs:OGC:1.3:CRS84" || name === "OGC:CRS84") declared = "EPSG:4326";
    else throw new Error("GeoJSON 坐标系标记无效或不支持；仅支持 EPSG:4326/4490/3857");
  }
  if (explicit && declared && explicit !== declared) throw new Error("指定坐标系与 GeoJSON crs 标记冲突");
  const crs = explicit ?? declared ?? "EPSG:4326";
  if (!["EPSG:4326", "EPSG:4490", "EPSG:3857"].includes(crs)) throw new Error("不支持的 GeoJSON 坐标系");
  return crs;
}
export function importGeoJSON(text: string, explicitCrs?: string, xyCopy = false): GeoFeature[] {
  const crs = geoJsonCrs(text, explicitCrs);
  const data = parse(text) as {
    type: string;
    features?: Array<{
      geometry: Geometry | null;
      properties?: Record<string, unknown>;
      id?: unknown;
    }>;
    geometry?: Geometry | null;
    properties?: Record<string, unknown>;
    id?: unknown;
  };

  const records =
    data.type === "FeatureCollection"
      ? data.features
      : data.type === "Feature"
        ? [data]
        : allowed.has(data.type)
          ? [{ geometry: data as unknown as Geometry, properties: {} }]
          : undefined;
  if (!records) throw new Error("无效或不支持的 GeoJSON");
  return records.map((record, index) => {
    const input = plain(record.geometry ?? null, true) as Geometry | null;
    // Normalize only an explicitly requested working copy; never coerce invalid numbers.
    const positions = (value: unknown, path: string): unknown => {
      const location = `GeoJSON 第 ${index + 1} 个要素${record.id !== undefined ? `（ID ${String(plain(record.id))}）` : ""} · ${path}`;
      if (!Array.isArray(value) || !value.length) throw new Error(`${location}：坐标数组为空或结构无效`);
      if (Array.isArray(value[0])) return value.map((child, i) => positions(child, `${path}[${i}]`));
      if (value.some(component => typeof component !== "number" || !Number.isFinite(component)))
        throw new Error(`${location}：坐标分量必须是有限数值，不接受字符串或 null`);
      if (value.length < 2) throw new Error(`${location}：坐标至少需要 X、Y 两个分量`);
      if (value.length > 3 && !xyCopy)
        throw new Error(`${location}：坐标含 ${value.length} 个分量（含 M 或额外分量），仅支持二维或带高程 XYZ；可勾选“按二维副本导入”后重试，原文件不变`);
      return xyCopy ? value.slice(0, 2) : value;
    };
    if (input && allowed.has(input.type)) {
      (input as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates = positions(
        (input as Exclude<Geometry, { type: "GeometryCollection" }>).coordinates, "geometry.coordinates",
      ) as never;
    }
    assertGeometry(input);
    const geometry = transformGeometry(input, crs, "EPSG:4326");
    assertGeometry(geometry);
    if (
      record.properties &&
      (typeof record.properties !== "object" ||
        Array.isArray(record.properties))
    )
      throw new Error("GeoJSON properties 必须是对象或 null");
    const sourceFeatureId = plain("id" in record ? record.id : undefined);
    if (
      sourceFeatureId !== undefined &&
      typeof sourceFeatureId !== "string" &&
      typeof sourceFeatureId !== "number"
    )
      throw new Error("GeoJSON Feature.id 必须是字符串或数值");
    return {
      id: id(),
      sourceFeatureId,
      geometry,
      properties: plain(record.properties ?? {}) as Record<string, unknown>,
    };
  });
}
export function exportGeoJSON(features: GeoFeature[], crs = "EPSG:4326"): string {
  if (!["EPSG:4326", "EPSG:4490", "EPSG:3857"].includes(crs)) throw new Error("不支持的 GeoJSON 坐标系");
  features.forEach((f) => assertGeometry(f.geometry));
  return JSON.stringify(
    {
      type: "FeatureCollection",
      ...(crs !== "EPSG:4326" ? { crs: { type: "name", properties: { name: `urn:ogc:def:crs:EPSG::${crs.split(":")[1]}` } } } : {}),
      features: features.map((f) => ({
        type: "Feature",
        ...(f.sourceFeatureId !== undefined ? { id: f.sourceFeatureId } : {}),
        geometry: transformGeometry(f.geometry, "EPSG:4326", crs),
        properties: f.properties,
      })),
    },
    null,
    2,
  );
}
export function exportCsv(
  features: GeoFeature[],
  options: {
    mode: "wkt" | "xy";
    crs?: string;
    wktColumn?: string;
    xColumn?: string;
    yColumn?: string;
  },
): string {
  const rows = features.map((feature) => {
    assertGeometry(feature.geometry);
    const geometry = transformGeometry(
      feature.geometry,
      "EPSG:4326",
      options.crs ?? "EPSG:4326",
    );
    const row: Record<string, unknown> = Object.fromEntries(
      Object.entries(feature.properties).map(([k, v]) => [
        k,
        v && typeof v === "object" ? JSON.stringify(v) : v,
      ]),
    );
    if (options.mode === "wkt") {
      if (options.xColumn) delete row[options.xColumn];
      if (options.yColumn) delete row[options.yColumn];
      const column = options.wktColumn ?? "wkt";
      row[column] = geometry ? geometryToWkt(geometry) : "";
    } else {
      if (options.wktColumn) delete row[options.wktColumn];
      if (geometry && geometry.type !== "Point")
        throw new Error("X/Y CSV 仅支持 Point；线面请导出 WKT");
      if (geometry?.type === "Point" && geometry.coordinates.length > 2)
        throw new Error("含高程坐标不能无损导出 X/Y CSV，请选择 WKT 或 GeoJSON；或明确导入二维副本");
      row[options.xColumn ?? "longitude"] =
        geometry && geometry.type === "Point" ? geometry.coordinates[0] : "";
      row[options.yColumn ?? "latitude"] =
        geometry && geometry.type === "Point" ? geometry.coordinates[1] : "";
    }
    return row;
  });
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return Papa.unparse({
    fields,
    data: rows.map((row) => fields.map((field) => row[field] ?? "")),
  });
}
import GeoJSON from "ol/format/GeoJSON";
export function geometryToWkt(geometry: Geometry): string {
  assertGeometry(geometry);
  return wkt.writeGeometry(new GeoJSON().readGeometry(geometry));
}
const colors = ["#16856b", "#c06438", "#5479b6", "#a35ca0"];
export function makeLayer(
  name: string,
  features: GeoFeature[],
  sourceKind: DocumentLayer["sourceKind"],
  extra: Partial<DocumentLayer> = {},
): DocumentLayer {
  return {
    id: id(),
    name,
    features,
    visible: true,
    color: colors[sequence % colors.length],
    sourceKind,
    crs: "EPSG:4326",
    dirty: false,
    ...extra,
  };
}
export async function importFiles(
  files: InputFile[],
  options: ImportOptions = {},
  perFileOptions?: ImportOptions[],
): Promise<DocumentLayer[]> {
  const layers: DocumentLayer[] = [];
  const decoder = new TextDecoder(options.encoding ?? "utf-8");
  const shpFiles = files.filter((f) => /\.(shp|dbf|prj|cpg)$/i.test(f.name));
  const bases = [
    ...new Set(
      shpFiles
        .filter((f) => /\.shp$/i.test(f.name))
        .map((f) => f.name.replace(/\.shp$/i, "")),
    ),
  ];
  for (const base of bases) {
    const pick = (ext: string) =>
      shpFiles.find(
        (f) => f.name.toLowerCase() === `${base}.${ext}`.toLowerCase(),
      );
    if (!pick("prj")) throw new Error(`${base} 缺少 .prj，不能猜测坐标系`);
    if (!pick("dbf")) throw new Error(`${base} 缺少 .dbf`);
    const result = await shp({
      shp: new Uint8Array(pick("shp")!.bytes).buffer,
      dbf: new Uint8Array(pick("dbf")!.bytes).buffer,
      prj: decoder.decode(new Uint8Array(pick("prj")!.bytes)),
      cpg: pick("cpg")
        ? decoder.decode(new Uint8Array(pick("cpg")!.bytes))
        : undefined,
    });
    layers.push(
      makeLayer(base, importGeoJSON(JSON.stringify(result)), "shp", {
        sourceId: pick("shp")?.sourceId,
        sourcePath: pick("shp")?.sourcePath,
        sourceHash: pick("shp")?.sourceHash,
        originalCrs: decoder.decode(new Uint8Array(pick("prj")!.bytes)),
        warnings: ["SHP 可编辑；编辑结果另存新文件，不覆盖原 SHP 文件组"],
      }),
    );
  }
  for (const [fileIndex, file] of files.entries()) {
    const fileOptions = { ...options, ...perFileOptions?.[fileIndex] };
    const text = () =>
      new TextDecoder(fileOptions.encoding ?? "utf-8").decode(
        new Uint8Array(file.bytes),
      );
    if (/\.(geojson|json)$/i.test(file.name))
      layers.push(
        makeLayer(fileOptions.geoJsonXYCopy ? file.name.replace(/\.(geojson|json)$/i, "-二维副本.geojson") : file.name, importGeoJSON(text(), fileOptions.crs, fileOptions.geoJsonXYCopy), "geojson", {
          originalCrs: geoJsonCrs(text(), fileOptions.crs),
          sourceId: fileOptions.geoJsonXYCopy ? undefined : file.sourceId,
          sourcePath: fileOptions.geoJsonXYCopy ? undefined : file.sourcePath,
          sourceHash: fileOptions.geoJsonXYCopy ? undefined : file.sourceHash,
          dirty: Boolean(fileOptions.geoJsonXYCopy),
          warnings: ["高精度数值属性以文本保存，导出时保持文本类型", ...(fileOptions.geoJsonXYCopy ? ["已明确选择二维副本；仅载入 X/Y，Z/M 未载入。原文件未修改，保存需另存新文件。"] : [])],
        }),
      );
    else if (/\.csv$/i.test(file.name)) {
      const fields = Papa.parse<string[]>(text(), { preview: 1 }).data[0] ?? [];
      const find = (names: string[]) =>
        fields.find((f) => names.includes(f.toLowerCase()));
      const config: ImportOptions = {
        ...fileOptions,
        wktColumn:
          fileOptions.geometryMode === "xy"
            ? undefined
            : fileOptions.wktColumn || find(["wkt", "geometry", "geom"]),
        xColumn:
          fileOptions.xColumn || find(["longitude", "lon", "lng", "x", "经度"]),
        yColumn: fileOptions.yColumn || find(["latitude", "lat", "y", "纬度"]),
      };
      layers.push(
        makeLayer(file.name, importCsv(text(), config), "csv", {
          sourceId: file.sourceId,
          sourcePath: file.sourcePath,
          sourceHash: file.sourceHash,
          csvConfig: config,
          originalCrs: fileOptions.crs ?? "EPSG:4326",
        }),
      );
    } else if (/\.zip$/i.test(file.name)) {
      const bytes = new Uint8Array(file.bytes);
      let count = 0,
        total = 0;
      const entries = unzipSync(bytes, {
        filter: (entry) => {
          if (
            ++count > 2000 ||
            (total += entry.originalSize) > 200 * 1024 * 1024
          )
            throw new Error("ZIP 超过 2000 个文件或 200 MB 解压限制");
          if (
            entry.name.startsWith("/") ||
            entry.name.split(/[\\/]/).includes("..")
          )
            throw new Error("ZIP 包含不安全路径");
          return /\.(shp|dbf|prj|cpg|shx)$/i.test(entry.name);
        },
      });
      const imported = await importFiles(
        Object.entries(entries).map(([name, data]) => ({
          name,
          bytes: data,
        })),
        options,
      );
      layers.push(
        ...imported.map((layer) => ({
          ...layer,
          sourceId: file.sourceId,
          sourcePath: file.sourcePath,
          sourceHash: file.sourceHash,
        })),
      );
    } else if (!/\.(shp|dbf|shx|prj|cpg)$/i.test(file.name))
      throw new Error(`不支持文件：${file.name}`);
  }
  if (!layers.length) throw new Error("未找到可导入图层");
  return layers;
}
