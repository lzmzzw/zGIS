import type { Page } from "@playwright/test";
import type { GeoFeature } from "../src/domain";
export interface DesktopTestState {
  dropFiles: (files: {name:string;bytes:number[];sourceId?:string}[], error?:string) => Promise<void>;
  mcpEnabled: boolean;
  mcpPaths: string[];
  analysisResults: { id: string; name: string; features: unknown[] }[];
  calls: { command: string; args: Record<string, unknown> }[];
  commitError: string;
  queryError: string;
  backupError: string;
  saveError: string;
  saveCancelled: boolean;
  tileError: string;
  tileDelay: number;
  tileCompleted: number;
  appVersion: string;
  updateResult: { currentVersion: string; status: "current" | "available" | "unpublished"; latestVersion?: string };
  updateError: string;
  updateDelay: number;
  linkError: string;
  mcpTools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  mcpToolsError: string;
  snapshot: string | null;
  destroyed: boolean;
  features: GeoFeature[];
  requestClose: () => Promise<void>;
}
declare global {
  interface Window {
    __ZG_TEST__: DesktopTestState;
  }
}
export async function installDesktopMock(
  page: Page,
  snapshot: string | null = null,
) {
  await page.addInitScript(
    ({ snapshot }) => {
      const callbacks = new Map<number, (event: unknown) => unknown>();
      const listeners = new Map<number, { event: string; handler: number }>();
      let next = 1;
      const state: DesktopTestState = {
        mcpEnabled: false,
        mcpPaths: [],
        analysisResults: [],
        calls: [],
        commitError: "",
        queryError: "",
        backupError: "",
        saveError: "",
        saveCancelled: false,
        tileError: "",
        tileDelay: 0,
        tileCompleted: 0,
        appVersion: "0.1.0",
        updateResult: { currentVersion: "0.1.0", status: "unpublished" },
        updateError: "",
        updateDelay: 0,
        linkError: "",
        mcpTools: [],
        mcpToolsError: "",
        snapshot,
        destroyed: false,
        features: [
          {
            id: "db-1",
            geometry: { type: "Point", coordinates: [116, 40] },
            properties: { name: "道路" },
            dbKey: [1],
            baseline: "baseline-1",
          },
        ],
        dropFiles: async (files, error = "") => {
          for (const [id, listener] of listeners)
            if (listener.event === "gis-files-dropped")
              await callbacks.get(listener.handler)?.({ event: listener.event, id, payload: {files, error: error || null} });
        },
        requestClose: async () => {
          for (const [id, listener] of listeners)
            if (listener.event === "tauri://close-requested")
              await callbacks.get(listener.handler)?.({
                event: listener.event,
                id,
                payload: {},
              });
        },
      };
      Object.assign(window, {
        isTauri: true,
        __ZG_TEST__: state,
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (_event: string, id: number) =>
            listeners.delete(id),
        },
        __TAURI_INTERNALS__: {
          metadata: {
            currentWindow: { label: "main" },
            currentWebview: { label: "main" },
          },
          transformCallback: (callback: (event: unknown) => unknown) => {
            const id = next++;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (
            command: string,
            args: Record<string, unknown> = {},
          ) => {
            state.calls.push({ command, args });
            if (command === "plugin:app|version") return state.appVersion;
            if (command === "open_project_link") {
              if (state.linkError) throw Error(state.linkError);
              return null;
            }
            if (command === "check_app_update") {
              const result = { ...state.updateResult };
              const failure = state.updateError;
              if (state.updateDelay)
                await new Promise<void>((resolve) => window.setTimeout(resolve, state.updateDelay));
              if (failure) throw Error(failure);
              return result;
            }
            if (command === "fetch_basemap_tile") {
              const failure = state.tileError;
              const delay = state.tileDelay;
              if (delay > 0)
                await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
              state.tileCompleted++;
              if (failure) throw Error(failure);
              const canvas = document.createElement("canvas");
              canvas.width = 256;
              canvas.height = 256;
              const context = canvas.getContext("2d")!;
              context.fillStyle = "#5479b6";
              context.fillRect(0, 0, 256, 256);
              context.fillStyle = "#9fc5a8";
              context.fillRect(0, 0, 64, 256);
              return canvas.toDataURL("image/png");
            }
            if (command === "gis_mcp_tool_catalog") {
              if (state.mcpToolsError) throw Error(state.mcpToolsError);
              return state.mcpTools;
            }
            if (command === "load_preferences") return localStorage.getItem("test.basemaps");
            if (command === "save_preferences") { localStorage.setItem("test.basemaps", String(args.content)); return null; }
            if (command === "gis_mcp_status" || command === "gis_mcp_set_enabled") {
              if (command === "gis_mcp_set_enabled") state.mcpEnabled = Boolean(args.enabled);
              return { enabled: state.mcpEnabled, endpoint: state.mcpEnabled ? "http://127.0.0.1:9999/mcp" : null, token: state.mcpEnabled ? "test-token" : null, authorizedPaths: state.mcpPaths };
            }
            if (command === "gis_mcp_audit") return [];
            if (command === "gis_results_drain") return state.analysisResults.splice(0);
            if (command === "gis_authorize_files" || command === "gis_authorize_directory") { state.mcpPaths = ["C:/owned-test/vector.geojson"]; return state.mcpPaths; }
            if (command === "gis_revoke_access") { state.mcpPaths = []; return null; }
            if (command === "agent_current") return null;
            if (command === "plugin:event|listen") {
              const id = next++;
              listeners.set(id, {
                event: String(args.event),
                handler: Number(args.handler),
              });
              return id;
            }
            if (command === "load_recovery") return state.snapshot;
            if (command === "open_files")
              return [
                {
                  name: "native.geojson",
                  sourceId: "test-open",
                  bytes: Array.from(
                    new TextEncoder().encode(
                      JSON.stringify({
                        type: "FeatureCollection",
                        features: [
                          {
                            type: "Feature",
                            geometry: { type: "Point", coordinates: [1, 2] },
                            properties: { name: "native" },
                          },
                        ],
                      }),
                    ),
                  ),
                },
              ];
            if (command === "save_recovery") {
              if (state.backupError) throw Error(state.backupError);
              state.snapshot = String(args.content);
              return null;
            }
            if (command === "save_file" || command === "export_shapefile") {
              if (state.saveError) throw Error(state.saveError);
              if (state.saveCancelled) return null;
              return {
                sourceId: "test-saved",
                name: String(args.suggestedName),
                path: "test-file",
              };
            }
            if (command === "connect_database") return "test-connection";
            if (command === "discover_layers")
              return [
                  {
                    schema: "public", table: "wkt_points", geometryColumn: "", geometryKind: "wkt", srid: 4326,
                    keyColumns: ["id"], columns: [{ name: "location", type: "text", nullable: true }],
                  },
                  {
                    schema: "public", table: "unassigned", geometryColumn: "geom", geometryKind: "geometry", srid: 0,
                    keyColumns: ["id"], columns: [],
                  },
                {
                  schema: "public",
                  table: "roads",
                  geometryColumn: "geom",
                  geometryKind: "geometry",
                  srid: 4326,
                  keyColumns: ["id"],
                  columns: [{ name: "id", type: "bigint", nullable: false }],
                },
                {
                  schema: "public",
                  table: "readonly",
                  geometryColumn: "geom",
                  geometryKind: "geometry",
                  srid: 4326,
                  keyColumns: [],
                  columns: [],
                },
              ];
            if (command === "query_layer") {
              if (state.queryError) throw Error(state.queryError);
              return {
                features: structuredClone(state.features),
                srid: 4326,
                truncated: false,
              };
            }
            if (command === "commit_changes") {
              if (state.commitError) throw Error(state.commitError);
              for (const change of args.changes as {
                kind: string;
                properties?: Record<string, unknown>;
                geometry?: GeoFeature["geometry"];
              }[])
                if (change.kind === "update")
                  state.features[0] = {
                    ...state.features[0],
                    properties: change.properties!,
                    geometry: change.geometry!,
                  };
              return null;
            }
            if (command === "plugin:window|destroy") {
              state.destroyed = true;
              return null;
            }
            return null;
          },
        },
      });
    },
    { snapshot },
  );
}
