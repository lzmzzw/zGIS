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
    ref.current?.showModal();
    const dialog = ref.current;
    return () => dialog?.close();
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
export default function App() {
  const [layers, setLayers] = useState<DocumentLayer[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [tool, setTool] = useState<Tool>("select");
  const [basemap, setBasemap] = useState("osm");
  const [tdtKey, setTdtKey] = useState("");
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
  const [tableOpen, setTableOpen] = useState(true);
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
    if (!active || busy) return;
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
    if (!active || busy) return;
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
    if (!selected || !active) return;
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
    if (!selected || !active) return;
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
  async function save() {
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
          active.sourceId,
          Boolean(active.sourceId),
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
    active?.sourceKind !== "postgis" ||
    (Boolean(active.db?.keyColumns.length) && !uncertainDocs.has(active.id));
  return (
    <ErrorContext.Provider value={error}>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <img className="brand-mark" src="/zgis.svg" alt="" />
            <strong>zGIS</strong>
            <span className="version">0.1</span>
          </div>
          <div className="document-title">
            {active?.name ?? "地理数据工作区"}
            {active?.dirty && <span className="dirty-dot" title="未保存" />}
          </div>
          <div className="header-actions">
            <button
              onClick={() =>
                task(async () =>
                  desktop
                    ? acceptFiles(await api.open())
                    : input.current?.click(),
                )
              }
              disabled={busy}
            >
              <FolderOpen size={16} />
              打开
            </button>
            <button
              onClick={() => setModal("database")}
              disabled={!desktop || busy}
            >
              <Database size={16} />
              PostGIS
            </button>
            <IconButton label="底图设置" onClick={() => setModal("settings")}>
              <Settings2 size={18} />
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
        <div className="toolbar">
          <div className="tool-group">
            {tools.map((item) => (
              <IconButton
                key={item.value}
                label={item.label}
                disabled={!active || !editable || busy}
                active={tool === item.value}
                onClick={() => setTool(item.value)}
              >
                <item.icon size={18} />
              </IconButton>
            ))}
            <IconButton
              label="删除选中要素"
              disabled={!selected || !editable || busy}
              onClick={() => {
                edit(active!.features.filter((f) => f.id !== selectedId));
                setSelectedId(undefined);
              }}
            >
              <Trash2 size={18} />
            </IconButton>
          </div>
          <div className="tool-group">
            <IconButton
              label="撤销"
              disabled={!h?.past.length || busy}
              onClick={() => history("undo")}
            >
              <Undo2 size={18} />
            </IconButton>
            <IconButton
              label="重做"
              disabled={!h?.future.length || busy}
              onClick={() => history("redo")}
            >
              <Redo2 size={18} />
            </IconButton>
            <IconButton
              label="缩放至图层"
              disabled={!active}
              onClick={() => setFitNonce((n) => n + 1)}
            >
              <LocateFixed size={18} />
            </IconButton>
          </div>
          <div className="toolbar-spacer" />
          <button
            disabled={
              !active || busy || (active.sourceKind === "postgis" && !editable)
            }
            onClick={save}
          >
            <Save size={16} />
            {active?.sourceKind === "postgis" ? "提交修改" : "保存"}
          </button>
          <button disabled={!active || busy} onClick={() => setModal("export")}>
            <Download size={16} />
            导出 / 转换
          </button>
        </div>
        <main className="workspace">
          <aside className="layers-panel">
            <div className="panel-heading">
              <span>图层</span>
              <span className="count">{layers.length}</span>
            </div>
            <div className="layer-list">
              {layers.map((l) => (
                <div
                  key={l.id}
                  className={`layer-row ${l.id === activeId ? "selected" : ""}`}
                  onClick={() => setActiveId(l.id)}
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
                  <input
                    type="color"
                    value={l.color}
                    aria-label={`${l.name}颜色`}
                    onChange={(e) =>
                      setLayers((old) =>
                        old.map((item) =>
                          item.id === l.id
                            ? { ...item, color: e.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                  <div className="layer-text">
                    <strong title={l.name}>
                      {l.name}
                      {l.dirty ? " *" : ""}
                    </strong>
                    <span>
                      {l.sourceKind.toUpperCase()} ·{" "}
                      {l.features.length.toLocaleString()} 要素
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="layer-footer">
              <button onClick={() => addLayers([createDemoLayer()])}>
                <Plus size={15} />
                城市示例
              </button>
              <IconButton
                label="移除图层"
                disabled={!active}
                onClick={() =>
                  active?.dirty ? setModal("close") : closeLayer()
                }
              >
                <X size={16} />
              </IconButton>
            </div>
            {active && (
              <div className="layer-meta">
                <span>工作坐标系</span>
                <strong>WGS84 · EPSG:4326</strong>
                <span>来源</span>
                <strong>
                  {active.sourceKind === "shp"
                    ? "Shapefile · 只读来源"
                    : active.sourceKind}
                </strong>
                {active.warnings?.map((w, i) => (
                  <p className="warning" key={i}>
                    {w}
                  </p>
                ))}
              </div>
            )}
          </aside>
          <section className="map-column">
            <div className="map-container">
              <MapView
                disabled={busy || !editable}
                layers={layers}
                activeId={activeId}
                selectedId={selectedId}
                tool={tool}
                basemap={basemap}
                tdtKey={tdtKey}
                fitNonce={fitNonce}
                onSelect={setSelectedId}
                onEdit={onGeometry}
                onPosition={setPosition}
                onBounds={setBounds}
              />
              <div className="map-top-right">
                <select
                  aria-label="底图"
                  value={basemap}
                  onChange={(e) => {
                    if (e.target.value.startsWith("tdt") && !tdtKey) {
                      setModal("settings");
                      return;
                    }
                    setBasemap(e.target.value);
                  }}
                >
                  <option value="osm">OpenStreetMap</option>
                  <option value="tdt-vec">天地图 · 矢量</option>
                  <option value="tdt-img">天地图 · 影像</option>
                  <option value="none">无底图</option>
                </select>
              </div>
              {!layers.length && (
                <div className="map-empty">
                  <img className="brand-mark" src="/zgis.svg" alt="" />
                  <h2>zGIS</h2>
                  <button
                    onClick={() =>
                      desktop
                        ? task(async () => acceptFiles(await api.open()))
                        : input.current?.click()
                    }
                  >
                    <FolderOpen size={16} />
                    打开数据
                  </button>
                  <button
                    className="quiet"
                    onClick={() => addLayers([createDemoLayer()])}
                  >
                    城市示例
                  </button>
                </div>
              )}
            </div>
            <section
              className={`attribute-panel ${tableOpen ? "" : "collapsed"}`}
            >
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
              </header>
              {tableOpen && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="index-cell">#</th>
                        <th>几何</th>
                        {fields.map((field) => (
                          <th key={field} title={field}>
                            {field}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((f, index) => (
                        <tr
                          key={f.id}
                          className={selectedId === f.id ? "selected" : ""}
                          onClick={() => setSelectedId(f.id)}
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
          <aside className="inspector">
            <div className="panel-heading">
              <span>要素属性</span>
              {selected && (
                <span className="count">
                  {selected.geometry?.type ?? "空几何"}
                </span>
              )}
            </div>
            {selected ? (
              <div className="inspector-body">
                <div className="property-fields">
                  {Object.entries(selected.properties).map(([key, value]) => (
                    <label key={key}>
                      <span title={key}>{key}</span>
                      {typeof value === "boolean" ? (
                        <input
                          type="checkbox"
                          aria-label={`属性 ${key}`}
                          checked={value}
                          disabled={!editable || busy}
                          onChange={(e) =>
                            edit(
                              active!.features.map((f) =>
                                f.id === selected.id
                                  ? {
                                      ...f,
                                      properties: {
                                        ...f.properties,
                                        [key]: e.target.checked,
                                      },
                                    }
                                  : f,
                              ),
                            )
                          }
                        />
                      ) : (
                        <input
                          aria-label={`属性 ${key}`}
                          value={stringify(value)}
                          disabled={
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
                            edit(
                              active.features.map((f) =>
                                f.id === selected.id
                                  ? {
                                      ...f,
                                      properties: {
                                        ...f.properties,
                                        [key]:
                                          typeof value === "number" &&
                                          inputValue !== "" &&
                                          Number.isFinite(Number(inputValue))
                                            ? Number(inputValue)
                                            : inputValue,
                                      },
                                    }
                                  : f,
                              ),
                            );
                          }}
                        />
                      )}
                    </label>
                  ))}
                </div>
                <div className="new-field">
                  <input
                    aria-label="新字段名"
                    placeholder="新字段名"
                    value={newField}
                    onChange={(e) => setNewField(e.target.value)}
                  />
                  <IconButton
                    label="添加字段"
                    disabled={
                      !newField.trim() ||
                      !editable ||
                      busy ||
                      active?.sourceKind === "postgis"
                    }
                    onClick={() => {
                      if (fields.includes(newField.trim())) {
                        setError("字段已存在，不能覆盖原值");
                        return;
                      }
                      edit(
                        active!.features.map((f) => ({
                          ...f,
                          properties: {
                            ...f.properties,
                            [newField.trim()]: "",
                          },
                        })),
                      );
                      setNewField("");
                    }}
                  >
                    <Plus size={17} />
                  </IconButton>
                </div>
                <details>
                  <summary>JSON 属性</summary>
                  <textarea
                    aria-label="JSON 属性"
                    value={propertyText}
                    onChange={(e) => setPropertyText(e.target.value)}
                  />
                  <button
                    disabled={!editable || busy}
                    onClick={applyProperties}
                  >
                    <Check size={14} />
                    应用属性
                  </button>
                </details>
                <details open>
                  <summary>WKT · WGS84</summary>
                  <textarea
                    aria-label="WKT 几何"
                    value={wktText}
                    onChange={(e) => setWktText(e.target.value)}
                  />
                  <button disabled={!editable || busy} onClick={applyWkt}>
                    <Check size={14} />
                    应用几何
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
        {error && (
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
          <div />
          <span>
            {position[0].toFixed(5)}, {position[1].toFixed(5)}
          </span>
          <span>EPSG:3857</span>
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
          <Modal title="底图设置" onClose={() => setModal(null)}>
            <div className="form-grid">
              <label>
                天地图 tk
                <input
                  type="password"
                  value={tdtKey}
                  autoComplete="off"
                  onChange={(e) => setTdtKey(e.target.value)}
                />
              </label>
              <p className="form-note">
                tk
                仅在本次运行保留。底图请求使用网络；本地要素不会上传到瓦片服务。
              </p>
              <div className="modal-actions">
                <button onClick={() => setModal(null)}>
                  <Check size={16} />
                  完成
                </button>
              </div>
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
