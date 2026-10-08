import type { Page } from "@playwright/test";
import type { GeoFeature } from "../src/domain";
import type { DatabaseSource, DatabaseCatalog } from "../src/bridge";
export interface DesktopTestState {
  dropFiles: (files: {name:string;bytes:number[];sourceId?:string}[], error?:string) => Promise<void>;
  mcpEnabled: boolean;
  mcpPaths: string[];
  analysisResults: { id: string; name: string; features: unknown[] }[];
  calls: { command: string; args: Record<string, unknown> }[];
  commitError: string;
  queryError: string;
  databaseSources: DatabaseSource[];
  mysqlSources: DatabaseSource[];
  sourceSaveError: string;
  databaseConnectError: string;
  catalogError: string;
  previewError: string;
  previewDelays: Record<string, number>;
  previewCompletions: string[];
  catalogs: Record<string, DatabaseCatalog>;
  storedDatabasePasswords: Record<string, string>;
  passwordLoadError: string;
  passwordSaveError: string;
  passwordDeleteError: string;
  backupError: string;
  analysisError: string;
  analysisDelay: number;
  analysisResult: unknown;
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
  initial: { databaseSources?: DatabaseSource[]; mysqlSources?: DatabaseSource[]; passwords?: Record<string,string> } = {},
) {
  await page.addInitScript(
    ({ snapshot, initial }) => {
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
        databaseSources: initial.databaseSources ?? [], mysqlSources: initial.mysqlSources ?? [], sourceSaveError: "", databaseConnectError: "", catalogError: "", previewError: "", previewDelays: {}, previewCompletions: [], catalogs: {}, storedDatabasePasswords: initial.passwords ?? {},
        passwordLoadError:"", passwordSaveError:"", passwordDeleteError:"",
        backupError: "",
        analysisError: "",
        analysisDelay: 0,
        analysisResult: null,
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
            if (command === "gis_run_analysis") {
              const failure = state.analysisError;
              const result = state.analysisResult;
              if (state.analysisDelay)
                await new Promise<void>((resolve) => window.setTimeout(resolve, state.analysisDelay));
              if (failure) throw Error(failure);
              if (result !== null) return structuredClone(result);
              if (args.operation === "layer_summary")
                return { featureCount: (args.source as unknown[]).length, geometryTypes: { Polygon: 1 }, fields: ["name"], bbox: [116, 40, 116.01, 40.01], crs: "EPSG:4326" };
              if (args.operation === "topology_check")
                return { featureCount: (args.source as unknown[]).length, valid: false, issues: [{ kind: "polygon_overlap", featureIndices: [0, 1] }], checks: ["geometry_validity", "exact_geometry_duplicates", "polygon_overlap"] };
              return { type: "FeatureCollection", features: structuredClone(args.source) };
            }
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
            if (command === "rename_source_file") {
              if (state.saveError) throw Error(state.saveError);
              return {sourceId: args.sourceId, name: String(args.newName).replace(/\.geojson$/i, "") + ".geojson", path: "test-renamed"};
            }
            if (command === "save_file" || command === "export_shapefile" || command === "save_shapefile_folder") {
              if (state.saveError) throw Error(state.saveError);
              if (state.saveCancelled) return null;
              return {
                sourceId: "test-saved",
                name: String(args.suggestedName),
                path: "test-file",
              };
            }
            if (command === "load_database_sources" || command === "load_mysql_sources") return structuredClone(command === "load_database_sources" ? state.databaseSources : state.mysqlSources);
            if (command === "load_database_source_password") { if (state.passwordLoadError) throw Error(state.passwordLoadError); return state.storedDatabasePasswords[`${args.engine}/${args.sourceId}`] ?? null; }
            if (command === "save_database_source_password") { if (state.passwordSaveError) throw Error(state.passwordSaveError); state.storedDatabasePasswords[`${args.engine}/${args.sourceId}`] = String(args.password); return null; }
            if (command === "delete_database_source_password") { if (state.passwordDeleteError) throw Error(state.passwordDeleteError); delete state.storedDatabasePasswords[`${args.engine}/${args.sourceId}`]; return null; }
            if (command === "save_database_sources" || command === "save_mysql_sources") {
              if (state.sourceSaveError) throw Error(state.sourceSaveError);
              const sources = args.sources as DatabaseSource[];
              if (sources.some(source => "password" in source)) throw Error("Password must not persist");
              if (command === "save_database_sources") state.databaseSources = structuredClone(sources); else state.mysqlSources = structuredClone(sources);
              return null;
            }
            if (command === "connect_database" || command === "connect_mysql_database") {
              if (state.databaseConnectError) throw Error(state.databaseConnectError);
              return `${command}-${state.calls.filter(c => c.command === command).length}`;
            }
            if (command === "disconnect_database" || command === "disconnect_mysql_database") return null;
            if (command === "discover_database_tables" || command === "discover_mysql_tables") {
              if (state.catalogError) throw Error(state.catalogError);
              if (state.catalogs[String(args.connectionId)]) return structuredClone(state.catalogs[String(args.connectionId)]);
              const mysql = command === "discover_mysql_tables";
              const schema = mysql ? "test" : "public";
              const column = (name: string, type = "text", nullable = true) => ({name,type,nullable});
              const table = (name: string, keys: string[] = ["id"], geometries = [{name:"geom",srid:4326,type:"Point"}]) => ({schema,table:name,columns:[{...column("id","bigint",false),generated:true,hasDefault:true},column("name"),...geometries.map(g => column(g.name,"geometry"))],keyColumns:keys,geometryColumns:geometries});
              return {schemas:mysql ? [] : ["public","archive","empty"],tables:[table("roads"),table("readonly",[]),table("unassigned",["id"],[{name:"geom",srid:0,type:"Geometry"}]),table("dual_geom",["id"],[{name:"geom",srid:4326,type:"Point"},{name:"boundary",srid:4490,type:"MultiPolygon"}]),{schema,table:"counts",columns:[column("id","bigint",false),column("amount","numeric",false)],keyColumns:["id"],geometryColumns:[]},{...table("wkt_points",["id"],[]),columns:[column("id","bigint",false),column("location")]},...(!mysql ? [{...table("historic_roads"),schema:"archive"}] : [])]};
            }
            if (command === "preview_database_table" || command === "preview_mysql_table") {
              const error = state.previewError;
              const table = String(args.table);
              const delay = state.previewDelays[table] ?? 0;
              if (delay) await new Promise<void>(resolve => window.setTimeout(resolve,delay));
              state.previewCompletions.push(table);
              if (error) throw Error(error);
              return {columns:[{name:"id",type:"bigint",nullable:false},{name:"name",type:"text",nullable:true}],rows:Array.from({length:Number(args.limit)},(_,i) => ["9007199254740993",i ? null : `${args.connectionId}/${table}`]),truncated:true};
            }
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
            if (command === "query_layer" || command === "query_mysql_geometry") {
              if (state.queryError) throw Error(state.queryError);
              return {
                features: structuredClone(state.features),
                columns: [{ name: "id", type: "bigint", nullable: false }, ...Object.keys(state.features[0]?.properties ?? {}).map(name => ({ name, type: "varchar", nullable: true }))],
                srid: 4326,
                truncated: false,
              };
            }
            if (command === "commit_changes" || command === "commit_mysql_changes") {
              if (state.commitError) throw Error(state.commitError);
              for (const change of (args.schemaChanges ?? []) as {kind:string;name:string;newName?:string}[]) {
                state.features = state.features.map(feature => {
                  const properties = {...feature.properties};
                  if (change.kind === "add") properties[change.name] = "";
                  if (change.kind === "rename") { properties[change.newName!] = properties[change.name]; delete properties[change.name]; }
                  if (change.kind === "delete") delete properties[change.name];
                  return {...feature, properties};
                });
              }
              for (const change of args.changes as {
                kind: string;
                properties?: Record<string, unknown>;
                geometry?: GeoFeature["geometry"];
                dbKey?: GeoFeature["dbKey"];
              }[])
                if (change.kind === "update") {
                  const index = state.features.findIndex(feature => JSON.stringify(feature.dbKey) === JSON.stringify(change.dbKey));
                  state.features[index >= 0 ? index : 0] = {
                    ...state.features[index >= 0 ? index : 0],
                    properties: change.properties!,
                    geometry: change.geometry!,
                  };
                } else if (change.kind === "insert") {
                  const id = `db-inserted-${state.features.length + 1}`;
                  state.features.push({id, geometry:change.geometry ?? null, properties:change.properties ?? {}, dbKey:[id], baseline:`baseline-${id}`});
                } else if (change.kind === "delete") {
                  state.features = state.features.filter(feature => JSON.stringify(feature.dbKey) !== JSON.stringify(change.dbKey));
                }
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
    { snapshot, initial },
  );
}

export async function openDatabaseManager(page: Page, engine: "PostGIS" | "Mysql" = "PostGIS") {
  await page.locator(".app-header summary").filter({ hasText: /^数据$/ }).click();
  await page.getByRole("button", {name:`${engine} 数据源`,exact:true}).filter({visible:true}).click();
}
export async function addTestSource(page: Page, name = "测试数据源", engine: "PostGIS" | "Mysql" = "PostGIS") {
  await page.getByRole("button",{name:"新增数据源",exact:true}).filter({visible:true}).click();
  const dialog = page.getByRole("dialog",{name:`新增 ${engine} 数据源`,exact:true});
  await dialog.getByLabel("数据源名称",{exact:true}).fill(name);
  await dialog.getByLabel("主机",{exact:true}).fill("test.invalid");
  await dialog.getByLabel("数据库",{exact:true}).fill("test");
  await dialog.getByLabel("用户名",{exact:true}).fill("tester");
  await dialog.getByLabel("密码",{exact:true}).fill("test-only-password");
  await dialog.getByRole("button",{name:"添加并连接",exact:true}).click();
}
export async function loadDatabaseTestLayer(page: Page, table = "roads") {
  await openDatabaseManager(page);
  await addTestSource(page);
  const manager = page.getByRole("region",{name:"PostGIS 数据源管理",exact:true});
  if (table === "wkt_points") await manager.getByRole("button",{name:"全部表",exact:true}).click();
  await manager.locator(".pg-table").filter({hasText:new RegExp(`^${table}(普通表)?$`)}).click();
  await manager.getByRole("button",{name:table === "wkt_points" ? "从 WKT 列加载" : "添加到地图",exact:true}).click();
}
