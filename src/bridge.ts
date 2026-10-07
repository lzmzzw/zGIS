import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { GeoFeature } from "./domain/types";
export const desktop = isTauri();
export interface InputFile {
  name: string;
  bytes: number[];
  sourceId?: string;
}
export interface DroppedFiles { files: InputFile[]; error: string | null; }
export const onFilesDropped = (handler: (payload: DroppedFiles) => void) =>
  listen<DroppedFiles>("gis-files-dropped", (event) => handler(event.payload));
export interface DbLayer {
  schema: string;
  table: string;
  geometryColumn: string;
  geometryKind: "geometry" | "wkt";
  srid: number;
  keyColumns: string[];
  columns: { name: string; type: string; nullable: boolean }[];
}
export interface DbConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: string;
}
export const api = {
  mcpTools: () => invoke<McpToolDefinition[]>("gis_mcp_tool_catalog"),
  mcpStatus: () => invoke<McpStatus>("gis_mcp_status"),
  mcpEnable: (enabled: boolean) => invoke<McpStatus>("gis_mcp_set_enabled", { enabled }),
  mcpSync: (layers: unknown[], activeLayerId?: string) =>
    invoke("gis_workspace_sync", { layers, activeLayerId: activeLayerId ?? null }),
  mcpResults: () => invoke<AnalysisLayer[]>("gis_results_drain"),
  mcpAudit: () => invoke<unknown[]>("gis_mcp_audit"),
  open: () => invoke<InputFile[]>("open_files"),
  save: (
    content: string,
    suggestedName: string,
    sourceId?: string,
    overwrite = false,
  ) =>
    invoke<{ sourceId: string; name: string; path: string } | null>(
      "save_file",
      { content, suggestedName, sourceId, overwrite },
    ),
  exportShapefile: (features: GeoFeature[], suggestedName: string, crs = "EPSG:4326") =>
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
  preferences: () => invoke<string | null>("load_preferences"),
  savePreferences: (content: string) => invoke("save_preferences", { content }),
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
    invoke<{ features: GeoFeature[]; srid: number; truncated: boolean }>(
      "query_layer",
      { connectionId, ...layer, limit, bbox },
    ),
  commit: (connectionId: string, layer: DbLayer, changes: unknown[]) =>
    invoke("commit_changes", { connectionId, layer, changes }),
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
