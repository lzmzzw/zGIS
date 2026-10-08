import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GeoFeature } from "./domain/types";
export const desktop = isTauri();
export interface InputFile {
  name: string;
  bytes: number[];
  sourceId?: string;
}
export interface DroppedFiles {
  files: InputFile[];
  error: string | null;
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
  openProjectLink: (target: "github" | "license" | "releases") =>
    invoke<void>("open_project_link", { target }),
  mcpTools: () => invoke<McpToolDefinition[]>("gis_mcp_tool_catalog"),
  runAnalysis: (
    operation: string,
    parameters: Record<string, unknown>,
    source: GeoFeature[],
    target?: GeoFeature[],
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
      source: features(source),
      target: target ? features(target) : null,
    });
  },
  mcpStatus: () => invoke<McpStatus>("gis_mcp_status"),
  mcpEnable: (enabled: boolean) =>
    invoke<McpStatus>("gis_mcp_set_enabled", { enabled }),
  mcpSync: (layers: unknown[], activeLayerId?: string) =>
    invoke("gis_workspace_sync", {
      layers,
      activeLayerId: activeLayerId ?? null,
    }),
  mcpResults: () => invoke<AnalysisLayer[]>("gis_results_drain"),
  renameSourceFile: (sourceId: string, newName: string) =>
    invoke<{ sourceId: string; name: string; path: string }>(
      "rename_source_file",
      { sourceId, newName },
    ),
  open: () => invoke<InputFile[]>("open_files"),
  save: (
    content: string,
    suggestedName: string,
    sourceId?: string,
    overwrite = false,
    preserveExtension?: string,
  ) =>
    invoke<{ sourceId: string; name: string; path: string } | null>(
      "save_file",
      { content, suggestedName, sourceId, overwrite, preserveExtension },
    ),
  exportShapefile: (
    features: GeoFeature[],
    suggestedName: string,
    crs = "EPSG:4326",
  ) =>
    invoke<{ sourceId: string; name: string; path: string } | null>(
      "export_shapefile",
      {
        features: features.map(({ geometry, properties }) => ({
          type: "Feature",
          geometry,
          properties,
        })),
        suggestedName,
        crs,
      },
    ),
  saveShapefileFolder: (
    features: GeoFeature[],
    suggestedName: string,
    crs = "EPSG:4326",
  ) =>
    invoke<{ sourceId: string; name: string; path: string } | null>(
      "save_shapefile_folder",
      {
        features: features.map(({ geometry, properties }) => ({
          type: "Feature",
          geometry,
          properties,
        })),
        suggestedName,
        crs,
      },
    ),
  preferences: () => invoke<string | null>("load_preferences"),
  savePreferences: (content: string) => invoke("save_preferences", { content }),
  fetchBasemapTile: (url: string) =>
    invoke<string>("fetch_basemap_tile", { url }),
  recover: () => invoke<string | null>("load_recovery"),
  backup: (content: string) => invoke("save_recovery", { content }),
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
export function download(content: string, name: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
