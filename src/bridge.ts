import { invoke, isTauri } from "@tauri-apps/api/core";
import type { GeoFeature } from "./domain/types";
export const desktop = isTauri();
export interface InputFile {
  name: string;
  bytes: number[];
  sourceId?: string;
}
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
  exportShapefile: (features: GeoFeature[], suggestedName: string) =>
    invoke<{ sourceId: string; name: string; path: string } | null>(
      "export_shapefile",
      {
        features: features.map(({ geometry, properties }) => ({
          type: "Feature",
          geometry,
          properties,
        })),
        suggestedName,
      },
    ),
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
