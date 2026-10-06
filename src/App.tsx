import {
  createContext,
  useContext,
  useMemo,
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
  Search,
  ChevronLeft,
  ChevronRight,
  Bot,
  Minus,
  Square,
} from "lucide-react";
import LayerTree from "./LayerTreePanel";
import {
  reconcileTree,
  orderedTreeLayers,
  moveTreeNode,
  addTreeGroup,
  updateTreeGroup,
  type LayerTreeNode,
} from "./layerTree";
import SettingsPage, { type SettingsCategory } from "./SettingsPage";
import AgentPanel from "./AgentPanel";
import MapView, { type Tool } from "./MapView";
import { ImportPanel, ExportPanel } from "./FilePanels";
import {
  SourcePanel,
  ConnectionPanel,
  LoadPanel,
  SubmitPanel,
} from "./DatabasePanels";
import { databaseChanges } from "./dbChanges";
import {
  restoreWorkspace,
  snapshotWorkspace,
  type ExitAction,
} from "./workspace";
import {
  createDemoLayer,
  exportGeoJSON,
  exportCsv,
  cloneFeatures,
  validateGeometry,
  geometryToWkt,
  geometryFromWkt,
  makeLayer,
  parseProperties,
  importGeoJSON,
} from "./domain";
import type { DocumentLayer, GeoFeature, ImportOptions } from "./domain";
import { parseInWorker, cancelParsing } from "./workers";
import {
  api,
  desktop,
  download,
  onFilesDropped,
  type DroppedFiles,
  type InputFile,
  type DbLayer,
  type DbConnection,
  type AnalysisLayer,
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
  showError = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  showError?: boolean;
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
      {showError && error && (
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
  useEffect(() => {
    // Escape closes the open picker before any enclosing settings page or menu.
    const pickerEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("select:open")) event.stopPropagation();
    };
    document.addEventListener("keydown", pickerEscape, true);
    return () => document.removeEventListener("keydown", pickerEscape, true);
  }, []);

  const [agentOpen, setAgentOpen] = useState(false);
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
  const [settingCategory, setSettingCategory] =
    useState<SettingsCategory>("appearance");
  const [annotations, setAnnotations] = useState(true);
  const [snapping, setSnapping] = useState(true);
  const [layersOpen, setLayersOpen] = useState(true);
  const [tree, setTree] = useState<LayerTreeNode[]>([]);
  const mapLayers = useMemo(
    () =>
      orderedTreeLayers(
        reconcileTree(
          tree,
          layers.map((l) => l.id),
        ),
        layers,
      ),
    [tree, layers],
  );
  const currentTree = useRef(tree);
  currentTree.current = tree;
  const insertionGroup = useRef<string | undefined>(undefined);
  useEffect(() => {
    setTree((old) =>
      reconcileTree(
        old,
        layers.map((l) => l.id),
      ),
    );
  }, [layers]);
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
    | "db-load"
    | "db-sources"
    | "submit"
    | "settings"
    | "close"
    | "quit"
    | "json"
    | "wkt"
    | "field"
    | "delete"
    | null
  >(null);
  const [pendingFiles, setPendingFiles] = useState<InputFile[]>([]);
  const [exportMode, setExportMode] = useState("geojson");
  const [exportCrs, setExportCrs] = useState("EPSG:4326");
  const [exportFilename, setExportFilename] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [tableOpen, setTableOpen] = useState(false);
  const [propertyText, setPropertyText] = useState("{}");
  const [wktText, setWktText] = useState("");
  const [newField, setNewField] = useState("");
  const [recoveryReady, setRecoveryReady] = useState(!desktop);
  const [exitActions, setExitActions] = useState<Record<string, ExitAction>>(
    {},
  );
  const snapshotQueue = useRef<Promise<unknown>>(Promise.resolve());
  const exitPending = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const recoveryBlocked = useRef(false);
  const histories = useRef(new Map<string, History>());
  const [, refreshHistory] = useState(0);
  const dbBaselines = useRef(new Map<string, GeoFeature[]>());
  const dbReadLimits = useRef(new Map<string, number>());
  const input = useRef<HTMLInputElement>(null);
  const currentLayers = useRef(layers);
  currentLayers.current = layers;
  const active = layers.find((layer) => layer.id === activeId);
  const mcpSyncQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!desktop || !recoveryReady) return;
    const snapshot = layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      features: layer.features.map((feature) => ({
        type: "Feature",
        id: feature.id,
        geometry: feature.geometry,
        properties: feature.properties,
      })),
    }));
    mcpSyncQueue.current = mcpSyncQueue.current
      .catch(() => {})
      .then(() => api.mcpSync(snapshot, activeId))
      .catch((reason) =>
        setError(`空间分析图层同步失败：${errorText(reason)}`),
      );
  }, [layers, activeId, recoveryReady]);
  const pendingAnalysis = useRef<AnalysisLayer[]>([]);
  const analysisInFlight = useRef<Promise<void> | null>(null);
  function importPendingAnalysis() {
    if (!pendingAnalysis.current.length) return;
    const added = pendingAnalysis.current.map((result) =>
      makeLayer(
        result.name,
        importGeoJSON(
          JSON.stringify({
            type: "FeatureCollection",
            features: result.features,
          }),
        ),
        "geojson",
        { dirty: true, warnings: ["空间分析结果副本，请核对后保存或导出。"] },
      ),
    );
    pendingAnalysis.current = [];
    const next = [...currentLayers.current, ...added];
    currentLayers.current = next;
    setLayers(next);
    setActiveId(added.at(-1)?.id);
    setLayersOpen(true);
    setFitNonce((n) => n + 1);
    setStatus(`已添加 ${added.length} 个空间分析结果图层`);
  }
  const importAnalysisRef = useRef(importPendingAnalysis);
  importAnalysisRef.current = importPendingAnalysis;
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const timer = window.setInterval(() => {
      if (analysisInFlight.current || busyRef.current || exitPending.current)
        return;
      analysisInFlight.current = (async () => {
        try {
          const incoming = await api.mcpResults();
          if (incoming?.length) pendingAnalysis.current.push(...incoming);
          // Save/close may begin while IPC is pending; keep drained data until safe.
          if (alive && !busyRef.current && !exitPending.current)
            importAnalysisRef.current();
        } catch (reason) {
          if (alive) setError(`空间分析结果读取失败：${errorText(reason)}`);
        } finally {
          analysisInFlight.current = null;
        }
      })();
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
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
    if (value === "export" && active)
      setExportFilename(
        active.name.replace(/\.[^.]+$/, "") +
          (exportMode === "shp"
            ? ".zip"
            : exportMode === "geojson"
              ? ".geojson"
              : ".csv"),
      );
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
    insertionGroup.current = undefined;
    requestFiles();
  }
  function requestFiles() {
    if (desktop) void openDesktopFiles();
    else input.current?.click();
  }
  async function openDesktopFiles() {
    if (busyRef.current) return;
    let files: InputFile[] = [];
    await task(async () => {
      files = await api.open();
    });
    if (files.length) await acceptFiles(files);
  }
  const droppedHandler = useRef<(payload: DroppedFiles) => void>(() => {});
  droppedHandler.current = (payload) => {
    if (payload.error) {
      setError(payload.error);
      setStatus("拖入失败");
      return;
    }
    if (busyRef.current || modal || !recoveryReady || exitPending.current) {
      setError("当前操作尚未完成，请关闭面板或等待后重新拖入文件");
      return;
    }
    insertionGroup.current = undefined;
    void importSelected(payload.files);
  };
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void onFilesDropped((payload) => {
      if (!disposed) droppedHandler.current(payload);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch((reason) => {
        if (!disposed) setError(`文件拖入监听失败：${errorText(reason)}`);
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
  function openSources() {
    setLayersOpen(true);
    insertionGroup.current = undefined;
    requestSources();
  }
  function requestSources() {
    openModal(connectionId ? "db-sources" : "database");
  }
  function configureDatabase(index: number) {
    setDbIndex(index);
    setDbWktColumn("");
    setDbSrid(dbLayers[index]?.srid || 4326);
    openModal("db-load");
  }
  function changeBasemap(value: string) {
    if (value.startsWith("tdt") && !tdtKey) {
      setSettingCategory("map");
      openModal("settings");
      return;
    }
    setBasemap(value);
  }
  function writeSnapshot(documents: DocumentLayer[]) {
    const content = snapshotWorkspace(documents, currentTree.current);
    const next = snapshotQueue.current
      .catch(() => {})
      .then(() => api.backup(content));
    snapshotQueue.current = next;
    return next;
  }
  async function requestExit() {
    if (busyRef.current || !recoveryReady || exitPending.current) return;
    exitPending.current = true;
    try {
      await analysisInFlight.current;
      importAnalysisRef.current();
    } catch (reason) {
      exitPending.current = false;
      setError(errorText(reason));
      return;
    }
    setError("");
    setExitActions(
      Object.fromEntries(
        currentLayers.current
          .filter((layer) => layer.dirty)
          .map((layer) => [layer.id, "keep"]),
      ),
    );
    setModal("quit");
  }
  function cancelExit() {
    if (busyRef.current) return;
    exitPending.current = false;
    openModal(null);
  }
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    api
      .recover()
      .then((raw) => {
        if (disposed) return;
        if (raw) {
          const restored = restoreWorkspace(raw);
          if (restored.layers.length) {
            addLayers(restored.layers);
            setTree(restored.tree);
            setStatus(`已恢复 ${restored.layers.length} 个本地副本`);
          }
        }
      })
      .catch((reason) => {
        if (disposed) return;
        recoveryBlocked.current = true;
        setError("恢复副本加载失败：" + errorText(reason));
      })
      .finally(() => {
        if (!disposed) setRecoveryReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const exitHandler = useRef(requestExit);
  exitHandler.current = requestExit;
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        exitHandler.current();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((reason) => setError(errorText(reason)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    if (
      !desktop ||
      !recoveryReady ||
      recoveryBlocked.current ||
      exitPending.current ||
      busy
    )
      return;
    const timer = setTimeout(() => {
      if (exitPending.current || busyRef.current) return;
      void writeSnapshot(currentLayers.current).catch(() =>
        setStatus("恢复副本保存失败"),
      );
    }, 1500);
    return () => clearTimeout(timer);
  }, [layers, tree, recoveryReady, modal, busy]);
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
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
      setStatus("操作失败");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function addLayers(imported: DocumentLayer[]) {
    const group = insertionGroup.current;
    insertionGroup.current = undefined;
    setTree((old) => {
      let next = reconcileTree(
        old,
        [...layers, ...imported].map((l) => l.id),
      );
      if (group)
        for (const layer of imported) {
          try {
            next = moveTreeNode(next, layer.id, group, "inside");
          } catch {}
        }
      return next;
    });
    setLayers((old) => [...old, ...imported]);
    setActiveId(imported[0]?.id);
    setFitNonce((n) => n + 1);
    setStatus(
      `已载入 ${imported.reduce((n, l) => n + l.features.length, 0)} 个要素`,
    );
  }
  async function importSelected(
    files: InputFile[],
    options?: ImportOptions,
    perFileOptions?: ImportOptions[],
  ) {
    await task(async () => {
      setStatus("解析中");
      let result: DocumentLayer[];
      try {
        result = await parseInWorker(files, options, perFileOptions);
      } catch (reason) {
        setPendingFiles(files);
        setModal("import");
        throw reason;
      }
      addLayers(result);
      setPendingFiles([]);
      setModal(null);
    });
  }
  async function acceptFiles(files: InputFile[]) {
    if (!files.length) return;
    setPendingFiles(files);
    if (files.some((f) => /\.(csv|geojson|json)$/i.test(f.name))) {
      openModal("import");
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
      const json = geometryFromWkt(wktText);
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
      openModal("submit");
      return;
    }
    if (active.sourceKind === "shp") {
      if (desktop) {
        setExportMode("shp");
        setExportFilename(active.name.replace(/\.[^.]+$/, "") + ".zip");
        setError("");
        setModal("export");
        return;
      }
      openModal("export");
      return;
    }
    await task(async () => {
      await saveDocument(active, asNew);
    });
  }
  async function saveDocument(
    doc: DocumentLayer,
    asNew = false,
  ): Promise<DocumentLayer> {
    const content =
      doc.sourceKind === "csv"
        ? exportCsv(doc.features, {
            ...doc.csvConfig,
            mode: doc.csvConfig?.wktColumn ? "wkt" : "xy",
            crs: doc.originalCrs,
          })
        : exportGeoJSON(doc.features);
    let updated = { ...doc, dirty: false, restored: false };
    const filename =
      doc.sourceKind === "csv"
        ? /\.csv$/i.test(doc.name)
          ? doc.name
          : doc.name + ".csv"
        : /\.(geojson|json)$/i.test(doc.name)
          ? doc.name
          : doc.name.replace(/\.(csv|shp)$/i, "") + ".geojson";
    if (desktop) {
      const result = await api.save(
        content,
        filename,
        asNew ? undefined : doc.sourceId,
        !asNew && Boolean(doc.sourceId),
      );
      if (!result) throw new Error("已取消保存，工作区仍保留");
      updated = { ...updated, sourceId: result.sourceId, name: result.name };
    } else download(content, filename);
    setLayers((old) =>
      old.map((layer) => (layer.id === doc.id ? updated : layer)),
    );
    currentLayers.current = currentLayers.current.map((layer) =>
      layer.id === doc.id ? updated : layer,
    );
    setStatus("保存完成");
    return updated;
  }
  async function processExit() {
    await task(async () => {
      const retained: DocumentLayer[] = [];
      for (const doc of [...currentLayers.current]) {
        if (!doc.dirty) continue;
        const action = exitActions[doc.id] ?? "keep";
        if (action === "keep") retained.push(doc);
        else if (action === "save")
          await saveDocument(doc, doc.sourceKind === "shp");
        else if (action === "submit") await commitLayer(doc);
      }
      if (desktop) {
        if (!recoveryBlocked.current || retained.length)
          await writeSnapshot(retained);
        await getCurrentWindow().destroy();
      } else {
        setLayers(retained);
        setActiveId(retained[0]?.id);
        exitPending.current = false;
        setModal(null);
      }
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
      } else if (exportMode === "shp") {
        if (!desktop) throw new Error("SHP 导出仅在桌面版提供");
        const name =
          exportFilename.trim().replace(/\.(geojson|json|csv|shp|zip)$/i, "") +
          ".zip";
        const result = await api.exportShapefile(
          active.features,
          name,
          exportCrs,
        );
        if (!result) {
          setStatus("已取消导出");
          return;
        }
        setStatus("导出完成：SHP ZIP 已另存；工作副本和修改状态保留");
      } else {
        const content =
          exportMode === "geojson"
            ? exportGeoJSON(active.features, exportCrs)
            : exportCsv(active.features, {
                ...active.csvConfig,
                mode: exportMode === "xy" ? "xy" : "wkt",
                crs: exportCrs,
              });
        const name =
          exportFilename.trim().replace(/\.(geojson|json|csv)$/i, "") +
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
      setLayersOpen(true);
      setModal("db-sources");
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
        srid: info.geometryKind === "wkt" ? dbSrid : info.srid || 4326,
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
      dbReadLimits.current.set(doc.id, dbLimit);
      if (bbox) dbBounds.current.set(doc.id, bbox);
      addLayers([doc]);

      setModal(null);
    });
  }
  async function commitLayer(doc: DocumentLayer): Promise<DocumentLayer> {
    if (!doc.db || !doc.db.keyColumns.length || uncertainDocs.has(doc.id))
      throw new Error("当前副本不可提交，请重新载入来源");
    const before = dbBaselines.current.get(doc.id);
    if (!before) throw new Error("提交基线缺失，请重新载入来源");
    const changes = databaseChanges(before, doc.features);
    if (!changes.length) {
      const updated = { ...doc, dirty: false };
      setLayers((old) =>
        old.map((layer) => (layer.id === doc.id ? updated : layer)),
      );
      setStatus("没有待提交修改");
      return updated;
    }
    const blockRetry = (message: string) => {
      setUncertainDocs((old) => new Set([...old, doc.id]));
      setLayers((old) =>
        old.map((layer) =>
          layer.id === doc.id
            ? { ...layer, warnings: [...(layer.warnings ?? []), message] }
            : layer,
        ),
      );
    };
    try {
      await api.commit(doc.db.connectionId, doc.db, changes);
    } catch (reason) {
      if (errorText(reason).includes("提交结果待核对"))
        blockRetry(
          "提交结果待核对，请重新载入来源后核对数据；当前副本禁止重复提交。",
        );
      throw reason;
    }
    const result = await api
      .query(
        doc.db.connectionId,
        doc.db,
        dbReadLimits.current.get(doc.id) ?? 10000,
        dbBounds.current.get(doc.id),
      )
      .then((result) => {
        result.features.forEach((feature) => {
          const problems = validateGeometry(feature.geometry);
          if (problems.length) throw new Error(problems.join("；"));
        });
        return result;
      })
      .catch((reason) => {
        blockRetry(
          "提交已成功，但重读失败。请重新载入来源；当前副本禁止重复提交。",
        );
        throw new Error("提交已成功，重读失败：" + errorText(reason));
      });
    dbBaselines.current.set(doc.id, cloneFeatures(result.features));
    histories.current.delete(doc.id);
    const updated = {
      ...doc,
      features: result.features,
      dirty: false,
      warnings: result.truncated
        ? [
            `已达到 ${dbReadLimits.current.get(doc.id) ?? 10000} 条读取上限，当前不是全表`,
          ]
        : [],
    };
    setLayers((old) =>
      old.map((layer) => (layer.id === doc.id ? updated : layer)),
    );
    setStatus(`已提交 ${changes.length} 条变更`);
    currentLayers.current = currentLayers.current.map((layer) =>
      layer.id === doc.id ? updated : layer,
    );
    return updated;
  }
  async function commit() {
    if (!active) return;
    await task(async () => {
      await commitLayer(active);
      setModal(null);
    });
  }
  async function closeLayer() {
    if (!active) return;
    await task(async () => {
      const next = layers.filter((l) => l.id !== active.id);
      if (desktop) await writeSnapshot(next);
      setLayers(next);
      currentLayers.current = next;
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
    (active?.sourceKind !== "postgis" ||
      (Boolean(active.db?.keyColumns.length) &&
        !uncertainDocs.has(active.id!)));
  let draftSummary = "";
  let draftError = "";
  if (modal === "json" || modal === "wkt") {
    try {
      draftSummary =
        modal === "json"
          ? `${Object.keys(parseProperties(propertyText)).length} 个字段`
          : (geometryFromWkt(wktText)?.type ?? "空几何");
    } catch (reason) {
      draftError = errorText(reason);
    }
  }
  function fieldSummary(field: string) {
    const values =
      active?.features.map((feature) => feature.properties[field]) ?? [];
    const types = [
      ...new Set(
        values
          .filter((value) => value != null)
          .map((value) =>
            Array.isArray(value)
              ? "数组"
              : typeof value === "object"
                ? "对象"
                : typeof value === "number"
                  ? "数值"
                  : typeof value === "boolean"
                    ? "布尔"
                    : "文本",
          ),
      ),
    ];
    const empty = values.filter(
      (value) => value == null || value === "",
    ).length;
    return `${types.join(" / ") || "空值"} · ${values.length} 条 · ${empty} 空值`;
  }
  return (
    <ErrorContext.Provider value={error}>
      <div className="app">
        <header
          className="app-header"
          onMouseDown={(event) => {
            if (!desktop || event.button !== 0 || event.detail === 2) return;
            if (
              (event.target as Element).closest(
                "button, summary, .header-menu, .header-actions, .window-controls",
              )
            )
              return;
            event.preventDefault();
            void getCurrentWindow()
              .startDragging()
              .catch((reason) => setError(errorText(reason)));
          }}
          onDoubleClick={(event) => {
            if (
              !desktop ||
              (event.target as Element).closest(
                "button, summary, .header-menu, .header-actions, .window-controls",
              )
            )
              return;
            void getCurrentWindow()
              .toggleMaximize()
              .catch((reason) => setError(errorText(reason)));
          }}
        >
          <img className="brand-mark" src="/zgis.svg" alt="zGIS" />
          <nav
            className="header-menus"
            aria-label="主菜单"
            hidden={modal === "settings"}
          >
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
              <hr />
              <button disabled={busy || !recoveryReady} onClick={requestExit}>
                <X size={16} />
                退出
              </button>
            </HeaderMenu>
            <HeaderMenu label="数据">
              <button onClick={openFiles} disabled={busy}>
                <FolderOpen size={16} />
                导入数据…
              </button>
              <button onClick={openSources} disabled={!desktop || busy}>
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
                onClick={() => {
                  setLayersOpen((v) => !v);
                }}
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
            </HeaderMenu>
          </nav>
          <div className="document-title" title={active?.name}>
            {active?.name ?? ""}
            {active?.dirty && <span className="dirty-dot" title="未保存" />}
          </div>
          <div className="header-actions">
            {desktop && modal !== "settings" && (
              <>
                <IconButton
                  label="Codex Agent"
                  active={agentOpen}
                  onClick={() => setAgentOpen((v) => !v)}
                >
                  <Bot size={16} />
                </IconButton>
              </>
            )}
            <IconButton
              label="属性表"
              active={tableOpen}
              disabled={modal === "settings"}
              onClick={() => setTableOpen((v) => !v)}
            >
              <Table2 size={16} />
            </IconButton>
            <IconButton
              label="设置"
              active={modal === "settings"}
              disabled={busy}
              onClick={() => {
                setSettingCategory("appearance");
                openModal("settings");
              }}
            >
              <Settings2 size={16} />
            </IconButton>
          </div>
          {desktop && (
            <div className="window-controls">
              <IconButton
                label="最小化"
                onClick={() =>
                  void getCurrentWindow()
                    .minimize()
                    .catch((reason) => setError(errorText(reason)))
                }
              >
                <Minus size={16} />
              </IconButton>
              <IconButton
                label="最大化 / 还原"
                onClick={() =>
                  void getCurrentWindow()
                    .toggleMaximize()
                    .catch((reason) => setError(errorText(reason)))
                }
              >
                <Square size={14} />
              </IconButton>
              <IconButton
                label="关闭窗口"
                disabled={busy || !recoveryReady}
                onClick={() => void requestExit()}
              >
                <X size={18} />
              </IconButton>
            </div>
          )}
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
          hidden={modal === "settings"}
          className="workspace"
          data-layers={layersOpen}
          data-inspector={inspectorOpen}
        >
          <aside className="layers-panel" hidden={!layersOpen}>
            <LayerTree
              tree={reconcileTree(
                tree,
                layers.map((l) => l.id),
              )}
              layers={layers}
              activeId={activeId}
              busy={busy}
              desktop={desktop}
              readonlyIds={layers
                .filter(
                  (l) =>
                    l.sourceKind === "postgis" &&
                    (!l.db?.keyColumns.length || uncertainDocs.has(l.id)),
                )
                .map((l) => l.id)}
              basemap={basemap}
              onBasemap={changeBasemap}
              onSelect={(id) => {
                setActiveId(id);
                setInspectorOpen(true);
                setInspectorTab("layer");
              }}
              onFit={(id) => {
                setActiveId(id);
                setFitNonce((n) => n + 1);
              }}
              onToggleLayer={(id) =>
                setLayers((old) =>
                  old.map((l) =>
                    l.id === id ? { ...l, visible: !l.visible } : l,
                  ),
                )
              }
              onToggleGroup={(id) =>
                setTree((old) => {
                  const visit = (nodes: LayerTreeNode[]): LayerTreeNode[] =>
                    nodes.map((n) =>
                      n.kind === "group"
                        ? {
                            ...n,
                            visible: n.id === id ? !n.visible : n.visible,
                            children: visit(n.children),
                          }
                        : n,
                    );
                  return visit(old);
                })
              }
              onCollapseGroup={(id) =>
                setTree((old) => {
                  const visit = (nodes: LayerTreeNode[]): LayerTreeNode[] =>
                    nodes.map((n) =>
                      n.kind === "group"
                        ? {
                            ...n,
                            collapsed: n.id === id ? !n.collapsed : n.collapsed,
                            children: visit(n.children),
                          }
                        : n,
                    );
                  return visit(old);
                })
              }
              onMove={(id, target, position) => {
                try {
                  setTree((old) => {
                    try {
                      return moveTreeNode(old, id, target, position);
                    } catch {
                      return old;
                    }
                  });
                } catch (reason) {
                  setError(errorText(reason));
                }
              }}
              onAddFiles={(group) => {
                insertionGroup.current = group;
                requestFiles();
              }}
              onAddPostgis={(group) => {
                insertionGroup.current = group;
                requestSources();
              }}
              onNewGroup={(name, parent) =>
                setTree((old) =>
                  addTreeGroup(
                    old,
                    {
                      kind: "group",
                      id: crypto.randomUUID(),
                      name,
                      visible: true,
                      collapsed: false,
                      children: [],
                    },
                    parent,
                  ),
                )
              }
              onRenameGroup={(id, name) =>
                setTree((old) => updateTreeGroup(old, id, { name }))
              }
            />
          </aside>
          <section className="map-column">
            <div className="map-container">
              <div
                className="map-toolbar"
                role="toolbar"
                aria-orientation="vertical"
                aria-label="地图工具"
              >
                <div className="tool-group">
                  {tools.map((item) => (
                    <IconButton
                      key={item.value}
                      label={item.label}
                      disabled={
                        !active ||
                        (item.value !== "select" && !editable) ||
                        busy
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
                    <span>
                      {tools.find((item) => item.value === tool)?.label}
                    </span>
                    {tool !== "modify" && (
                      <IconButton
                        label="完成绘制"
                        disabled={
                          nodeCount <
                          (tool === "Polygon"
                            ? 3
                            : tool === "LineString"
                              ? 2
                              : 1)
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

              <MapView
                disabled={busy}
                editable={editable}
                theme={theme}
                annotations={annotations}
                snapping={snapping}
                finishNonce={finishNonce}
                featureFitNonce={featureFitNonce}
                onNodeCount={setNodeCount}
                layers={mapLayers}
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
                                {fieldSummary(field)}
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
                  <label>
                    不透明度{" "}
                    <output>{Math.round((active.opacity ?? 1) * 100)}%</output>
                    <input
                      type="range"
                      aria-label="不透明度"
                      min="0"
                      max="1"
                      step="0.05"
                      value={active.opacity ?? 1}
                      onChange={(event) =>
                        setLayers((old) =>
                          old.map((layer) =>
                            layer.id === active.id
                              ? {
                                  ...layer,
                                  opacity: Number(event.target.value),
                                }
                              : layer,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    线宽 <output>{active.strokeWidth ?? 2} px</output>
                    <input
                      type="range"
                      aria-label="线宽"
                      min="1"
                      max="8"
                      step="1"
                      value={active.strokeWidth ?? 2}
                      onChange={(event) =>
                        setLayers((old) =>
                          old.map((layer) =>
                            layer.id === active.id
                              ? {
                                  ...layer,
                                  strokeWidth: Number(event.target.value),
                                }
                              : layer,
                          ),
                        )
                      }
                    />
                  </label>
                  <details open>
                    <summary>来源详情</summary>
                    {active.restored && (
                      <p className="form-note">
                        恢复副本 · {active.restoredFrom}
                      </p>
                    )}
                    <dl>
                      <dt>格式</dt>
                      <dd>
                        {active.sourceKind === "shp"
                          ? "Shapefile · 可编辑 / 另存"
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
                        当前数据库副本不可编辑，请核对主键及提交状态。
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
                            setPropertyDraft((draft) =>
                              draft
                                ? {
                                    ...draft,
                                    [key]: inputValue,
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
                          const properties = { ...propertyDraft };
                          for (const [key, value] of Object.entries(
                            selected.properties,
                          )) {
                            if (typeof value !== "number") continue;
                            const draft = properties[key];
                            if (
                              String(draft).trim() === "" ||
                              !Number.isFinite(Number(draft))
                            ) {
                              setError(`${key} 必须是有限数值`);
                              return;
                            }
                            properties[key] = Number(draft);
                          }
                          edit(
                            active!.features.map((f) =>
                              f.id === selected.id ? { ...f, properties } : f,
                            ),
                          );
                          setPropertyDraft(null);
                          setError("");
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
        <footer className="statusbar" hidden={modal === "settings"}>
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
          <Modal
            title={
              pendingFiles.some((file) => /\.csv$/i.test(file.name))
                ? "CSV 导入"
                : "文件导入"
            }
            showError={false}
            onClose={() => {
              if (!busy) {
                setPendingFiles([]);
                openModal(null);
              }
            }}
          >
            <ImportPanel
              files={pendingFiles}
              busy={busy}
              error={error}
              onImport={(options) =>
                void importSelected(pendingFiles, {}, options)
              }
              onClose={() => {
                setPendingFiles([]);
                openModal(null);
              }}
              onChange={() => setError("")}
            />
          </Modal>
        )}
        {modal === "export" && active && (
          <Modal
            title="导出 / 转换"
            showError={false}
            onClose={() => {
              if (!busy) openModal(null);
            }}
          >
            <ExportPanel
              layer={active}
              mode={exportMode}
              crs={exportCrs}
              filename={exportFilename}
              connected={Boolean(connectionId)}
              schema={targetSchema}
              table={targetTable}
              desktop={desktop}
              busy={busy}
              error={error}
              onMode={(value) => {
                setExportMode(value);
                setExportFilename((name) =>
                  name.replace(
                    /\.(geojson|json|csv|zip)$/i,
                    value === "shp"
                      ? ".zip"
                      : value === "geojson"
                        ? ".geojson"
                        : ".csv",
                  ),
                );
                setError("");
              }}
              onCrs={setExportCrs}
              onFilename={setExportFilename}
              onSchema={setTargetSchema}
              onTable={setTargetTable}
              onExport={() => void doExport()}
              onClose={() => openModal(null)}
            />
          </Modal>
        )}
        {agentOpen && desktop && (
          <div className="agent-dock" hidden={modal === "settings"}>
            <AgentPanel onClose={() => setAgentOpen(false)} />
          </div>
        )}
        {modal === "settings" && (
          <SettingsPage
            category={settingCategory}
            onCategory={setSettingCategory}
            theme={theme}
            onTheme={setTheme}
            basemap={basemap}
            onBasemap={setBasemap}
            annotations={annotations}
            onAnnotations={setAnnotations}
            tdtKey={tdtKey}
            onTdtKey={setTdtKey}
            error={error}
            onClose={() => openModal(null)}
          />
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
                  <dt>{modal === "json" ? "草稿字段" : "草稿类型"}</dt>
                  <dd>{draftError ? "未通过校验" : draftSummary}</dd>
                  <dt>工作坐标</dt>
                  <dd>WGS84</dd>
                </dl>
                {!editable && <p className="form-note">当前来源只读</p>}
                {draftError && (
                  <p className="inline-error" role="alert">
                    {draftError}
                  </p>
                )}
              </aside>
            </div>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>关闭</button>
              <button
                disabled={!editable || busy || Boolean(draftError)}
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
        {modal === "db-sources" && (
          <Modal
            title="添加 PostGIS 图层"
            onClose={() => {
              insertionGroup.current = undefined;
              setModal(null);
            }}
          >
            <SourcePanel
              layers={dbLayers}
              index={dbIndex}
              connected={Boolean(connectionId)}
              label={connection.database || "PostGIS"}
              busy={busy}
              onIndex={setDbIndex}
              onLoad={configureDatabase}
              onConnect={() => openModal("database")}
              onRefresh={() =>
                void task(async () => {
                  setDbLayers(await api.discover(connectionId));
                  setDbIndex(0);
                  setDbWktColumn("");
                })
              }
            />
          </Modal>
        )}
        {modal === "database" && (
          <Modal
            title="PostGIS 连接"
            onClose={() => {
              if (!busy) {
                setConnection((config) => ({ ...config, password: "" }));
                openModal(null);
              }
            }}
          >
            <ConnectionPanel
              config={connection}
              busy={busy}
              connected={Boolean(connectionId)}
              onChange={setConnection}
              onConnect={() => void connect()}
              onClose={() => {
                setConnection((config) => ({ ...config, password: "" }));
                openModal(null);
              }}
            />
          </Modal>
        )}
        {modal === "db-load" && dbLayers[dbIndex] && (
          <Modal
            title="加载数据表"
            onClose={() => {
              if (!busy) openModal(null);
            }}
          >
            <LoadPanel
              layer={dbLayers[dbIndex]}
              column={dbWktColumn}
              srid={dbSrid}
              limit={dbLimit}
              viewport={dbUseViewport}
              busy={busy}
              onColumn={setDbWktColumn}
              onSrid={setDbSrid}
              onLimit={setDbLimit}
              onViewport={setDbUseViewport}
              onLoad={() => void loadDatabase()}
              onClose={() => openModal(null)}
            />
          </Modal>
        )}
        {modal === "submit" && active?.db && (
          <Modal
            title="提交到数据库"
            showError={false}
            onClose={() => {
              if (!busy) openModal(null);
            }}
          >
            <SubmitPanel
              target={active.name}
              changes={databaseChanges(
                dbBaselines.current.get(active.id) ?? [],
                active.features,
              )}
              busy={busy}
              blocked={uncertainDocs.has(active.id)}
              error={error}
              onSubmit={() => void commit()}
              onClose={() => openModal(null)}
            />
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
        {modal === "quit" && (
          <Modal title="退出 zGIS" onClose={cancelExit}>
            <div className="exit-layers">
              {layers
                .filter((layer) => layer.dirty)
                .map((layer) => (
                  <label key={layer.id}>
                    <span title={layer.name}>
                      {layer.name}
                      <small>
                        {layer.features.length} 个要素 · {layer.sourceKind}
                      </small>
                    </span>
                    <select
                      aria-label={`退出处理 ${layer.name}`}
                      value={exitActions[layer.id] ?? "keep"}
                      disabled={busy}
                      onChange={(event) =>
                        setExitActions((old) => ({
                          ...old,
                          [layer.id]: event.target.value as ExitAction,
                        }))
                      }
                    >
                      <option value="keep">保留恢复副本</option>
                      <option value="save">
                        {layer.sourceKind === "postgis" ||
                        layer.sourceKind === "shp"
                          ? "另存 GeoJSON"
                          : "保存文件"}
                      </option>
                      {layer.db?.keyColumns.length &&
                      !uncertainDocs.has(layer.id) ? (
                        <option value="submit">提交到数据库</option>
                      ) : null}
                      <option value="discard">放弃修改</option>
                    </select>
                  </label>
                ))}
              {!layers.some((layer) => layer.dirty) && <p>所有图层已保存。</p>}
            </div>
            <p className="form-note">
              待处理 {layers.filter((layer) => layer.dirty).length} 个图层 ·
              保留{" "}
              {
                layers.filter(
                  (layer) =>
                    layer.dirty && (exitActions[layer.id] ?? "keep") === "keep",
                ).length
              }{" "}
              个恢复副本
            </p>
            <div className="modal-actions">
              <button disabled={busy} onClick={cancelExit}>
                取消
              </button>
              <button disabled={busy} onClick={() => void processExit()}>
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                处理并退出
              </button>
            </div>
          </Modal>
        )}
      </div>
    </ErrorContext.Provider>
  );
}
