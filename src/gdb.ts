import {
  makeLayer,
  normalizeWorkingFeature,
  type DocumentLayer,
  type GeoFeature,
} from "./domain";
import type { GdbField, GdbSource } from "./domain/types";

export interface GdbLayerInfo {
  name: string;
  group?: string;
  alias?: string;
  geometryType: string;
  featureCount: number | null;
  sourceCrs: string;
  sourceCrsWkt: string;
  fields: GdbField[];
  supported: boolean;
  reason?: string;
  warnings: string[];
}
export interface GdbCatalog {
  sourceId: string;
  path: string;
  fingerprint: string;
  layers: GdbLayerInfo[];
  warnings: string[];
}
export interface GdbReadOptions {
  layerName: string;
  limit: number;
  fields: string[];
  bounds?: number[];
  allowApproximateDatum?: boolean;
}
export interface GdbReadResult {
  features: GeoFeature[];
  sourceCrs: string;
  sourceCrsWkt: string;
  fields: GdbField[];
  geometryType: string;
  warnings: string[];
  truncated: boolean;
  loadedCount: number;
  readLimit: number;
  bounds?: number[] | null;
  sourceFingerprint: string;
  transformation: string;
}
export interface GdbAdapter {
  openGdb(requestId: string, zipped: boolean): Promise<GdbCatalog | null>;
  readGdb(
    requestId: string,
    sourceId: string,
    options: GdbReadOptions,
  ): Promise<GdbReadResult>;
  cancelGdb(requestId: string): Promise<unknown>;
}

/** Source identity is the guard; a missing path or damaged metadata must never grant edit rights. */
export const isGdbLayer = (layer: DocumentLayer | undefined): boolean =>
  Boolean(
    layer &&
    (layer.sourceKind === "gdb" || layer.gdb || layer.restoredFrom === "gdb"),
  );

export function assertWritableLayer(layer: DocumentLayer): void {
  if (isGdbLayer(layer)) throw new Error("GDB 图层只读，请使用导出生成新文件");
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 65536): value is string =>
  typeof value === "string" && value.length <= max;

export function validateGdbBounds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
    value[0] < -180 ||
    value[2] > 180 ||
    value[1] < -90 ||
    value[3] > 90 ||
    value[0] >= value[2] ||
    value[1] >= value[3]
  )
    throw new Error(
      "GDB 范围须为有效的西、南、东、北经纬度，不支持跨日期变更线",
    );
  return [...value] as number[];
}

/** Whitelist persisted metadata: never restore live handles or a caller-supplied writable flag. */
export function safeGdbSource(value: unknown): GdbSource {
  if (
    !record(value) ||
    !text(value.layerName, 1024) ||
    !value.layerName ||
    !text(value.fingerprint, 1024) ||
    !value.fingerprint ||
    !text(value.sourceCrs) ||
    !value.sourceCrs ||
    !text(value.sourceCrsWkt) ||
    !value.sourceCrsWkt ||
    !text(value.geometryType, 1024) ||
    !text(value.transformation) ||
    !Array.isArray(value.fields) ||
    value.fields.length > 1024 ||
    !Number.isSafeInteger(value.readLimit) ||
    Number(value.readLimit) < 1 ||
    Number(value.readLimit) > 100000 ||
    !Number.isSafeInteger(value.loadedCount) ||
    Number(value.loadedCount) < 0 ||
    Number(value.loadedCount) > Number(value.readLimit) ||
    typeof value.truncated !== "boolean" ||
    (value.allowApproximateDatum !== undefined &&
      typeof value.allowApproximateDatum !== "boolean")
  )
    throw new Error("GDB 来源元数据无效");
  const names = new Set<string>();
  const fields = value.fields.map((field: unknown): GdbField => {
    if (
      !record(field) ||
      !text(field.name, 1024) ||
      !field.name ||
      names.has(field.name) ||
      !text(field.type, 1024) ||
      typeof field.nullable !== "boolean" ||
      (field.alias !== undefined && !text(field.alias, 1024)) ||
      (field.domain !== undefined && !text(field.domain))
    )
      throw new Error("GDB 字段元数据无效");
    names.add(field.name);
    return {
      name: field.name,
      type: field.type,
      nullable: field.nullable,
      ...(field.alias !== undefined ? { alias: field.alias as string } : {}),
      ...(field.domain !== undefined ? { domain: field.domain as string } : {}),
    };
  });
  return {
    layerName: value.layerName,
    fingerprint: value.fingerprint,
    sourceCrs: value.sourceCrs,
    sourceCrsWkt: value.sourceCrsWkt,
    geometryType: value.geometryType,
    transformation: value.transformation,
    fields,
    readLimit: Number(value.readLimit),
    loadedCount: Number(value.loadedCount),
    truncated: value.truncated,
    ...(value.bounds == null
      ? {}
      : { bounds: validateGdbBounds(value.bounds) }),
    allowApproximateDatum: value.allowApproximateDatum === true,
  };
}

export function makeGdbLayer(
  catalog: GdbCatalog,
  options: GdbReadOptions,
  result: GdbReadResult,
): DocumentLayer {
  if (
    !Array.isArray(result.features) ||
    result.features.length !== result.loadedCount ||
    result.readLimit !== options.limit ||
    !Array.isArray(result.warnings) ||
    result.warnings.some((w) => typeof w !== "string")
  )
    throw new Error("GDB 读取结果无效");
  const source = safeGdbSource({
    ...result,
    layerName: options.layerName,
    fingerprint: result.sourceFingerprint,
    allowApproximateDatum: options.allowApproximateDatum === true,
  });
  return makeLayer(
    options.layerName,
    result.features.map((feature) => normalizeWorkingFeature(feature)),
    "gdb",
    {
      sourcePath: catalog.path,
      sourceHash: source.fingerprint,
      originalCrs: source.sourceCrs,
      gdb: source,
      fieldNames: source.fields.map((field) => field.name),
      dirty: false,
      warnings: [
        ...result.warnings,
        ...(result.truncated
          ? ["GDB 仅加载上限内的要素；查询、分析和导出均仅包含当前副本"]
          : []),
      ],
    },
  );
}
