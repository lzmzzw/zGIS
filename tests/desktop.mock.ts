import type { Page } from "@playwright/test";
import type { GeoFeature } from "../src/domain";
export interface DesktopTestState {
  calls: { command: string; args: Record<string, unknown> }[];
  commitError: string;
  queryError: string;
  backupError: string;
  saveError: string;
  saveCancelled: boolean;
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
        calls: [],
        commitError: "",
        queryError: "",
        backupError: "",
        saveError: "",
        saveCancelled: false,
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
            if (command === "save_file") {
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
