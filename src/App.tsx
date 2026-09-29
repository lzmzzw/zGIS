import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FolderOpen,
  Save,
  Download,
  Undo2,
  Redo2,
  MousePointer2,
  Pencil,
  MapPin,
  Route,
  Pentagon,
  Trash2,
  LocateFixed,
  Database,
  Layers,
  Eye,
  EyeOff,
  LockKeyhole,
  Table2,
  Magnet,
  ChevronDown,
  Plus,
  X,
  Settings2,
  Check,
  LoaderCircle,
  FileJson,
  RotateCcw,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import WKT from "ol/format/WKT";
import GeoJSON from "ol/format/GeoJSON";
import MapView, { type Tool } from "./MapView";
import {
  createDemoLayer,
  exportGeoJSON,
  exportCsv,
  cloneFeatures,
  validateGeometry,
  geometryToWkt,
  makeLayer,
  parseProperties,
} from "./domain";
import type { DocumentLayer, GeoFeature, ImportOptions } from "./domain";
import { parseInWorker, cancelParsing } from "./workers";
import {
  api,
  desktop,
  download,
  type InputFile,
  type DbLayer,
  type DbConnection,
} from "./bridge";

const tools: { value: Tool; label: string; icon: typeof Pencil }[] = [
  { value: "select", label: "选择", icon: MousePointer2 },
  { value: "modify", label: "编辑顶点", icon: Pencil },
  { value: "Point", label: "新增点", icon: MapPin },
  { value: "LineString", label: "新增线", icon: Route },
  { value: "Polygon", label: "新增面", icon: Pentagon },
];
const stringify = (value: unknown) =>
  typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value ?? "");
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const ErrorContext = createContext("");
function IconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const error = useContext(ErrorContext);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const returnTarget =
      previous?.closest(".header-menu")?.querySelector("summary") ?? previous;
    ref.current?.showModal();
    const dialog = ref.current;
    return () => {
      dialog?.close();
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, []);
  return (
    <dialog
      className="modal"
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <IconButton label="关闭" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
interface History {
  past: GeoFeature[][];
  future: GeoFeature[][];
}
function HeaderMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node))
        ref.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  return (
    <details
      ref={ref}
      className="header-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          ref.current?.removeAttribute("open");
          ref.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary>{label}</summary>
      <div
        className="menu-items"
        onClick={(event) => {
          if ((event.target as Element).closest("button:not(:disabled)"))
            ref.current?.removeAttribute("open");
        }}
      >
        {children}
      </div>
    </details>
  );
}
export default function App() {
  const [layers, setLayers] = useState<DocumentLayer[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [tool, setTool] = useState<Tool>("select");
  const [basemap, setBasemap] = useState("osm");
  const [tdtKey, setTdtKey] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("zgis.theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [settingCategory, setSettingCategory] = useState<"appearance" | "map">(
    "appearance",
  );
  const [annotations, setAnnotations] = useState(true);
  const [snapping, setSnapping] = useState(true);
  const [layersOpen, setLayersOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"layer" | "feature">(
    "layer",
  );
  const [propertyDraft, setPropertyDraft] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [tableHeight, setTableHeight] = useState(250);
  const [featureFitNonce, setFeatureFitNonce] = useState(0);
  const [finishNonce, setFinishNonce] = useState(0);
  const [nodeCount, setNodeCount] = useState(0);
  const [fitNonce, setFitNonce] = useState(0);
  const [position, setPosition] = useState<number[]>([104, 34]);
  const [bounds, setBounds] = useState<number[]>([-180, -85, 180, 85]);
  const [dbUseViewport, setDbUseViewport] = useState(false);
  const dbBounds = useRef(new Map<string, number[]>());
  const [status, setStatus] = useState("就绪");
  const [busy, setBusy] = useState(false);
  const [uncertainDocs, setUncertainDocs] = useState(new Set<string>());
  const [error, setError] = useState("");
  const [modal, setModal] = useState<
    | "import"
    | "export"
    | "database"
    | "settings"
    | "close"
    | "recovery"
    | "quit"
    | "json"
    | "wkt"
    | "field"
    | "delete"
    | null
  >(null);
  const [pendingFiles, setPendingFiles] = useState<InputFile[]>([]);
  const [importOptions, setImportOptions] = useState<ImportOptions>({
    crs: "EPSG:4326",
    encoding: "utf-8",
  });
  const [exportMode, setExportMode] = useState("geojson");
  const [exportCrs, setExportCrs] = useState("EPSG:4326");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [tableOpen, setTableOpen] = useState(false);
  const [propertyText, setPropertyText] = useState("{}");
  const [wktText, setWktText] = useState("");
  const [newField, setNewField] = useState("");
  const [recovery, setRecovery] = useState<DocumentLayer[] | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(!desktop);
  const histories = useRef(new Map<string, History>());
  const [, refreshHistory] = useState(0);
  const dbBaselines = useRef(new Map<string, GeoFeature[]>());
  const input = useRef<HTMLInputElement>(null);
  const currentLayers = useRef(layers);
  currentLayers.current = layers;
  const active = layers.find((layer) => layer.id === activeId);
  const selected = active?.features.find(
    (feature) => feature.id === selectedId,
  );
  const [connection, setConnection] = useState<DbConnection>({
    host: "localhost",
    port: 5432,
    database: "",
    user: "",
    password: "",
    sslMode: "require",
  });
  const [connectionId, setConnectionId] = useState("");
  const [dbLayers, setDbLayers] = useState<DbLayer[]>([]);
  const [dbIndex, setDbIndex] = useState(0);
  const [dbWktColumn, setDbWktColumn] = useState("");
  const [dbSrid, setDbSrid] = useState(4326);
  const [dbLimit, setDbLimit] = useState(10000);
  const [targetSchema, setTargetSchema] = useState("public");
  const [targetTable, setTargetTable] = useState("");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("zgis.theme", theme);
    } catch {
      /* Theme remains usable when storage is unavailable. */
    }
  }, [theme]);
  useEffect(() => {
    setPropertyDraft(null);
  }, [activeId, selectedId]);
  function openModal(value: typeof modal) {
    setError("");
    setModal(value);
  }
  function selectFeature(id?: string) {
    setSelectedId(id);
    if (id) {
      setInspectorOpen(true);
      setInspectorTab("feature");
    }
  }
  function openFiles() {
    if (desktop) void task(async () => acceptFiles(await api.open()));
    else input.current?.click();
  }
  function changeBasemap(value: string) {
    if (value.startsWith("tdt") && !tdtKey) {
      setSettingCategory("map");
      openModal("settings");
      return;
    }
    setBasemap(value);
  }
  useEffect(() => {
    if (!desktop) return;
    api
      .recover()
      .then((raw) => {
        if (raw) {
          const data = JSON.parse(raw);
          if (Array.isArray(data) && data.some((l: DocumentLayer) => l.dirty)) {
            setRecovery(data);
            setModal("recovery");
          }
        }
      })
      .catch(() => {})
      .finally(() => setRecoveryReady(true));
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        if (currentLayers.current.some((l) => l.dirty)) {
          setModal("quit");
        } else {
          api
            .backup("[]")
            .then(() => getCurrentWindow().destroy())
            .catch((e) => {
              setError(errorText(e));
              setModal("quit");
            });
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (!desktop || !recoveryReady || recovery) return;
    const timer = setTimeout(() => {
      const safe = layers.map((l) => ({
        ...l,
        db: undefined,
        sourceId: undefined,
        sourceKind: l.sourceKind === "postgis" ? "geojson" : l.sourceKind,
      }));
      api
        .backup(JSON.stringify(safe))
        .catch(() => setStatus("恢复副本保存失败"));
    }, 1500);
    return () => clearTimeout(timer);
  }, [layers, recoveryReady, recovery]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (currentLayers.current.some((l) => l.dirty)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
  useEffect(() => {
    setPage(0);
    setSearch("");
    setSelectedId(undefined);
    setTool("select");
  }, [activeId]);
  useEffect(() => {
    setPropertyText(JSON.stringify(selected?.properties ?? {}, null, 2));
    setWktText(selected?.geometry ? geometryToWkt(selected.geometry) : "");
  }, [selected]);
  async function task(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
      setStatus("操作失败");
    } finally {
      setBusy(false);
    }
  }
  function addLayers(imported: DocumentLayer[]) {
    setLayers((old) => [...old, ...imported]);
    setActiveId(imported[0]?.id);
    setFitNonce((n) => n + 1);
    setStatus(
      `已载入 ${imported.reduce((n, l) => n + l.features.length, 0)} 个要素`,
    );
  }
  async function importSelected(files: InputFile[], options?: ImportOptions) {
    await task(async () => {
      setStatus("解析中");
      const result = await parseInWorker(files, options);
      addLayers(result);
      setPendingFiles([]);
      setModal(null);
    });
  }
  async function acceptFiles(files: InputFile[]) {
    if (!files.length) return;
    if (files.some((f) => /\.csv$/i.test(f.name))) {
      setPendingFiles(files);
      setModal("import");
    } else await importSelected(files);
  }
  function edit(features: GeoFeature[]) {
    if (!active || busy || !editable) return;
    const history = histories.current.get(active.id) ?? {
      past: [],
      future: [],
    };
    history.past.push(active.features);
    if (history.past.length > 30) history.past.shift();
    history.future = [];
    histories.current.set(active.id, history);
    setLayers((old) =>
      old.map((l) =>
        l.id === active.id ? { ...l, features, dirty: true } : l,
      ),
    );
    refreshHistory((n) => n + 1);
  }
  function onGeometry(feature: GeoFeature, insert: boolean) {
    const errors = validateGeometry(feature.geometry);
    if (errors.length) {
      setError(errors.join("；"));
      return;
    }
    if (!active) return;
    edit(
      insert
        ? [...active.features, feature]
        : active.features.map((f) =>
            f.id === feature.id ? { ...f, geometry: feature.geometry } : f,
          ),
    );
    setSelectedId(feature.id);
    if (insert) setTool("select");
  }
  function history(direction: "undo" | "redo") {
    if (!active || busy || !editable) return;
    const h = histories.current.get(active.id);
    if (!h) return;
    const from = direction === "undo" ? h.past : h.future;
    const to = direction === "undo" ? h.future : h.past;
    const next = from.pop();
    if (next) {
      to.push(active.features);
      setLayers((old) =>
        old.map((l) =>
          l.id === active.id ? { ...l, features: next, dirty: true } : l,
        ),
      );
      refreshHistory((n) => n + 1);
    }
  }
  function applyProperties() {
    if (!selected || !active || !editable || busy) return;
    try {
      const value: unknown = parseProperties(propertyText);
      if (!value || Array.isArray(value) || typeof value !== "object")
        throw new Error("属性必须是 JSON 对象");
      edit(
        active.features.map((f) =>
          f.id === selected.id
            ? { ...f, properties: value as Record<string, unknown> }
            : f,
        ),
      );
      setStatus("属性已更新");
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  function applyWkt() {
    if (!selected || !active || !editable || busy) return;
    try {
      const geom = wktText.trim() ? new WKT().readGeometry(wktText) : null;
      const json = geom ? new GeoJSON().writeGeometryObject(geom) : null;
      const errors = validateGeometry(json);
      if (errors.length) throw new Error(errors.join("；"));
      edit(
        active.features.map((f) =>
          f.id === selected.id ? { ...f, geometry: json } : f,
        ),
      );
      setStatus("几何已更新");
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function save(asNew = false) {
    if (!active) return;
    if (active.sourceKind === "postgis") {
      await commit();
      return;
    }
    if (active.sourceKind === "shp") {
      setModal("export");
      return;
    }
    await task(async () => {
      const content =
        active.sourceKind === "csv"
          ? exportCsv(active.features, {
              ...active.csvConfig,
              mode: active.csvConfig?.wktColumn ? "wkt" : "xy",
              crs: active.originalCrs,
            })
          : exportGeoJSON(active.features);
      if (desktop) {
        const result = await api.save(
          content,
          /\.(geojson|json|csv)$/i.test(active.name)
            ? active.name
            : active.name + ".geojson",
          asNew ? undefined : active.sourceId,
          !asNew && Boolean(active.sourceId),
        );
        if (!result) {
          setStatus("已取消保存");
          return;
        }
        setLayers((old) =>
          old.map((l) =>
            l.id === active.id
              ? {
                  ...l,
                  dirty: false,
                  sourceId: result.sourceId,
                  name: result.name,
                }
              : l,
          ),
        );
      } else {
        download(content, active.name);
        setLayers((old) =>
          old.map((l) => (l.id === active.id ? { ...l, dirty: false } : l)),
        );
      }
      setStatus("保存完成");
    });
  }
  async function doExport() {
    if (!active) return;
    await task(async () => {
      if (exportMode === "postgis") {
        if (!connectionId || !targetTable)
          throw new Error("请先连接数据库并填写目标表名");
        await api.exportDb(
          connectionId,
          targetSchema,
          targetTable,
          active.features,
        );
        setStatus("已创建目标表并写入");
      } else {
        const content =
          exportMode === "geojson"
            ? exportGeoJSON(active.features)
            : exportCsv(active.features, {
                ...active.csvConfig,
                mode: exportMode === "xy" ? "xy" : "wkt",
                crs: exportCrs,
              });
        const name =
          active.name.replace(/\.[^.]+$/, "") +
          (exportMode === "geojson" ? ".geojson" : ".csv");
        if (desktop) {
          const result = await api.save(content, name);
          if (!result) {
            setStatus("已取消导出");
            return;
          }
        } else download(content, name);
        setStatus("导出完成");
      }
      setModal(null);
    });
  }
  async function connect() {
    await task(async () => {
      const id = await api.connect(connection);
      setConnectionId(id);
      setConnection((c) => ({ ...c, password: "" }));
      setDbLayers(await api.discover(id));
      setDbIndex(0);
      setStatus("数据库已连接");
    });
  }
  async function loadDatabase() {
    await task(async () => {
      const info = dbLayers[dbIndex];
      if (!info) throw new Error("请选择数据表");
      const layer = {
        ...info,
        geometryColumn:
          info.geometryKind === "wkt"
            ? dbWktColumn || info.geometryColumn
            : info.geometryColumn,
        geometryKind: info.geometryColumn
          ? info.geometryKind
          : ("wkt" as const),
        srid: info.geometryKind === "wkt" ? dbSrid : info.srid,
      };
      if (!layer.geometryColumn) throw new Error("请选择 WKT 文本列");
      const bbox =
        dbUseViewport && layer.geometryKind === "geometry" ? bounds : undefined;
      const result = await api.query(connectionId, layer, dbLimit, bbox);
      result.features.forEach((f) => {
        const problems = validateGeometry(f.geometry);
        if (problems.length) throw new Error(problems.join("；"));
      });
      const doc = makeLayer(
        `${layer.schema}.${layer.table}`,
        result.features,
        "postgis",
        {
          db: { connectionId, ...layer },
          warnings: result.truncated
            ? [`已达到 ${dbLimit} 条读取上限，当前不是全表`]
            : [],
        },
      );
      dbBaselines.current.set(doc.id, cloneFeatures(doc.features));
      if (bbox) dbBounds.current.set(doc.id, bbox);
      addLayers([doc]);
      setModal(null);
    });
  }
  async function commit() {
    if (!active?.db || uncertainDocs.has(active.id)) return;
    await task(async () => {
      const before = dbBaselines.current.get(active.id) ?? [];
      const oldMap = new Map(before.map((f) => [f.id, f]));
      const nowMap = new Map(active.features.map((f) => [f.id, f]));
      const changes: unknown[] = [];
      for (const f of active.features) {
        const old = oldMap.get(f.id);
        if (!old)
          changes.push({
            kind: "insert",
            geometry: f.geometry,
            properties: f.properties,
          });
        else if (
          JSON.stringify(old.geometry) !== JSON.stringify(f.geometry) ||
          JSON.stringify(old.properties) !== JSON.stringify(f.properties)
        )
          changes.push({
            kind: "update",
            dbKey: old.dbKey,
            baseline: old.baseline,
            geometry: f.geometry,
            properties: f.properties,
            geometryChanged:
              JSON.stringify(old.geometry) !== JSON.stringify(f.geometry),
          });
      }
      for (const f of before)
        if (!nowMap.has(f.id))
          changes.push({
            kind: "delete",
            dbKey: f.dbKey,
            baseline: f.baseline,
          });
      if (!changes.length) {
        setStatus("没有待提交修改");
        return;
      }
      const blockRetry = (message: string) => {
        setUncertainDocs((old) => new Set([...old, active.id]));
        setLayers((old) =>
          old.map((l) =>
            l.id === active.id
              ? { ...l, warnings: [...(l.warnings ?? []), message] }
              : l,
          ),
        );
      };
      try {
        await api.commit(active.db!.connectionId, active.db!, changes);
      } catch (e) {
        if (errorText(e).includes("提交结果待核对"))
          blockRetry(
            "提交结果待核对，请重新载入来源后核对数据；当前副本禁止重复提交。",
          );
        throw e;
      }
      const result = await api
        .query(
          active.db!.connectionId,
          active.db!,
          dbLimit,
          dbBounds.current.get(active.id),
        )
        .catch((e) => {
          blockRetry(
            "提交已成功，但重读失败。请重新载入来源；当前副本禁止重复提交。",
          );
          throw new Error("提交已成功，重读失败：" + errorText(e));
        });
      dbBaselines.current.set(active.id, cloneFeatures(result.features));
      histories.current.delete(active.id);
      setLayers((old) =>
        old.map((l) =>
          l.id === active.id
            ? { ...l, features: result.features, dirty: false }
            : l,
        ),
      );
      setStatus(`已提交 ${changes.length} 条变更`);
    });
  }
  async function closeLayer() {
    if (!active) return;
    await task(async () => {
      const next = layers.filter((l) => l.id !== active.id);
      if (desktop)
        await api.backup(
          JSON.stringify(
            next.map((l) => ({
              ...l,
              db: undefined,
              sourceId: undefined,
              sourceKind: l.sourceKind === "postgis" ? "geojson" : l.sourceKind,
            })),
          ),
        );
      setLayers(next);
      histories.current.delete(active.id);
      dbBaselines.current.delete(active.id);
      dbBounds.current.delete(active.id);
      setActiveId(next[0]?.id);
      setModal(null);
    });
  }
  const fields = [
    ...new Set(
      active?.features.flatMap((f) => Object.keys(f.properties)) ?? [],
    ),
  ];
  const filtered =
    active?.features.filter(
      (f) =>
        !search ||
        Object.values(f.properties).some((v) =>
          stringify(v).toLowerCase().includes(search.toLowerCase()),
        ),
    ) ?? [];
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const shown = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const h = active ? histories.current.get(active.id) : undefined;
  const editable =
    Boolean(active) &&
    active?.sourceKind !== "shp" &&
    (active?.sourceKind !== "postgis" ||
      (Boolean(active.db?.keyColumns.length) &&
        !uncertainDocs.has(active.id!)));
  return (
    <ErrorContext.Provider value={error}>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <img className="brand-mark" src="/zgis.svg" alt="" />
            <strong>zGIS</strong>
          </div>
          <nav className="header-menus" aria-label="主菜单">
            <HeaderMenu label="文件">
              <button onClick={openFiles} disabled={busy}>
                <FolderOpen size={16} />
                打开文件…
              </button>
              <button
                onClick={() => void save()}
                disabled={
                  !active ||
                  busy ||
                  (active.sourceKind === "postgis" && !editable)
                }
              >
                <Save size={16} />
                {active?.sourceKind === "postgis" ? "提交修改" : "保存"}
              </button>
              <button
                onClick={() => void save(true)}
                disabled={!active || busy || active.sourceKind === "postgis"}
              >
                <Save size={16} />
                另存为…
              </button>
              <button
                disabled={!active || busy}
                onClick={() => openModal("export")}
              >
                <Download size={16} />
                导出 / 转换
              </button>
              <hr />
              <button
                disabled={!active || busy}
                onClick={() =>
                  active?.dirty ? openModal("close") : void closeLayer()
                }
              >
                <X size={16} />
                移除图层
              </button>
            </HeaderMenu>
            <HeaderMenu label="数据">
              <button onClick={openFiles} disabled={busy}>
                <FolderOpen size={16} />
                导入数据…
              </button>
              <button
                onClick={() => openModal("database")}
                disabled={!desktop || busy}
              >
                <Database size={16} />
                PostGIS 数据源…
              </button>
              <hr />
              <button
                onClick={() => addLayers([createDemoLayer()])}
                disabled={busy}
              >
                <Plus size={16} />
                城市示例
              </button>
            </HeaderMenu>
            <HeaderMenu label="视图">
              <button
                aria-pressed={layersOpen}
                onClick={() => setLayersOpen((v) => !v)}
              >
                <Layers size={16} />
                图层
              </button>
              <button
                aria-pressed={tableOpen}
                onClick={() => setTableOpen((v) => !v)}
              >
                <Table2 size={16} />
                属性表
              </button>
              <button
                aria-pressed={inspectorOpen}
                onClick={() => setInspectorOpen((v) => !v)}
              >
                <Settings2 size={16} />
                检查器
              </button>
              <hr />
              <button
                onClick={() => {
                  setSettingCategory("appearance");
                  openModal("settings");
                }}
              >
                <Settings2 size={16} />
                设置…
              </button>
            </HeaderMenu>
          </nav>
          <div className="toolbar" aria-label="地图工具">
            <div className="tool-group">
              {tools.map((item) => (
                <IconButton
                  key={item.value}
                  label={item.label}
                  disabled={
                    !active || (item.value !== "select" && !editable) || busy
                  }
                  active={tool === item.value}
                  onClick={() => setTool(item.value)}
                >
                  <item.icon size={18} />
                </IconButton>
              ))}
              <IconButton
                label="删除选中要素"
                disabled={!selected || !editable || busy}
                onClick={() => openModal("delete")}
              >
                <Trash2 size={18} />
              </IconButton>
            </div>
            <div className="tool-group">
              <IconButton
                label="撤销"
                disabled={!h?.past.length || !editable || busy}
                onClick={() => history("undo")}
              >
                <Undo2 size={18} />
              </IconButton>
              <IconButton
                label="重做"
                disabled={!h?.future.length || !editable || busy}
                onClick={() => history("redo")}
              >
                <Redo2 size={18} />
              </IconButton>
            </div>
            <IconButton
              label="捕捉当前图层顶点和边"
              active={snapping}
              disabled={!editable || busy}
              onClick={() => setSnapping((v) => !v)}
            >
              <Magnet size={17} />
            </IconButton>
            {tool !== "select" && (
              <div className="editing-tools">
                <span>{tools.find((item) => item.value === tool)?.label}</span>
                {tool !== "modify" && (
                  <IconButton
                    label="完成绘制"
                    disabled={
                      nodeCount <
                      (tool === "Polygon" ? 3 : tool === "LineString" ? 2 : 1)
                    }
                    onClick={() => setFinishNonce((n) => n + 1)}
                  >
                    <Check size={16} />
                  </IconButton>
                )}
                <IconButton
                  label={tool === "modify" ? "结束顶点编辑" : "取消绘制"}
                  onClick={() => setTool("select")}
                >
                  <X size={16} />
                </IconButton>
              </div>
            )}
          </div>
          <div className="document-title" title={active?.name}>
            {active?.name ?? ""}
            {active?.dirty && <span className="dirty-dot" title="未保存" />}
          </div>
          <div className="header-actions">
            <IconButton
              label="属性表"
              active={tableOpen}
              onClick={() => setTableOpen((v) => !v)}
            >
              <Table2 size={16} />
            </IconButton>
            <IconButton
              label="设置"
              onClick={() => {
                setSettingCategory("appearance");
                openModal("settings");
              }}
            >
              <Settings2 size={16} />
            </IconButton>
          </div>
        </header>
        <input
          ref={input}
          type="file"
          multiple
          accept=".json,.geojson,.csv,.shp,.dbf,.prj,.cpg,.shx,.zip"
          hidden
          onChange={async (e) => {
            const list = Array.from(e.target.files ?? []);
            const files = await Promise.all(
              list.map(async (f) => ({
                name: f.name,
                bytes: Array.from(new Uint8Array(await f.arrayBuffer())),
              })),
            );
            await acceptFiles(files);
            e.target.value = "";
          }}
        />
        <main
          className="workspace"
          data-layers={layersOpen}
          data-inspector={inspectorOpen}
        >
          <aside className="layers-panel" hidden={!layersOpen}>
            <div className="panel-heading">
              <span>图层</span>
              <span className="count">{layers.length}</span>
            </div>
            <div className="layer-list">
              {layers.map((l) => (
                <div
                  key={l.id}
                  className={`layer-row ${l.id === activeId ? "selected" : ""}`}
                  onDoubleClick={() => {
                    setActiveId(l.id);
                    setFitNonce((n) => n + 1);
                  }}
                >
                  <IconButton
                    label={l.visible ? "隐藏图层" : "显示图层"}
                    onClick={() =>
                      setLayers((old) =>
                        old.map((item) =>
                          item.id === l.id
                            ? { ...item, visible: !item.visible }
                            : item,
                        ),
                      )
                    }
                  >
                    {l.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                  </IconButton>
                  <span
                    className="layer-swatch"
                    style={{ background: l.color }}
                  />
                  <button
                    className="layer-text"
                    onClick={() => {
                      setActiveId(l.id);
                      setInspectorOpen(true);
                      setInspectorTab("layer");
                    }}
                  >
                    <strong title={l.name}>
                      {l.name}
                      {l.dirty ? " *" : ""}
                    </strong>
                  </button>
                  {(l.sourceKind === "shp" ||
                    (l.sourceKind === "postgis" &&
                      (!l.db?.keyColumns.length ||
                        uncertainDocs.has(l.id)))) && (
                    <LockKeyhole size={13} aria-label="只读图层" />
                  )}
                </div>
              ))}
            </div>
            {!layers.length && (
              <div className="empty-source">
                <button onClick={openFiles} disabled={busy}>
                  <FolderOpen size={16} />
                  打开文件…
                </button>
                <button
                  onClick={() => openModal("database")}
                  disabled={!desktop || busy}
                >
                  <Database size={16} />
                  PostGIS 数据源…
                </button>
                <button
                  onClick={() => addLayers([createDemoLayer()])}
                  disabled={busy}
                >
                  <Plus size={16} />
                  城市示例
                </button>
              </div>
            )}
            <div className="layer-footer">
              <button className="quiet" onClick={openFiles} disabled={busy}>
                <FolderOpen size={16} />
                打开文件
              </button>
            </div>
            <div className="basemap-picker">
              <label htmlFor="basemap">底图</label>
              <select
                id="basemap"
                aria-label="底图"
                value={basemap}
                onChange={(e) => changeBasemap(e.target.value)}
              >
                <option value="osm">OpenStreetMap</option>
                <option value="tdt-vec">天地图 · 矢量</option>
                <option value="tdt-img">天地图 · 影像</option>
                <option value="none">无底图</option>
              </select>
              <IconButton
                label="底图设置"
                onClick={() => {
                  setSettingCategory("map");
                  openModal("settings");
                }}
              >
                <Settings2 size={15} />
              </IconButton>
            </div>
          </aside>
          <section className="map-column">
            <div className="map-container">
              <MapView
                disabled={busy}
                editable={editable}
                theme={theme}
                annotations={annotations}
                snapping={snapping}
                finishNonce={finishNonce}
                featureFitNonce={featureFitNonce}
                onNodeCount={setNodeCount}
                layers={layers}
                activeId={activeId}
                selectedId={selectedId}
                tool={tool}
                basemap={basemap}
                tdtKey={tdtKey}
                fitNonce={fitNonce}
                onSelect={selectFeature}
                onEdit={onGeometry}
                onPosition={setPosition}
                onBounds={setBounds}
              />
              <div className="map-fit">
                <IconButton
                  label="缩放至图层"
                  disabled={!active}
                  onClick={() => setFitNonce((n) => n + 1)}
                >
                  <LocateFixed size={16} />
                </IconButton>
              </div>
            </div>
            <section
              className={`attribute-panel ${tableOpen ? "" : "collapsed"}`}
              hidden={!tableOpen}
              style={{ height: tableHeight }}
            >
              <div
                className="table-resizer"
                role="separator"
                aria-label="调整属性表高度"
                aria-orientation="horizontal"
                aria-valuenow={tableHeight}
                aria-valuemin={140}
                aria-valuemax={600}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    setTableHeight((h) =>
                      Math.max(
                        140,
                        Math.min(600, h + (e.key === "ArrowUp" ? 20 : -20)),
                      ),
                    );
                  }
                }}
                onPointerDown={(e) => {
                  const target = e.currentTarget;
                  target.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const bottom =
                    e.currentTarget.parentElement!.getBoundingClientRect()
                      .bottom;
                  const available =
                    e.currentTarget
                      .closest(".map-column")!
                      .getBoundingClientRect().height - 180;
                  setTableHeight(
                    Math.max(140, Math.min(600, available, bottom - e.clientY)),
                  );
                }}
                onPointerUp={(e) =>
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }
              />
              <header>
                <button
                  className="quiet"
                  onClick={() => setTableOpen((v) => !v)}
                >
                  属性表{" "}
                  <span className="count">{active?.features.length ?? 0}</span>
                </button>
                {tableOpen && (
                  <>
                    <div className="search-field">
                      <Search size={14} />
                      <input
                        aria-label="搜索属性"
                        placeholder="搜索属性"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(0);
                        }}
                      />
                    </div>
                    <div className="pagination">
                      <IconButton
                        label="上一页"
                        disabled={page === 0}
                        onClick={() => setPage((n) => n - 1)}
                      >
                        <ChevronLeft size={16} />
                      </IconButton>
                      <span>
                        {page + 1} / {totalPages}
                      </span>
                      <IconButton
                        label="下一页"
                        disabled={page + 1 >= totalPages}
                        onClick={() => setPage((n) => n + 1)}
                      >
                        <ChevronRight size={16} />
                      </IconButton>
                    </div>
                  </>
                )}
                <IconButton
                  label="收起属性表"
                  onClick={() => setTableOpen(false)}
                >
                  <ChevronDown size={16} />
                </IconButton>
              </header>
              {tableOpen && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="index-cell">#</th>
                        <th>
                          几何{" "}
                          <button
                            className="quiet field-add"
                            aria-label="添加字段"
                            disabled={
                              !active ||
                              !editable ||
                              busy ||
                              active.sourceKind === "postgis"
                            }
                            onClick={() => openModal("field")}
                          >
                            <Plus size={13} />
                          </button>
                        </th>
                        {fields.map((field) => (
                          <th key={field} title={field}>
                            <HeaderMenu label={field}>
                              <span className="field-info">
                                {field} · {active?.features.length ?? 0} 条记录
                              </span>
                              <button
                                disabled={
                                  !editable ||
                                  busy ||
                                  active?.sourceKind === "postgis"
                                }
                                onClick={() => openModal("field")}
                              >
                                <Plus size={14} />
                                添加字段
                              </button>
                            </HeaderMenu>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((f, index) => (
                        <tr
                          key={f.id}
                          className={selectedId === f.id ? "selected" : ""}
                          onClick={() => selectFeature(f.id)}
                          onDoubleClick={() => {
                            selectFeature(f.id);
                            setFeatureFitNonce((n) => n + 1);
                          }}
                        >
                          <td className="index-cell">
                            {page * pageSize + index + 1}
                          </td>
                          <td>{f.geometry?.type ?? "空"}</td>
                          {fields.map((field) => (
                            <td
                              key={field}
                              title={stringify(f.properties[field])}
                            >
                              {stringify(f.properties[field])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!shown.length && (
                    <div className="table-empty">
                      {active ? "没有匹配记录" : "未载入图层"}
                    </div>
                  )}
                </div>
              )}
            </section>
          </section>
          <aside className="inspector" hidden={!inspectorOpen}>
            <div className="panel-heading">
              <span>{inspectorTab === "layer" ? "图层" : "要素"}</span>
              <IconButton
                label="关闭检查器"
                onClick={() => setInspectorOpen(false)}
              >
                <X size={16} />
              </IconButton>
            </div>
            <div className="inspector-tabs">
              <button
                className={inspectorTab === "layer" ? "active" : "quiet"}
                onClick={() => setInspectorTab("layer")}
              >
                图层
              </button>
              <button
                className={inspectorTab === "feature" ? "active" : "quiet"}
                onClick={() => setInspectorTab("feature")}
              >
                要素
              </button>
            </div>
            {inspectorTab === "layer" ? (
              active ? (
                <div className="inspector-body layer-details">
                  <h3>{active.name}</h3>
                  <span className="count">
                    {active.features.length.toLocaleString()} 个要素
                  </span>
                  <h4>样式</h4>
                  <label>
                    颜色
                    <input
                      type="color"
                      value={active.color}
                      aria-label={`${active.name}颜色`}
                      onChange={(e) =>
                        setLayers((old) =>
                          old.map((l) =>
                            l.id === active.id
                              ? { ...l, color: e.target.value }
                              : l,
                          ),
                        )
                      }
                    />
                  </label>
                  <details open>
                    <summary>来源详情</summary>
                    <dl>
                      <dt>格式</dt>
                      <dd>
                        {active.sourceKind === "shp"
                          ? "Shapefile · 只读"
                          : active.sourceKind}
                      </dd>
                      <dt>来源 CRS</dt>
                      <dd>{active.originalCrs}</dd>
                      <dt>工作坐标</dt>
                      <dd>WGS84 · EPSG:4326</dd>
                      <dt>要素数量</dt>
                      <dd>{active.features.length.toLocaleString()}</dd>
                    </dl>
                    {!editable && (
                      <p className="form-note">
                        {active.sourceKind === "shp"
                          ? "Shapefile 来源只读，可调整样式、查看或导出。"
                          : "当前数据库副本不可编辑，请核对主键及提交状态。"}
                      </p>
                    )}
                    {active.warnings?.map((warning, index) => (
                      <p className="warning" key={index}>
                        {warning}
                      </p>
                    ))}
                  </details>
                </div>
              ) : (
                <div className="inspector-empty">未载入图层</div>
              )
            ) : selected ? (
              <div className="inspector-body">
                <div className="feature-kind">
                  {selected.geometry?.type ?? "空几何"}
                </div>
                <div className="property-fields">
                  {Object.entries(selected.properties).map(([key, value]) => (
                    <label key={key}>
                      <span title={key}>{key}</span>
                      {typeof value === "boolean" ? (
                        <input
                          type="checkbox"
                          aria-label={`属性 ${key}`}
                          checked={Boolean(propertyDraft?.[key] ?? value)}
                          disabled={!propertyDraft || !editable || busy}
                          onChange={(e) =>
                            setPropertyDraft((draft) =>
                              draft
                                ? { ...draft, [key]: e.target.checked }
                                : null,
                            )
                          }
                        />
                      ) : (
                        <input
                          aria-label={`属性 ${key}`}
                          value={stringify(propertyDraft?.[key] ?? value)}
                          disabled={
                            !propertyDraft ||
                            !editable ||
                            busy ||
                            (typeof value === "object" && value !== null)
                          }
                          onChange={(e) => {
                            if (!active) return;
                            const inputValue = e.target.value;
                            if (
                              typeof value === "number" &&
                              (inputValue === "" ||
                                !Number.isFinite(Number(inputValue)))
                            )
                              return;
                            setPropertyDraft((draft) =>
                              draft
                                ? {
                                    ...draft,
                                    [key]:
                                      typeof value === "number"
                                        ? Number(inputValue)
                                        : inputValue,
                                  }
                                : null,
                            );
                          }}
                        />
                      )}
                    </label>
                  ))}
                </div>
                <div className="property-actions">
                  {propertyDraft ? (
                    <>
                      <button
                        disabled={!editable || busy}
                        onClick={() => {
                          edit(
                            active!.features.map((f) =>
                              f.id === selected.id
                                ? { ...f, properties: propertyDraft }
                                : f,
                            ),
                          );
                          setPropertyDraft(null);
                          setStatus("属性已更新");
                        }}
                      >
                        <Check size={15} />
                        应用
                      </button>
                      <button onClick={() => setPropertyDraft(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      className="quiet"
                      disabled={!editable || busy}
                      onClick={() =>
                        setPropertyDraft({ ...selected.properties })
                      }
                    >
                      <Pencil size={15} />
                      编辑
                    </button>
                  )}
                </div>
                {!editable && (
                  <p className="form-note">
                    <LockKeyhole size={13} /> 当前来源只读
                  </p>
                )}
                <details open>
                  <summary>高级编辑</summary>
                  <button className="quiet" onClick={() => openModal("json")}>
                    <FileJson size={15} />
                    JSON 属性…
                  </button>
                  <button className="quiet" onClick={() => openModal("wkt")}>
                    WKT 几何…
                  </button>
                </details>
              </div>
            ) : (
              <div className="inspector-empty">
                <MousePointer2 size={24} />
                <span>未选中要素</span>
              </div>
            )}
          </aside>
        </main>
        {error && !modal && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <IconButton label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        <footer className="statusbar">
          <span>
            {busy ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <span className="status-dot" />
            )}
            {status}
          </span>
          {busy && (
            <button
              onClick={() => {
                cancelParsing();
                setStatus("已取消解析");
              }}
            >
              取消解析
            </button>
          )}
          <span>
            {active?.features.length.toLocaleString() ?? 0} 要素
            {selected ? " · 已选 1" : ""}
          </span>
          {tool !== "select" && tool !== "modify" && (
            <span>{nodeCount} 个节点</span>
          )}
          <div />
          <span>
            {position[0].toFixed(5)}, {position[1].toFixed(5)}
          </span>
          <span>WGS84 · 视图 EPSG:3857</span>
          <span>{desktop ? "Windows 桌面" : "浏览器预览"}</span>
        </footer>
        {modal === "import" && (
          <Modal title="CSV 导入" onClose={() => setModal(null)}>
            <div className="form-grid">
              <label>
                文件<span>{pendingFiles.map((f) => f.name).join("、")}</span>
              </label>
              <label>
                编码
                <select
                  value={importOptions.encoding}
                  onChange={(e) =>
                    setImportOptions((o) => ({
                      ...o,
                      encoding: e.target.value,
                    }))
                  }
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="gb18030">GB18030 / GBK</option>
                </select>
              </label>
              <label>
                WKT 列
                <input
                  placeholder="自动识别 wkt / geometry / geom"
                  value={importOptions.wktColumn ?? ""}
                  onChange={(e) =>
                    setImportOptions((o) => ({
                      ...o,
                      wktColumn: e.target.value,
                    }))
                  }
                />
              </label>
              <div className="two-columns">
                <label>
                  X / 经度列
                  <input
                    placeholder="longitude / lon / x"
                    value={importOptions.xColumn ?? ""}
                    onChange={(e) =>
                      setImportOptions((o) => ({
                        ...o,
                        xColumn: e.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Y / 纬度列
                  <input
                    placeholder="latitude / lat / y"
                    value={importOptions.yColumn ?? ""}
                    onChange={(e) =>
                      setImportOptions((o) => ({
                        ...o,
                        yColumn: e.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <label>
                来源坐标系
                <select
                  value={importOptions.crs}
                  onChange={(e) =>
                    setImportOptions((o) => ({ ...o, crs: e.target.value }))
                  }
                >
                  <option>EPSG:4326</option>
                  <option>EPSG:3857</option>
                </select>
              </label>
              <div className="modal-actions">
                <button
                  disabled={busy}
                  onClick={() => importSelected(pendingFiles, importOptions)}
                >
                  <Check size={16} />
                  导入
                </button>
              </div>
            </div>
          </Modal>
        )}
        {modal === "export" && (
          <Modal title="导出 / 转换" onClose={() => setModal(null)}>
            <div className="form-grid">
              <label>
                输出格式
                <select
                  value={exportMode}
                  onChange={(e) => setExportMode(e.target.value)}
                >
                  <option value="geojson">GeoJSON</option>
                  <option value="wkt">CSV · WKT</option>
                  <option value="xy">CSV · 经纬度点</option>
                  {desktop && <option value="postgis">PostGIS · 新建表</option>}
                </select>
              </label>
              {exportMode !== "geojson" && exportMode !== "postgis" && (
                <label>
                  目标坐标系
                  <select
                    value={exportCrs}
                    onChange={(e) => setExportCrs(e.target.value)}
                  >
                    <option>EPSG:4326</option>
                    <option>EPSG:3857</option>
                  </select>
                </label>
              )}
              {exportMode === "postgis" && (
                <>
                  <label>
                    连接<span>{connectionId ? "已连接" : "尚未连接"}</span>
                  </label>
                  <label>
                    Schema
                    <input
                      value={targetSchema}
                      onChange={(e) => setTargetSchema(e.target.value)}
                    />
                  </label>
                  <label>
                    新表名
                    <input
                      value={targetTable}
                      onChange={(e) => setTargetTable(e.target.value)}
                    />
                  </label>
                </>
              )}
              <p className="form-note">
                {active?.features.length} 个要素 · {fields.length}{" "}
                个属性字段。CSV 嵌套属性将转为 JSON 文本；经纬度格式仅支持点。
              </p>
              <div className="modal-actions">
                <button disabled={busy} onClick={doExport}>
                  <Download size={16} />
                  导出
                </button>
              </div>
            </div>
          </Modal>
        )}
        {modal === "settings" && (
          <Modal title="设置" onClose={() => openModal(null)}>
            <div className="settings-layout">
              <nav aria-label="设置分类">
                <button
                  className={
                    settingCategory === "appearance" ? "active" : "quiet"
                  }
                  onClick={() => setSettingCategory("appearance")}
                >
                  外观
                </button>
                <button
                  className={settingCategory === "map" ? "active" : "quiet"}
                  onClick={() => setSettingCategory("map")}
                >
                  地图
                </button>
              </nav>
              <div className="form-grid settings-content">
                {settingCategory === "appearance" ? (
                  <label>
                    主题
                    <select
                      aria-label="主题"
                      value={theme}
                      onChange={(e) =>
                        setTheme(e.target.value as "light" | "dark")
                      }
                    >
                      <option value="dark">深色</option>
                      <option value="light">浅色</option>
                    </select>
                  </label>
                ) : (
                  <>
                    <label>
                      底图类型
                      <select
                        aria-label="底图类型"
                        value={basemap}
                        onChange={(e) => setBasemap(e.target.value)}
                      >
                        <option value="osm">OpenStreetMap</option>
                        <option value="tdt-vec">天地图 · 矢量</option>
                        <option value="tdt-img">天地图 · 影像</option>
                        <option value="none">无底图</option>
                      </select>
                    </label>
                    {basemap.startsWith("tdt") && (
                      <>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={annotations}
                            onChange={(e) => setAnnotations(e.target.checked)}
                          />
                          显示注记
                        </label>
                        <label>
                          天地图 tk
                          <input
                            aria-label="天地图 tk"
                            type="password"
                            value={tdtKey}
                            autoComplete="off"
                            onChange={(e) => setTdtKey(e.target.value)}
                          />
                        </label>
                        <p className="form-note">tk 仅在本次运行保留。</p>
                        {!tdtKey && (
                          <p className="warning">填写 tk 后可载入天地图。</p>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </Modal>
        )}
        {(modal === "json" || modal === "wkt") && selected && (
          <Modal
            title={modal === "json" ? "JSON 属性" : "WKT 几何"}
            onClose={() => openModal(null)}
          >
            <div className="editor-layout">
              <div>
                <label>
                  {modal === "json" ? "属性内容" : "WGS84 · EPSG:4326"}
                  <textarea
                    aria-label={modal === "json" ? "JSON 属性" : "WKT 几何"}
                    value={modal === "json" ? propertyText : wktText}
                    readOnly={!editable || busy}
                    onChange={(e) =>
                      modal === "json"
                        ? setPropertyText(e.target.value)
                        : setWktText(e.target.value)
                    }
                  />
                </label>
              </div>
              <aside>
                <h3>{modal === "json" ? "属性摘要" : "几何摘要"}</h3>
                <dl>
                  <dt>图层</dt>
                  <dd>{active?.name}</dd>
                  <dt>要素</dt>
                  <dd>{selected.id}</dd>
                  <dt>{modal === "json" ? "当前字段" : "当前类型"}</dt>
                  <dd>
                    {modal === "json"
                      ? Object.keys(selected.properties).length
                      : (selected.geometry?.type ?? "空几何")}
                  </dd>
                  <dt>工作坐标</dt>
                  <dd>WGS84</dd>
                </dl>
                {!editable && <p className="form-note">当前来源只读</p>}
              </aside>
            </div>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>关闭</button>
              <button
                disabled={!editable || busy}
                onClick={modal === "json" ? applyProperties : applyWkt}
              >
                <Check size={15} />
                {modal === "json" ? "应用属性" : "应用几何"}
              </button>
            </div>
          </Modal>
        )}
        {modal === "field" && (
          <Modal title="添加字段" onClose={() => openModal(null)}>
            <div className="form-grid">
              <label>
                字段名
                <input
                  aria-label="新字段名"
                  value={newField}
                  onChange={(e) => setNewField(e.target.value)}
                />
              </label>
              <p className="form-note">
                {active?.name} · {active?.features.length ?? 0}{" "}
                个要素，初始值为空字符串。
              </p>
            </div>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>取消</button>
              <button
                disabled={
                  !newField.trim() ||
                  !editable ||
                  busy ||
                  active?.sourceKind === "postgis"
                }
                onClick={() => {
                  const name = newField.trim();
                  if (fields.includes(name)) {
                    setError("字段已存在，不能覆盖原值");
                    return;
                  }
                  edit(
                    active!.features.map((f) => ({
                      ...f,
                      properties: { ...f.properties, [name]: "" },
                    })),
                  );
                  setNewField("");
                  openModal(null);
                }}
              >
                添加字段
              </button>
            </div>
          </Modal>
        )}
        {modal === "delete" && (
          <Modal title="删除选中要素" onClose={() => openModal(null)}>
            <p>删除当前选中的 1 个要素？</p>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>取消</button>
              <button
                className="danger"
                disabled={!selected || !editable || busy}
                onClick={() => {
                  edit(active!.features.filter((f) => f.id !== selectedId));
                  setSelectedId(undefined);
                  openModal(null);
                }}
              >
                删除
              </button>
            </div>
          </Modal>
        )}
        {modal === "database" && (
          <Modal title="PostGIS 数据源" onClose={() => setModal(null)}>
            <div className="form-grid">
              <div className="two-columns">
                <label>
                  主机
                  <input
                    value={connection.host}
                    onChange={(e) =>
                      setConnection((c) => ({ ...c, host: e.target.value }))
                    }
                  />
                </label>
                <label>
                  端口
                  <input
                    type="number"
                    value={connection.port}
                    onChange={(e) =>
                      setConnection((c) => ({
                        ...c,
                        port: Number(e.target.value),
                      }))
                    }
                  />
                </label>
              </div>
              <div className="two-columns">
                <label>
                  数据库
                  <input
                    value={connection.database}
                    onChange={(e) =>
                      setConnection((c) => ({ ...c, database: e.target.value }))
                    }
                  />
                </label>
                <label>
                  用户
                  <input
                    value={connection.user}
                    onChange={(e) =>
                      setConnection((c) => ({ ...c, user: e.target.value }))
                    }
                  />
                </label>
              </div>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="off"
                  value={connection.password}
                  onChange={(e) =>
                    setConnection((c) => ({ ...c, password: e.target.value }))
                  }
                />
              </label>
              <label>
                TLS
                <select
                  value={connection.sslMode}
                  onChange={(e) =>
                    setConnection((c) => ({ ...c, sslMode: e.target.value }))
                  }
                >
                  <option value="require">TLS · 校验证书</option>
                  <option value="disable">禁用 TLS · 明文连接</option>
                </select>
              </label>
              <button disabled={busy} onClick={connect}>
                <Database size={16} />
                {connectionId ? "重新连接" : "连接"}
              </button>
              {connectionId && (
                <>
                  <label>
                    数据表
                    <select
                      value={dbIndex}
                      onChange={(e) => {
                        setDbIndex(Number(e.target.value));
                        setDbWktColumn("");
                      }}
                    >
                      {dbLayers.map((l, i) => (
                        <option
                          key={`${l.schema}.${l.table}.${l.geometryColumn}`}
                          value={i}
                        >
                          {l.schema}.{l.table}
                          {l.geometryColumn ? ` · ${l.geometryColumn}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {dbLayers[dbIndex]?.geometryKind === "wkt" && (
                    <div className="two-columns">
                      <label>
                        WKT 文本列
                        <select
                          value={
                            dbWktColumn || dbLayers[dbIndex]?.geometryColumn
                          }
                          onChange={(e) => setDbWktColumn(e.target.value)}
                        >
                          <option value="">选择列</option>
                          {dbLayers[dbIndex]?.columns
                            .filter(
                              (c) =>
                                c.type.includes("text") ||
                                c.type.includes("character"),
                            )
                            .map((c) => (
                              <option key={c.name}>{c.name}</option>
                            ))}
                        </select>
                      </label>
                      <label>
                        SRID
                        <input
                          type="number"
                          value={dbSrid}
                          onChange={(e) => setDbSrid(Number(e.target.value))}
                        />
                      </label>
                    </div>
                  )}
                  {dbLayers[dbIndex]?.geometryKind === "geometry" && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={dbUseViewport}
                        onChange={(e) => setDbUseViewport(e.target.checked)}
                      />
                      仅载入当前地图范围
                    </label>
                  )}
                  <label>
                    最多读取记录
                    <input
                      type="number"
                      min="1"
                      max="100000"
                      value={dbLimit}
                      onChange={(e) => setDbLimit(Number(e.target.value))}
                    />
                  </label>
                  <p className="form-note">
                    无稳定主键的来源只读。密码不保存；提交修改会写入数据库。
                  </p>
                  <div className="modal-actions">
                    <button
                      disabled={busy || !dbLayers.length}
                      onClick={loadDatabase}
                    >
                      <FolderOpen size={16} />
                      载入
                    </button>
                  </div>
                </>
              )}
            </div>
          </Modal>
        )}
        {modal === "close" && (
          <Modal title="移除未保存图层" onClose={() => setModal(null)}>
            <p>“{active?.name}” 存在未保存修改。</p>
            <div className="modal-actions">
              <button onClick={() => setModal(null)}>取消</button>
              <button className="danger" onClick={closeLayer}>
                放弃并移除
              </button>
            </div>
          </Modal>
        )}
        {modal === "recovery" && (
          <Modal title="发现未保存副本" onClose={() => setModal(null)}>
            <p>
              上次运行保留了 {recovery?.length}{" "}
              个图层。数据库来源将恢复为本地副本。
            </p>
            <div className="modal-actions">
              <button
                onClick={() => {
                  api.backup("[]");
                  setRecovery(null);
                  setModal(null);
                }}
              >
                放弃副本
              </button>
              <button
                onClick={() => {
                  addLayers(recovery ?? []);
                  setRecovery(null);
                  setModal(null);
                }}
              >
                <RotateCcw size={16} />
                恢复
              </button>
            </div>
          </Modal>
        )}
        {modal === "quit" && (
          <Modal title="退出 zGIS" onClose={() => setModal(null)}>
            <p>存在未保存修改，是否保留恢复副本后退出？</p>
            <div className="modal-actions">
              <button onClick={() => setModal(null)}>取消</button>
              <button
                onClick={() =>
                  task(async () => {
                    await api.backup(
                      JSON.stringify(
                        currentLayers.current.map((l) => ({
                          ...l,
                          db: undefined,
                          sourceId: undefined,
                          sourceKind:
                            l.sourceKind === "postgis"
                              ? "geojson"
                              : l.sourceKind,
                        })),
                      ),
                    );
                    await getCurrentWindow().destroy();
                  })
                }
              >
                保留副本并退出
              </button>
            </div>
          </Modal>
        )}
      </div>
    </ErrorContext.Provider>
  );
}
