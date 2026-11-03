import { MAX_DESKTOP_FILE_BYTES } from "./fileLimits";
import { textChunks, TEXT_CHUNK_CHARS, type TextInput } from "./textContent";
import type { DocumentLayer } from "./domain";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GeoFeature } from "./domain/types";
export const desktop = isTauri();
export interface InputFile {
  name: string;
  bytes: number[] | Uint8Array;
  sourceId?: string;
  sourcePath?: string;
  sourceHash?: string;
}
export interface DroppedFiles {
  files: NativeInputFile[];
  error: string | null;
}
export type NativeInputFile = Omit<InputFile, "bytes"> & {
  bytes?: InputFile["bytes"];
  size?: number;
};
const RECOVERY_CHUNK_CHARS = TEXT_CHUNK_CHARS;
async function backupRecovery(content: TextInput): Promise<unknown> {
  if (typeof content === "string" && content.length > MAX_DESKTOP_FILE_BYTES) throw new Error("恢复数据过大");
  if (typeof content === "string" && content.length <= RECOVERY_CHUNK_CHARS)
    return invoke("save_recovery", new TextEncoder().encode(content));
  await uploadText("save_recovery", content);
}
async function uploadText(command: "save_recovery" | "stage_file_content", content: TextInput): Promise<string> {
  const encoder = new TextEncoder();
  const transferId = crypto.randomUUID();
  const prefix = command === "save_recovery" ? "x-zgis-recovery" : "x-zgis-output";
  let part = 0, total = 0;
  const chunks = textChunks(content);
  let current = chunks.next();
  try {
  do {
    const next = current.done ? current : chunks.next();
    const bytes = encoder.encode(current.done ? "" : current.value);
    total += bytes.byteLength;
    if (total > MAX_DESKTOP_FILE_BYTES) throw new Error(command === "save_recovery" ? "恢复数据过大" : "输出超过 256 MiB");
    await invoke(command, bytes, { headers: {
      [`${prefix}-id`]: transferId,
      [`${prefix}-part`]: String(part),
      [`${prefix}-final`]: String(next.done),
    } });
    part++;
    current = next;
  } while (!current.done);
  } finally { chunks.return(undefined); }
  return transferId;
}
/** 原生入口只传元数据；逐个使用二进制 IPC 读取，避免 JSON number[] 放大。 */
export async function readNativeFiles(files: NativeInputFile[]): Promise<InputFile[]> {
  let total = 0;
  for (const file of files) {
    const size = file.bytes?.length ?? file.size;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0 ||
        size > MAX_DESKTOP_FILE_BYTES || (total += size) > MAX_DESKTOP_FILE_BYTES)
      throw new Error("单次导入文件总大小不能超过 256 MiB");
  }
  const result: InputFile[] = [];
  for (const file of files) {
    if (file.bytes) { result.push({ ...file, bytes: file.bytes }); continue; }
    if (!file.sourceId) throw new Error("文件来源已失效，请重新打开");
    const buffer = await invoke<ArrayBuffer>("read_open_file", { sourceId: file.sourceId });
    const bytes = new Uint8Array(buffer);
    if (bytes.length !== file.size) throw new Error("读取时文件发生变化，请重试");
    result.push({ ...file, bytes });
  }
  return result;
}
export const onFilesDropped = (handler: (payload: DroppedFiles) => void) =>
  listen<DroppedFiles>("gis-files-dropped", (event) => handler(event.payload));
export interface DbLayer {
  engine?: "postgis" | "mysql";
  schema: string;
  table: string;
  geometryColumn: string;
  geometryKind: "geometry" | "wkt";
  srid: number;
  keyColumns: string[];
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    generated?: boolean;
    hasDefault?: boolean;
  }[];
}
export interface DbConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: string;
}
export interface DatabaseSource extends Omit<DbConnection, "password"> {
  id: string;
  name: string;
}
export interface DatabaseTable {
  schema: string;
  table: string;
  columns: DbLayer["columns"];
  keyColumns: string[];
  geometryColumns: { name: string; srid: number; type: string }[];
}
export interface DatabaseCatalog {
  schemas: string[];
  tables: DatabaseTable[];
}
export interface DatabasePreview {
  columns: DbLayer["columns"];
  rows: (string | null)[][];
  truncated: boolean;
}
export const api = {
  setLocale: (locale: "zh-CN" | "en") => invoke<void>("set_locale", { locale }),
  databaseSourcePassword: (engine: "postgis" | "mysql", sourceId: string) =>
    invoke<string | null>("load_database_source_password", {
      engine,
      sourceId,
    }),
  saveDatabaseSourcePassword: (
    engine: "postgis" | "mysql",
    sourceId: string,
    password: string,
  ) =>
    invoke<void>("save_database_source_password", {
      engine,
      sourceId,
      password,
    }),
  deleteDatabaseSourcePassword: (
    engine: "postgis" | "mysql",
    sourceId: string,
  ) => invoke<void>("delete_database_source_password", { engine, sourceId }),

  mysqlSources: () => invoke<DatabaseSource[]>("load_mysql_sources"),
  saveMysqlSources: (sources: DatabaseSource[]) =>
    invoke<void>("save_mysql_sources", { sources }),
  connectMysql: (config: DbConnection) =>
    invoke<string>("connect_mysql_database", { config }),
  disconnectMysql: (connectionId: string) =>
    invoke<void>("disconnect_mysql_database", { connectionId }),
  mysqlCatalog: (connectionId: string) =>
    invoke<DatabaseCatalog>("discover_mysql_tables", { connectionId }),
  previewMysqlTable: (
    connectionId: string,
    schema: string,
    table: string,
    limit: number,
  ) =>
    invoke<DatabasePreview>("preview_mysql_table", {
      connectionId,
      schema,
      table,
      limit,
    }),
  queryMysqlGeometry: (
    connectionId: string,
    schema: string,
    table: string,
    geometryColumn: string,
    limit: number,
    srid?: number,
  ) =>
    invoke<{ features: GeoFeature[]; srid: number; truncated: boolean }>(
      "query_mysql_geometry",
      { connectionId, schema, table, geometryColumn, limit, srid },
    ),
  databaseSources: () => invoke<DatabaseSource[]>("load_database_sources"),
  saveDatabaseSources: (sources: DatabaseSource[]) =>
    invoke<void>("save_database_sources", { sources }),
  databaseCatalog: (connectionId: string) =>
    invoke<DatabaseCatalog>("discover_database_tables", { connectionId }),
  previewDatabaseTable: (
    connectionId: string,
    schema: string,
    table: string,
    limit: number,
  ) =>
    invoke<DatabasePreview>("preview_database_table", {
      connectionId,
      schema,
      table,
      limit,
    }),
  disconnect: (connectionId: string) =>
    invoke<void>("disconnect_database", { connectionId }),
  checkAppUpdate: () => invoke<AppUpdateStatus>("check_app_update"),
  downloadAppUpdate: (expectedVersion: string) =>
    invoke<{ version: string; installation: "restart" | "manual" }>(
      "download_app_update",
      { expectedVersion },
    ),
  installAppUpdate: (expectedVersion: string) =>
    invoke<void>("install_app_update", { expectedVersion }),
  openProjectLink: (target: "github" | "license" | "releases") =>
    invoke<void>("open_project_link", { target }),
  mcpTools: () => invoke<McpToolDefinition[]>("gis_mcp_tool_catalog"),
  runAnalysis: (
    operation: string,
    parameters: Record<string, unknown>,
    source: GeoFeature[],
    target?: GeoFeature[],
    jobId?: string,
  ) => {
    const features = (input: GeoFeature[]) =>
      input.map(({ id, geometry, properties }) => ({
        type: "Feature",
        id,
        geometry,
        properties,
      }));
    return invoke<unknown>("gis_run_analysis", {
      operation,
      parameters,
      jobId: jobId ?? null,
      source: features(source),
      target: target ? features(target) : null,
    });
  },
  cancelAnalysis: (jobId: string) =>
    invoke<boolean>("gis_cancel_analysis", { jobId }),
  mcpResultsAck: (resultIds: string[]) =>
    invoke<void>("gis_results_ack", { resultIds }),
  mcpStatus: () => invoke<McpStatus>("gis_mcp_status"),
  mcpEnable: (enabled: boolean) =>
    invoke<McpStatus>("gis_mcp_set_enabled", { enabled }),
  mcpSync: (
    layers: unknown[],
    activeLayerId?: string,
    options?: { incremental?: boolean; removedLayerIds?: string[]; rejected?: "size" | "count" },
  ) =>
    invoke("gis_workspace_sync", {
      layers,
      activeLayerId: activeLayerId ?? null,
      incremental: options?.incremental ?? false,
      removedLayerIds: options?.removedLayerIds ?? [],
      rejected: options?.rejected ?? null,
    }),
  mcpResults: () => invoke<AnalysisLayer[]>("gis_results_drain"),
  renameSourceFile: (sourceId: string, newName: string) =>
    invoke<{
      sourceId: string;
      name: string;
      path: string;
      sourceHash: string;
    }>("rename_source_file", { sourceId, newName }),
  open: async () => readNativeFiles(await invoke<NativeInputFile[]>("open_files")),
  save: async (
    content: TextInput,
    suggestedName: string,
    sourceId?: string,
    sourcePath?: string,
    sourceHash?: string,
    overwrite = false,
    preserveExtension?: string,
  ) => {
    if (typeof content === "string" && content.length > MAX_DESKTOP_FILE_BYTES) throw new Error("输出超过 256 MiB");
    const transferId = typeof content !== "string" || content.length > RECOVERY_CHUNK_CHARS ? await uploadText("stage_file_content", content) : undefined;
    return invoke<{
      sourceId: string;
      name: string;
      path: string;
      sourceHash: string;
    } | null>("save_file", {
      content: transferId ? null : content,
      transferId,
      suggestedName,
      sourceId,
      sourcePath,
      sourceHash,
      overwrite,
      preserveExtension,
    });
  },
  exportShapefile: (
    features: GeoFeature[],
    suggestedName: string,
    crs = "EPSG:4326",
  ) =>
    invoke<{
      sourceId: string;
      name: string;
      path: string;
      sourceHash: string;
    } | null>("export_shapefile", {
      features: features.map(({ geometry, properties }) => ({
        type: "Feature",
        geometry,
        properties,
      })),
      suggestedName,
      crs,
    }),
  saveShapefileFolder: (
    features: GeoFeature[],
    suggestedName: string,
    crs = "EPSG:4326",
  ) =>
    invoke<{
      sourceId: string;
      name: string;
      path: string;
      sourceHash: string;
    } | null>("save_shapefile_folder", {
      features: features.map(({ geometry, properties }) => ({
        type: "Feature",
        geometry,
        properties,
      })),
      suggestedName,
      crs,
    }),
  saveShapefileSource: (layer: DocumentLayer) =>
    invoke<{
      sourceId: string;
      name: string;
      path: string;
      sourceHash: string;
    }>("save_shapefile_source", {
      features: layer.features.map(({ geometry, properties }) => ({
        type: "Feature",
        geometry,
        properties,
      })),
      sourceId: layer.sourceId,
      sourcePath: layer.sourcePath,
      sourceHash: layer.sourceHash,
      crs: layer.originalCrs,
      zipMember: layer.zipMember,
    }),
  preferences: () => invoke<string | null>("load_preferences"),
  savePreferences: (content: string) => invoke("save_preferences", { content }),
  fetchBasemapTile: (url: string) =>
    invoke<string>("fetch_basemap_tile", { url }),
  recover: async () => {
    const raw = await invoke<ArrayBuffer | number[] | string | null>("load_recovery");
    if (raw === null || typeof raw === "string") return raw;
    if (!(raw instanceof ArrayBuffer) && !Array.isArray(raw))
      throw new Error("恢复数据结构无效");
    const length = raw instanceof ArrayBuffer ? raw.byteLength : raw.length;
    if (length > MAX_DESKTOP_FILE_BYTES) throw new Error("恢复数据过大");
    if (Array.isArray(raw) && raw.some(value => !Number.isInteger(value) || value < 0 || value > 255))
      throw new Error("恢复数据结构无效");
    if (!length) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(raw instanceof ArrayBuffer ? raw : new Uint8Array(raw));
  },
  backup: backupRecovery,
  connect: (config: DbConnection) =>
    invoke<string>("connect_database", { config }),
  discover: (connectionId: string) =>
    invoke<DbLayer[]>("discover_layers", { connectionId }),
  query: (
    connectionId: string,
    layer: DbLayer,
    limit = 10000,
    bbox?: number[],
  ) =>
    invoke<{
      features: GeoFeature[];
      srid: number;
      truncated: boolean;
      writable?: boolean;
    }>(layer.engine === "mysql" ? "query_mysql_geometry" : "query_layer", {
      connectionId,
      ...layer,
      limit,
      bbox,
    }),
  commit: (
    connectionId: string,
    layer: DbLayer,
    changes: unknown[],
    schemaChanges: import("./domain/types").SchemaChange[] = [],
  ) =>
    invoke(
      layer.engine === "mysql" ? "commit_mysql_changes" : "commit_changes",
      { connectionId, layer, changes, schemaChanges },
    ),
  exportDb: (
    connectionId: string,
    schema: string,
    table: string,
    features: GeoFeature[],
  ) =>
    invoke("export_database", {
      connectionId,
      schema,
      table,
      features,
      newTable: true,
    }),
};
export interface AppUpdateStatus {
  currentVersion: string;
  status: "current" | "available" | "unpublished";
  latestVersion?: string;
}
export interface McpStatus {
  enabled: boolean;
  endpoint?: string | null;
  token?: string | null;
  startupError?: string | null;
  headersHelper?: string | null;
}
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface AnalysisLayer {
  id: string;
  name: string;
  features: unknown[];
}
export function download(content: TextInput, name: string) {
  const url = URL.createObjectURL(
    new Blob(typeof content === "string" ? [content] : [...textChunks(content)], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
