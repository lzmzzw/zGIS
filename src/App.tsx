import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  FolderOpen,
  Save,
  Download,
  Undo2,
  Redo2,
  MousePointer2,
  Hand,
  Pencil,
  MapPin,
  Route,
  Pentagon,
  Trash2,
  LocateFixed,
  Database,
  Magnet,
  ChevronDown,
  ChevronUp,
  Plus,
  X,
  Check,
  LoaderCircle,
  FileJson,
  Search,
  ChevronLeft,
  ChevronRight,
  Bot,
  Minus,
  Square,
  Maximize2,
  Minimize2,
  Move,
} from "lucide-react";
import BasemapControl from "./BasemapControl";
import ContextMenu, {
  type ContextMenuAnchor,
  type ContextMenuItem,
} from "./ContextMenu";
import { cellText, parseCellValue } from "./attributeEditing";
import LayerTree from "./LayerTreePanel";
import PostgisManager from "./PostgisManager";
import {
  reconcileTree,
  orderedTreeLayers,
  moveTreeNode,
  addTreeGroup,
  dissolveTreeGroup,
  deleteTreeGroup,
  treeGroupLayerIds,
  updateTreeGroup,
  type LayerTreeNode,
} from "./layerTree";
import {
  defaultBasemaps,
  loadBasemapPreferences,
  serializeBasemapPreferences,
  selectBasemap,
  type BasemapService,
} from "./basemaps";
import SettingsPage, { type SettingsCategory } from "./SettingsPage";
import AgentPanel from "./AgentPanel";
import RightSidebar from "./RightSidebar";
import ProcessingToolbox, {
  type ProcessingRequest,
  type ProcessingOutcome,
} from "./ProcessingToolbox";
import { getAnalysisTool } from "./analysisTools";
import MapView, { type Tool, type DrawDraft } from "./MapView";
import { ImportPanel, ExportPanel } from "./FilePanels";
import { SourcePanel, ConnectionPanel, LoadPanel } from "./DatabasePanels";
import { databaseChanges } from "./dbChanges";
import {
  restoreWorkspace,
  snapshotWorkspace,
  selectRecoverySnapshot,
  type WorkspaceEditSession,
} from "./workspace";
import {
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
  { value: "pan", label: "手形", icon: Hand },
  { value: "select", label: "选择", icon: MousePointer2 },
  { value: "modify", label: "编辑顶点", icon: Pencil },
  { value: "move", label: "移动要素", icon: Move },
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
type WorkspaceContext =
  | {
      kind: "map";
      anchor: ContextMenuAnchor;
      layerId?: string;
      featureId?: string;
      coordinate: number[];
    }
  | {
      kind: "record";
      anchor: ContextMenuAnchor;
      layerId: string;
      featureId: string;
      field?: string;
    }
  | { kind: "field"; anchor: ContextMenuAnchor; layerId: string; field: string }
  | { kind: "text"; anchor: ContextMenuAnchor; text: string };
const nativeTextTarget = (target: Element) =>
  Boolean(
    target.closest(
      'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="button"]):not([type="submit"]), [contenteditable="true"], .xterm',
    ),
  );
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
      aria-pressed={active}
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
      aria-label={title}
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
          <X />
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
  pastFields?: string[][];
  futureFields?: string[][];
  pastSchemas?: DocumentLayer["schemaChanges"][];
  futureSchemas?: DocumentLayer["schemaChanges"][];
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
  const [context, setContext] = useState<WorkspaceContext>();
  useEffect(() => {
    const suppressBrowserMenu = (event: MouseEvent) => {
      if (event.target instanceof Element && !nativeTextTarget(event.target))
        event.preventDefault();
    };
    document.addEventListener("contextmenu", suppressBrowserMenu, true);
    return () =>
      document.removeEventListener("contextmenu", suppressBrowserMenu, true);
  }, []);
  useEffect(() => {
    // Escape closes the open picker before any enclosing settings page or menu.
    const pickerEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("select:open"))
        event.stopPropagation();
    };
    document.addEventListener("keydown", pickerEscape, true);
    return () => document.removeEventListener("keydown", pickerEscape, true);
  }, []);

  const [agentOpen, setAgentOpen] = useState(false);
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [toolboxMounted, setToolboxMounted] = useState(false);
  const [toolboxRunning, setToolboxRunning] = useState(false);
  const toolboxTrigger = useRef<HTMLButtonElement>(null);
  const [layers, setLayers] = useState<DocumentLayer[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const centerImmediately = useRef(true);
  const [tool, setTool] = useState<Tool>("select");
  const [editingLayerId, setEditingLayerId] = useState<string>();
  const [drawDraft, setDrawDraft] = useState<DrawDraft | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  const [cancelNonce, setCancelNonce] = useState(0);
  const [undoNodeNonce, setUndoNodeNonce] = useState(0);
  const restoringSession = useRef<WorkspaceEditSession | undefined>(undefined);
  const restoringPanel = useRef<WorkspaceEditSession["panelDraft"]>(undefined);
  const sessionRef = useRef<WorkspaceEditSession | undefined>(undefined);
  const saveStopsEditing = useRef(false);
  const [newLayerName, setNewLayerName] = useState("新建图层");
  const [newGeometryType, setNewGeometryType] = useState<
    "Point" | "LineString" | "Polygon"
  >("Polygon");
  const [newLayerFields, setNewLayerFields] = useState("");
  const editingBaseline = useRef<
    | {
        id: string;
        features: GeoFeature[];
        dirty: boolean;
        fieldNames?: string[];
      }
    | undefined
  >(undefined);
  const exportSaveLayerId = useRef<string | undefined>(undefined);
  const editing = Boolean(activeId && editingLayerId === activeId);
  const [services, setServices] = useState<BasemapService[]>(defaultBasemaps);
  const [configReady, setConfigReady] = useState(false);
  const configQueue = useRef<Promise<unknown>>(Promise.resolve());
  const configError = useRef("");
  const configBlocked = useRef(false);
  const [basemap, setBasemap] = useState("osm");
  const [basemapVisible, setBasemapVisible] = useState(true);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("zgis.theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  const [settingCategory, setSettingCategory] =
    useState<SettingsCategory>("appearance");
  const [snapping, setSnapping] = useState(true);
  const [layersOpen, setLayersOpen] = useState(true);
  const [layerPanelWidth, setLayerPanelWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("zgis.layerPanelWidth"));
      return saved >= 200 && saved <= 480 ? Math.round(saved) : 260;
    } catch {
      return 260;
    }
  });
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const workspaceElement = useRef<HTMLElement>(null);
  const rightSidebarOpen = toolboxOpen || (agentOpen && desktop);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      // Prefer the shared preference, then migrate an existing dock width.
      for (const key of [
        "zgis.rightSidebarWidth",
        "zgis.toolboxWidth",
        "zgis.agentWidth",
      ]) {
        const value = Number(localStorage.getItem(key));
        if (value >= 320 && value <= 720) return Math.round(value);
      }
    } catch {
      // Keep the dock usable when preferences are unavailable.
    }
    return 400;
  });
  const layerPanelMaxWidth = Math.max(
    200,
    Math.min(480, workspaceWidth - 360 - (rightSidebarOpen ? 320 : 0)),
  );
  const shownLayerPanelWidth = Math.min(layerPanelWidth, layerPanelMaxWidth);
  const sidebarMaxWidth = Math.max(
    320,
    Math.min(
      720,
      workspaceWidth - (layersOpen ? shownLayerPanelWidth : 0) - 360,
    ),
  );
  const shownSidebarWidth = Math.min(sidebarWidth, sidebarMaxWidth);
  useEffect(() => {
    try {
      localStorage.setItem("zgis.layerPanelWidth", String(layerPanelWidth));
      localStorage.setItem("zgis.rightSidebarWidth", String(sidebarWidth));
    } catch {
      /* 当前窗口仍可调整宽度。 */
    }
  }, [layerPanelWidth, sidebarWidth]);
  useEffect(() => {
    const workspace = workspaceElement.current;
    if (!workspace) return;
    const observer = new ResizeObserver(() => {
      if (workspace.clientWidth) setWorkspaceWidth(workspace.clientWidth);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

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
  const [mysqlSourceCount, setMysqlSourceCount] = useState(0);
  const [postgisSourceCount, setPostgisSourceCount] = useState(0);
  useEffect(() => {
    setTree((old) =>
      reconcileTree(
        old,
        layers.map((l) => l.id),
      ),
    );
  }, [layers]);
  const [layerStyleDraft, setLayerStyleDraft] = useState<{
    layerId: string;
    color: string;
    opacity: number;
    strokeWidth: number;
  } | null>(null);
  const [tableEditing, setTableEditing] = useState(false);
  const [tableMaximized, setTableMaximized] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, Record<string, number>>>({});
  const [columnOrders, setColumnOrders] = useState<Record<string, string[]>>({});
  const columnDrag = useRef<string | null>(null);
  const columnResize = useRef<{ x: number; width: number } | null>(null);
  const [cellDraft, setCellDraft] = useState<{
    layerId: string;
    featureId: string;
    field: string;
    text: string;
    original: unknown;
    isNull: boolean;
    expanded: boolean;
    error: string;
  } | null>(null);
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
    | "postgis-manager"
    | "mysql-manager"
    | "rename-field"
    | "delete-field"
    | "settings"
    | "close"
    | "quit"
    | "json"
    | "wkt"
    | "field"
    | "cell"
    | "layer"
    | "style"
    | "delete"
    | "new-layer"
    | null
  >(null);
  const [pendingFiles, setPendingFiles] = useState<InputFile[]>([]);
  const [exportMode, setExportMode] = useState("geojson");
  const [exportCrs, setExportCrs] = useState("EPSG:4326");
  const [exportFilename, setExportFilename] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [tableLocateNonce, setTableLocateNonce] = useState(0);
  const [tableOpen, setTableOpen] = useState(false);
  const [propertyText, setPropertyText] = useState("{}");
  const [wktText, setWktText] = useState("");
  const [newField, setNewField] = useState("");
  const [fieldTarget, setFieldTarget] = useState("");
  const [recoveryReady, setRecoveryReady] = useState(!desktop);
  const snapshotQueue = useRef<Promise<unknown>>(Promise.resolve());
  const exitPending = useRef(false);
  const exitPreviousModal = useRef<typeof modal>(null);
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
  const draftModal = modal === "quit" ? exitPreviousModal.current : modal;
  const sessionHistory = editingLayerId
    ? histories.current.get(editingLayerId)
    : undefined;
  sessionRef.current = editingLayerId
    ? {
        layerId: editingLayerId,
        selectedId: layers
          .find((l) => l.id === editingLayerId)
          ?.features.some((f) => f.id === selectedId)
          ? selectedId
          : undefined,
        tool,
        snapping,
        drawDraft: drawDraft ?? undefined,
        cellDraft: cellDraft
          ? {
              featureId: cellDraft.featureId,
              field: cellDraft.field,
              text: cellDraft.text,
              isNull: cellDraft.isNull,
            }
          : undefined,
        panelDraft:
          (draftModal === "json" || draftModal === "wkt") && selectedId
            ? {
                kind: draftModal,
                featureId: selectedId,
                text: draftModal === "json" ? propertyText : wktText,
              }
            : undefined,
        history: sessionHistory
          ? {
              undo: sessionHistory.past,
              redo: sessionHistory.future,
              undoFieldNames: sessionHistory.pastFields,
              redoFieldNames: sessionHistory.futureFields,
              baseline: editingBaseline.current
                ? {
                    features: editingBaseline.current.features,
                    dirty: editingBaseline.current.dirty,
                    fieldNames: editingBaseline.current.fieldNames,
                  }
                : undefined,
            }
          : undefined,
      }
    : undefined;
  const active = layers.find((layer) => layer.id === activeId);
  const mcpSyncQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!desktop || !recoveryReady) return;
    const snapshot = layers.map((layer) => ({
      id: layer.id,
      name: layer.displayName ?? layer.name,
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
  function importPendingAnalysis(forExit = false) {
    if (
      !pendingAnalysis.current.length ||
      (!forExit && (cellDraft || modal || editingLayerId))
    )
      return;
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
        { dirty: true, warnings: ["空间分析结果副本，核对后可保存或导出。"] },
      ),
    );
    pendingAnalysis.current = [];
    const next = [...currentLayers.current, ...added];
    currentLayers.current = next;
    setLayers(next);
    if (!forExit) {
      setActiveId(added.at(-1)?.id);
      setLayersOpen(true);
      setFitNonce((n) => n + 1);
    }
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
  const [dbEngine, setDbEngine] = useState<"postgis" | "mysql">("postgis");
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
  function openModal(value: typeof modal) {
    setContext(undefined);
    if (drawDraft && value && !["settings", "quit"].includes(value)) {
      setError("请先完成或取消当前绘制");
      return;
    }
    if (cellDraft && value && !["settings", "cell", "quit"].includes(value)) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
    if (value === "export" && active)
      setExportFilename(
        (active.displayName ?? active.name).replace(/\.[^.]+$/, "") +
          (exportMode === "shp"
            ? ".zip"
            : exportMode === "geojson"
              ? ".geojson"
              : ".csv"),
      );
    setError("");
    setModal(value);
  }
  useEffect(() => {
    if (modal !== "export" && modal !== "quit")
      exportSaveLayerId.current = undefined;
  }, [modal]);
  function selectFeature(id?: string, locateInTable = false) {
    if (cellDraft && id !== cellDraft.featureId) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
    centerImmediately.current = locateInTable;
    setSelectedId(id);
    if (id && locateInTable) {
      setSearch("");
      setTableOpen(true);
      setTableLocateNonce((n) => n + 1);
    }
  }
  function openFiles() {
    insertionGroup.current = undefined;
    requestFiles();
  }
  function requestFiles() {
    if (editingLayerId) {
      setError("请先保存并退出当前图层编辑，再打开文件");
      return;
    }
    if (cellDraft) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
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
    if (
      busyRef.current ||
      modal ||
      !recoveryReady ||
      !configReady ||
      Boolean(editingLayerId) ||
      exitPending.current
    ) {
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
  function requestSources(engine: "postgis" | "mysql" = "postgis") {
    if (editingLayerId || cellDraft) {
      setError("请先保存并退出当前图层编辑，再加载数据源");
      return;
    }
    openModal(engine === "mysql" ? "mysql-manager" : "postgis-manager");
  }
  function configureDatabase(index: number) {
    setDbIndex(index);
    setDbWktColumn("");
    setDbSrid(dbLayers[index]?.srid || 4326);
    openModal("db-load");
  }
  useEffect(() => {
    let disposed = false;
    const load = desktop
      ? api.preferences()
      : Promise.resolve(sessionStorage.getItem("zgis.basemaps"));
    load
      .then((raw) => {
        if (disposed || !raw) return;
        const value = loadBasemapPreferences(raw);
        setServices(value.services);
        setBasemap(value.selected);
        setBasemapVisible(value.visible);
      })
      .catch(() => {
        configBlocked.current = true;
        setError("底图配置加载失败，已保留原配置。");
      })
      .finally(() => {
        if (!disposed) setConfigReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!configReady || configBlocked.current) return;
    const content = serializeBasemapPreferences(
      services,
      basemap,
      basemapVisible,
    );
    configQueue.current = configQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          if (desktop) await api.savePreferences(content);
          else sessionStorage.setItem("zgis.basemaps", content);
          configError.current = "";
        } catch {
          configError.current = "底图配置保存失败，请重试后退出。";
          setError(configError.current);
        }
      });
  }, [services, basemap, basemapVisible, configReady]);
  function changeServices(next: BasemapService[]) {
    setServices(next);
    setBasemap(selectBasemap(next, basemap));
  }
  function writeSnapshot(documents: DocumentLayer[]) {
    if (
      sessionRef.current?.selectedId &&
      !documents
        .find((l) => l.id === sessionRef.current?.layerId)
        ?.features.some((f) => f.id === sessionRef.current?.selectedId)
    ) {
      sessionRef.current = { ...sessionRef.current, selectedId: undefined };
      setSelectedId(undefined);
    }
    const content = snapshotWorkspace(
      documents,
      currentTree.current,
      sessionRef.current,
    );
    // Synchronous write-ahead copy covers termination before the native atomic write.
    try {
      localStorage.setItem("zgis.editRecovery", content);
    } catch {
      /* Native copy remains authoritative when browser quota is exceeded. */
    }
    const next = snapshotQueue.current
      .catch(() => {})
      .then(() => api.backup(content))
      .then(() => {
        try {
          if (localStorage.getItem("zgis.editRecovery") === content)
            localStorage.removeItem("zgis.editRecovery");
        } catch {
          /* The native snapshot is already durable. */
        }
      });
    snapshotQueue.current = next;
    return next;
  }
  async function requestExit() {
    if (
      busyRef.current ||
      !recoveryReady ||
      !configReady ||
      exitPending.current
    )
      return;
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
    if (
      Boolean(editingLayerId) ||
      cellDraft !== null ||
      (modal === "style" &&
        layerStyleDraft !== null &&
        (layerStyleDraft.color !== active?.color ||
          layerStyleDraft.opacity !== (active?.opacity ?? 1) ||
          layerStyleDraft.strokeWidth !== (active?.strokeWidth ?? 2))) ||
      (editable && (modal === "json" || modal === "wkt" || modal === "field"))
    ) {
      exitPreviousModal.current = modal;
      setModal("quit");
    } else await processExit();
  }
  function cancelExit() {
    if (busyRef.current) return;
    exitPending.current = false;
    openModal(exitPreviousModal.current);
  }
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    api
      .recover()
      .then((raw) => {
        if (disposed) return;
        raw = selectRecoverySnapshot(raw, null);
        try {
          raw = selectRecoverySnapshot(
            raw,
            localStorage.getItem("zgis.editRecovery"),
          );
        } catch {
          /* Native recovery remains available. */
        }
        if (raw) {
          const restored = restoreWorkspace(raw);
          setTree(restored.tree);
          if (restored.layers.length) {
            addLayers(restored.layers);
            restoringSession.current = restored.session;
            if (restored.session) setActiveId(restored.session.layerId);
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
      restoringSession.current ||
      exitPending.current ||
      busy
    )
      return;
    let content: string;
    try {
      content = snapshotWorkspace(
        currentLayers.current,
        currentTree.current,
        sessionRef.current,
      );
    } catch (reason) {
      setError("恢复副本保存失败：" + errorText(reason));
      return;
    }
    try {
      localStorage.setItem("zgis.editRecovery", content);
    } catch {
      /* Fall back to native recovery. */
    }
    const timer = setTimeout(() => {
      if (exitPending.current || busyRef.current) return;
      void writeSnapshot(currentLayers.current).catch(() =>
        setStatus("恢复副本保存失败"),
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [
    layers,
    tree,
    recoveryReady,
    modal,
    busy,
    editingLayerId,
    selectedId,
    tool,
    snapping,
    drawDraft,
    cellDraft,
    propertyText,
    wktText,
  ]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!desktop && (Boolean(editingLayerId) || cellDraft !== null)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [editingLayerId, cellDraft]);
  useEffect(() => {
    setPage(0);
    setSearch("");
    setSelectedId(undefined);
    setTool("select");
    setEditingLayerId(undefined);
    setTableEditing(false);
    exportSaveLayerId.current = undefined;
    setDrawDraft(null);
    const session = restoringSession.current;
    if (session && session.layerId === activeId) {
      restoringSession.current = undefined;
      setEditingLayerId(session.layerId);
      setSelectedId(session.selectedId);
      setTool(session.tool);
      setSnapping(session.snapping);
      setDrawDraft(session.drawDraft ?? null);
      setNodeCount(session.drawDraft?.coordinates.length ?? 0);
      setTableEditing(true);
      const layer = layers.find((l) => l.id === session.layerId);
      editingBaseline.current = layer
        ? {
            id: layer.id,
            features: session.history?.baseline?.features ?? layer.features,
            dirty: session.history?.baseline?.dirty ?? true,
            fieldNames:
              session.history?.baseline?.fieldNames ?? layer.fieldNames,
          }
        : undefined;
      if (session.history)
        histories.current.set(session.layerId, {
          past: session.history.undo,
          future: session.history.redo,
          pastFields: session.history.undoFieldNames,
          futureFields: session.history.redoFieldNames,
        });
      if (session.cellDraft && layer) {
        const draft = session.cellDraft;
        const original = layer.features.find((f) => f.id === draft.featureId)
          ?.properties[draft.field];
        setCellDraft({
          ...draft,
          layerId: layer.id,
          original,
          expanded: true,
          error: "",
        });
        setTableOpen(true);
        setModal("cell");
      }
      if (session.panelDraft) {
        restoringPanel.current = session.panelDraft;
        setSelectedId(session.panelDraft.featureId);
        setModal(session.panelDraft.kind);
        if (session.panelDraft.kind === "json")
          setPropertyText(session.panelDraft.text);
        else setWktText(session.panelDraft.text);
      }
      setStatus("已恢复编辑模式与草稿，请继续编辑并保存");
    }
  }, [activeId]);
  useEffect(() => {
    const panel = restoringPanel.current;
    if (panel) {
      if (selected?.id === panel.featureId) {
        if (panel.kind === "json") setPropertyText(panel.text);
        else setWktText(panel.text);
        restoringPanel.current = undefined;
      }
      return;
    }
    if (modal === "json" || modal === "wkt") return;
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
  async function runToolboxAnalysis(
    request: ProcessingRequest,
  ): Promise<ProcessingOutcome> {
    if (!desktop) throw new Error("空间分析需要桌面版，请在 zGIS 应用中运行");
    if (busyRef.current || exitPending.current || !recoveryReady)
      throw new Error("请等待当前操作完成后再运行分析");
    if (editingLayerId || cellDraft || drawDraft || gestureActive || modal)
      throw new Error("请先完成当前操作并保存退出编辑，再运行空间分析");
    const definition = getAnalysisTool(request.operation);
    if (!definition) throw new Error("未知分析工具");
    const source = currentLayers.current.find(
      (layer) => layer.id === request.sourceId,
    );
    const target = request.targetId
      ? currentLayers.current.find((layer) => layer.id === request.targetId)
      : undefined;
    if (!source || (request.targetId && !target))
      throw new Error("输入图层已移除，请重新选择");
    const input = request.selectedOnly
      ? source.id === activeId && selectedId
        ? source.features.filter((feature) => feature.id === selectedId)
        : []
      : source.features;
    if (!input.length) throw new Error("输入范围没有要素，请重新选择");
    const name = request.outputName.trim();
    if (!definition.report && (!name || name.length > 100))
      throw new Error("结果图层名称须为 1–100 个字符");
    busyRef.current = true;
    setBusy(true);
    const start = performance.now();
    setStatus(`正在运行${definition.label}…`);
    try {
      const raw = await api.runAnalysis(
        request.operation,
        request.parameters,
        input,
        target?.features,
      );
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("分析结果结构无效");
      const result = raw as Record<string, unknown>;
      if (
        result.type === "FeatureCollection" &&
        Array.isArray(result.features)
      ) {
        const features = importGeoJSON(JSON.stringify(result));
        const layer = makeLayer(
          /\.geojson$/i.test(name) ? name : `${name}.geojson`,
          features,
          "geojson",
          {
            displayName: name,
            dirty: true,
            warnings: [
              `${definition.label}结果；输入为当前已加载要素的独立副本，核对后可保存或导出。`,
            ],
          },
        );
        addLayers([layer]);
        setLayersOpen(true);
        setStatus(`${definition.label}完成：${features.length} 个结果要素`);
        return {
          featureCount: features.length,
          layerId: layer.id,
          layerName: name,
          durationMs: performance.now() - start,
        };
      }
      if (!["topology_check", "layer_summary"].includes(request.operation))
        throw new Error("分析未返回矢量结果");
      setStatus(`${definition.label}完成`);
      return { report: result, durationMs: performance.now() - start };
    } catch (reason) {
      setStatus(`${definition.label}失败`);
      throw reason;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function toggleToolbox() {
    if (busyRef.current) return;
    setToolboxMounted(true);
    setAgentOpen(false);
    setToolboxOpen((open) => !open);
  }
  function addLayers(imported: DocumentLayer[]) {
    if (cellDraft) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
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
    if (editingLayerId) {
      setError("请先保存并退出当前图层编辑，再打开文件");
      return;
    }
    if (cellDraft) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
    if (!files.length) return;
    setPendingFiles(files);
    if (files.some((f) => /\.(csv|geojson|json)$/i.test(f.name))) {
      openModal("import");
    } else await importSelected(files);
  }
  function edit(
    features: GeoFeature[],
    fieldNames = active?.fieldNames,
    schemaChanges = active?.schemaChanges,
  ) {
    if (!active || busy || !editable) return;
    const history = histories.current.get(active.id) ?? {
      past: [],
      future: [],
    };
    history.pastFields ??= history.past.map(() => active.fieldNames ?? []);
    history.pastSchemas ??= history.past.map(() => active.schemaChanges ?? []);
    history.past.push(active.features);
    (history.pastFields ??= []).push(active.fieldNames ?? []);
    history.pastSchemas.push(active.schemaChanges ?? []);
    if (history.past.length > 30) {
      history.past.shift();
      history.pastFields.shift();
      history.pastSchemas.shift();
    }
    history.future = [];
    history.futureFields = [];
    history.futureSchemas = [];
    histories.current.set(active.id, history);
    setLayers((old) =>
      old.map((l) =>
        l.id === active.id
          ? { ...l, features, fieldNames, schemaChanges, dirty: true }
          : l,
      ),
    );
    refreshHistory((n) => n + 1);
  }
  function onGeometry(feature: GeoFeature, insert: boolean) {
    if (!active || !editable || busy) return false;
    const errors = validateGeometry(feature.geometry);
    if (errors.length) {
      setError(errors.join("；"));
      return false;
    }
    if (
      insert &&
      active.geometryType &&
      feature.geometry?.type !== active.geometryType
    ) {
      setError(`当前图层仅接受 ${active.geometryType} 几何`);
      return false;
    }
    if (insert)
      feature = {
        ...feature,
        properties: Object.fromEntries(
          fields
            .filter(
              (field) =>
                !active.db?.columns.some(
                  (c) => c.name === field && (c.generated || c.hasDefault),
                ),
            )
            .map((field) => [field, ""]),
        ),
      };
    edit(
      insert
        ? [...active.features, feature]
        : active.features.map((f) =>
            f.id === feature.id ? { ...f, geometry: feature.geometry } : f,
          ),
    );
    setSelectedId(feature.id);
    setError("");
    setStatus(
      insert
        ? "已新增要素，继续绘制或保存编辑"
        : "几何已更新，可撤销或保存编辑",
    );
    return true;
  }
  function history(direction: "undo" | "redo") {
    if (!active || busy || !editable || cellDraft || drawDraft || gestureActive)
      return;
    const h = histories.current.get(active.id);
    if (!h) return;
    h.pastFields ??= h.past.map(() => active.fieldNames ?? []);
    h.futureFields ??= h.future.map(() => active.fieldNames ?? []);
    h.pastSchemas ??= h.past.map(() => active.schemaChanges ?? []);
    h.futureSchemas ??= h.future.map(() => active.schemaChanges ?? []);
    const from = direction === "undo" ? h.past : h.future;
    const to = direction === "undo" ? h.future : h.past;
    const next = from.pop();
    const fromFields = direction === "undo" ? h.pastFields : h.futureFields;
    const nextFields = fromFields?.pop() ?? active.fieldNames;
    const nextSchema =
      (direction === "undo" ? h.pastSchemas : h.futureSchemas).pop() ?? [];
    if (next) {
      if (selectedId && !next.some((f) => f.id === selectedId))
        setSelectedId(undefined);
      to.push(active.features);
      if (direction === "undo")
        (h.futureFields ??= []).push(active.fieldNames ?? []);
      else (h.pastFields ??= []).push(active.fieldNames ?? []);
      (direction === "undo" ? h.futureSchemas : h.pastSchemas).push(
        active.schemaChanges ?? [],
      );
      setLayers((old) =>
        old.map((l) =>
          l.id === active.id
            ? {
                ...l,
                features: next,
                fieldNames: nextFields,
                schemaChanges: nextSchema,
                dirty:
                  editingBaseline.current?.id === active.id
                    ? editingBaseline.current.dirty ||
                      JSON.stringify(next) !==
                        JSON.stringify(editingBaseline.current.features) ||
                      JSON.stringify(nextFields ?? []) !==
                        JSON.stringify(editingBaseline.current.fieldNames ?? [])
                    : true,
              }
            : l,
        ),
      );
      refreshHistory((n) => n + 1);
    }
  }
  function beginCell(feature: GeoFeature, field: string, fromMenu = false) {
    if (
      !active ||
      busy ||
      cellDraft ||
      drawDraft ||
      gestureActive ||
      (fromMenu ? !canEdit : !editable || !tableEditing)
    )
      return;
    if (fromMenu) {
      if (!editing) beginEditing();
      else setTableEditing(true);
    }
    const original = feature.properties[field];
    const expanded =
      (typeof original === "object" && original !== null) ||
      (typeof original === "string" &&
        (original.length > 80 || original.includes("\n")));
    selectFeature(feature.id);
    setTool("select");
    setCellDraft({
      layerId: active.id,
      featureId: feature.id,
      field,
      original,
      text: cellText(original),
      isNull: false,
      expanded,
      error: "",
    });
    if (expanded) openModal("cell");
  }
  function cancelCell() {
    const field = cellDraft?.field;
    const featureId = cellDraft?.featureId;
    setCellDraft(null);
    if (modal === "cell") setModal(null);
    if (field && featureId)
      requestAnimationFrame(() => focusCell(featureId, field));
  }
  function focusCell(featureId: string, field: string) {
    const cells = document.querySelectorAll<HTMLElement>(".attribute-cell");
    Array.from(cells)
      .find((c) => c.dataset.feature === featureId && c.dataset.field === field)
      ?.focus();
  }
  function commitCell(direction = 0) {
    if (
      !cellDraft ||
      !active ||
      cellDraft.layerId !== active.id ||
      !editable ||
      busy
    )
      return;
    try {
      const value = parseCellValue(
        cellDraft.text,
        cellDraft.original,
        cellDraft.isNull,
      );
      const feature = active.features.find((f) => f.id === cellDraft.featureId);
      if (!feature) throw new Error("要素已不存在，请取消编辑后重新选择");
      if (
        JSON.stringify(value) !==
        JSON.stringify(feature.properties[cellDraft.field])
      )
        edit(
          active.features.map((f) =>
            f.id === feature.id
              ? {
                  ...f,
                  properties: { ...f.properties, [cellDraft.field]: value },
                }
              : f,
          ),
        );
      const fieldIndex = displayFields.indexOf(cellDraft.field);
      const nextField = displayFields[fieldIndex + direction];
      const oldField = cellDraft.field;
      setCellDraft(null);
      if (modal === "cell") setModal(null);
      setError("");
      setStatus("属性已更新，源文件需保存");
      requestAnimationFrame(() =>
        focusCell(feature.id, direction && nextField ? nextField : oldField),
      );
    } catch (reason) {
      setCellDraft((d) => (d ? { ...d, error: errorText(reason) } : null));
    }
  }
  function renderCellActions(expanded = false) {
    if (!cellDraft) return null;
    return (
      <>
        <label className="cell-null">
          <input
            type="checkbox"
            aria-label="设为 NULL"
            checked={cellDraft.isNull}
            disabled={busy}
            onChange={(e) =>
              setCellDraft((d) =>
                d ? { ...d, isNull: e.target.checked, error: "" } : null,
              )
            }
          />
          NULL
        </label>
        {!expanded && (
          <IconButton
            label="展开单元格编辑"
            disabled={busy}
            onClick={() => {
              setCellDraft((d) => (d ? { ...d, expanded: true } : null));
              openModal("cell");
            }}
          >
            <Square />
          </IconButton>
        )}
      </>
    );
  }
  function renderCellInput(expanded = false) {
    if (!cellDraft) return null;
    const label = `属性 ${cellDraft.field}`;
    const update = (text: string) =>
      setCellDraft((d) => (d ? { ...d, text, error: "" } : null));
    return (
      <div
        className={expanded ? "cell-editor" : "cell-editor cell-editor-inline"}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelCell();
          } else if (
            e.key === "Enter" &&
            (!expanded || e.ctrlKey || e.metaKey)
          ) {
            e.preventDefault();
            commitCell();
          } else if (e.key === "Tab" && !expanded) {
            e.preventDefault();
            commitCell(e.shiftKey ? -1 : 1);
          }
        }}
      >
        {typeof cellDraft.original === "boolean" ? (
          <select
            autoFocus
            aria-label={label}
            value={cellDraft.isNull ? "" : cellDraft.text}
            disabled={busy || cellDraft.isNull}
            onChange={(e) => update(e.target.value)}
          >
            {cellDraft.isNull && <option value="">NULL</option>}
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : expanded ? (
          <textarea
            autoFocus
            aria-label={label}
            value={cellDraft.text}
            disabled={busy || cellDraft.isNull}
            onChange={(e) => update(e.target.value)}
          />
        ) : (
          <input
            autoFocus
            aria-label={label}
            aria-invalid={Boolean(cellDraft.error)}
            value={cellDraft.isNull ? "NULL" : cellDraft.text}
            disabled={busy || cellDraft.isNull}
            onChange={(e) => update(e.target.value)}
          />
        )}
        {expanded && renderCellActions(true)}
      </div>
    );
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
      setPropertyText(JSON.stringify(value, null, 2));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  function applyWkt() {
    if (!selected || !active || !editable || busy) return;
    try {
      const json = geometryFromWkt(wktText);
      if (active.geometryType && json?.type !== active.geometryType)
        throw new Error(`当前图层仅接受 ${active.geometryType} 几何`);
      edit(
        active.features.map((f) =>
          f.id === selected.id ? { ...f, geometry: json } : f,
        ),
      );
      setStatus("几何已更新");
      setWktText(json ? geometryToWkt(json) : "");
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  function beginEditing() {
    if (!active || !canEdit || busy || cellDraft) return;
    editingBaseline.current = {
      id: active.id,
      features: active.features,
      dirty: active.dirty,
      fieldNames: active.fieldNames,
    };
    setEditingLayerId(active.id);
    setTableEditing(true);
    setTool("select");
  }
  function finishEditing(id: string) {
    setEditingLayerId((current) => (current === id ? undefined : current));
    setTableEditing(false);
    setTool("pan");
    exportSaveLayerId.current = undefined;
    histories.current.delete(id);
    refreshHistory((n) => n + 1);
    sessionRef.current = undefined;
    setDrawDraft(null);
    setNodeCount(0);
  }
  async function save(asNew = false, stopEditing = false) {
    if (
      drawDraft ||
      gestureActive ||
      (editable && (modal === "json" || modal === "wkt"))
    ) {
      setError("请先完成或取消当前绘制、几何或属性草稿，再保存");
      return;
    }
    if (cellDraft) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
    if (!active) return;
    saveStopsEditing.current = stopEditing;
    if (Boolean(active.db)) {
      await task(async () => {
        await commitLayer(active);
        if (stopEditing) finishEditing(active.id);
        else markEditingSaved(active.id);
        if (desktop) await writeSnapshot(currentLayers.current);
      });
      return;
    }
    if (active.sourceKind === "shp" && asNew) {
      await task(async () => {
        const result = await api.saveShapefileFolder(
          active.features,
          (active.displayName ?? active.name).replace(/\.[^.]+$/, "") + ".shp",
          active.originalCrs ?? "EPSG:4326",
        );
        if (!result) {
          setStatus("已取消另存，工作区仍保留");
          return;
        }
        const updated = {
          ...active,
          sourceId: result.sourceId,
          name: result.name,
          dirty: false,
          restored: false,
        };
        setLayers((old) =>
          old.map((layer) => (layer.id === active.id ? updated : layer)),
        );
        currentLayers.current = currentLayers.current.map((layer) =>
          layer.id === active.id ? updated : layer,
        );
        if (editing) {
          if (stopEditing) finishEditing(active.id);
          else markEditingSaved(active.id);
        }
        setStatus("另存完成：SHP 文件组");
        if (desktop) await writeSnapshot(currentLayers.current);
      });
      return;
    }
    if (active.sourceKind === "shp") {
      exportSaveLayerId.current = editing ? active.id : undefined;
      if (desktop) {
        setExportMode("shp");
        setExportFilename(
          (active.displayName ?? active.name).replace(/\.[^.]+$/, "") + ".zip",
        );
        setError("");
        setModal("export");
        return;
      }
      openModal("export");
      return;
    }
    await task(async () => {
      const saved = await saveDocument(active, asNew);
      if (!saved) return;
      if (editing) {
        if (stopEditing) finishEditing(active.id);
        else markEditingSaved(active.id);
      }
      if (desktop) await writeSnapshot(currentLayers.current);
    });
  }
  function markEditingSaved(id: string) {
    const layer = currentLayers.current.find((l) => l.id === id);
    if (layer)
      editingBaseline.current = {
        id,
        features: layer.features,
        dirty: false,
        fieldNames: layer.fieldNames,
      };
    histories.current.delete(id);
    refreshHistory((n) => n + 1);
    if (sessionRef.current)
      sessionRef.current = { ...sessionRef.current, history: undefined };
    setStatus("保存完成，可继续编辑");
  }
  function activateLayer(id: string) {
    if (cellDraft || gestureActive) return false;
    if (editingLayerId && id !== editingLayerId) {
      setError("请先保存并退出当前图层编辑，再切换图层");
      return false;
    }
    setActiveId(id);
    return true;
  }
  function requestNewLayer(groupId?: string) {
    if (editingLayerId) {
      setError("请先保存并退出当前图层编辑，再新建图层");
      return;
    }
    insertionGroup.current = groupId;
    openModal("new-layer");
  }
  function cancelDrawing() {
    setCancelNonce((n) => n + 1);
    setDrawDraft(null);
    setNodeCount(0);
    setTool("select");
  }
  async function saveDocument(
    doc: DocumentLayer,
    asNew = false,
  ): Promise<DocumentLayer | null> {
    const content =
      doc.sourceKind === "csv"
        ? exportCsv(doc.features, {
            ...doc.csvConfig,
            mode: doc.csvConfig?.wktColumn ? "wkt" : "xy",
            crs: doc.originalCrs,
          })
        : exportGeoJSON(doc.features, asNew ? doc.originalCrs : undefined);
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
        asNew ? filename.split(".").pop()?.toLowerCase() : undefined,
      );
      if (!result) return null;
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
      try {
        if (recoveryBlocked.current)
          throw new Error(
            "恢复文件加载失败，退出前请先处理恢复错误，避免覆盖原副本。",
          );
        importAnalysisRef.current(true);
        await writeSnapshot(currentLayers.current);
        await configQueue.current;
        if (configError.current) throw new Error(configError.current);
        if (desktop) {
          setModal(null);
          await getCurrentWindow().destroy();
        } else {
          exitPending.current = false;
          setModal(null);
        }
      } catch (reason) {
        exitPending.current = false;
        throw reason;
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
        setStatus("导出完成：SHP ZIP 已另存");
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
      if (exportSaveLayerId.current === active.id && exportMode !== "postgis") {
        const updated = { ...active, dirty: false, restored: false };
        setLayers((old) =>
          old.map((layer) => (layer.id === active.id ? updated : layer)),
        );
        currentLayers.current = currentLayers.current.map((layer) =>
          layer.id === active.id ? updated : layer,
        );
        if (saveStopsEditing.current) finishEditing(active.id);
        else markEditingSaved(active.id);
      }
      setModal(null);
      if (desktop) await writeSnapshot(currentLayers.current);
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
        engine: dbEngine,
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
        dbEngine,
        {
          fieldNames: layer.columns
            .filter(
              (c) =>
                c.name !== layer.geometryColumn &&
                !/geometry|geography/i.test(c.type),
            )
            .map((c) => c.name),
          db: {
            connectionId,
            ...layer,
            keyColumns: result.writable === false ? [] : layer.keyColumns,
          },
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
    const schemaChanges = doc.schemaChanges ?? [];
    if (!changes.length && !schemaChanges.length) {
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
      await api.commit(doc.db.connectionId, doc.db, changes, schemaChanges);
    } catch (reason) {
      if (
        /结果待核对|字段结构已提交|未确认|超时|回滚结果/.test(errorText(reason))
      )
        blockRetry(
          "提交结果待核对，请重新载入来源后核对数据；当前副本禁止重复提交。",
        );
      throw reason;
    }
    const nextColumns = doc.db.columns.map((c) => ({ ...c }));
    for (const change of schemaChanges) {
      if (change.kind === "add")
        nextColumns.push({
          name: change.name,
          type: "character varying(255)",
          nullable: true,
        });
      else if (change.kind === "rename") {
        const c = nextColumns.find((c) => c.name === change.name);
        if (c) c.name = change.newName!;
      } else {
        const index = nextColumns.findIndex((c) => c.name === change.name);
        if (index >= 0) nextColumns.splice(index, 1);
      }
    }
    const nextDb = { ...doc.db, columns: nextColumns };
    const result = await api
      .query(
        doc.db.connectionId,
        nextDb,
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
      db: nextDb,
      schemaChanges: [],
      fieldNames: nextColumns
        .filter(
          (c) =>
            c.name !== nextDb.geometryColumn &&
            !/geometry|geography/i.test(c.type),
        )
        .map((c) => c.name),
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
  async function closeLayer(targetId = active?.id) {
    if (targetId === editingLayerId) {
      setError("请先保存并退出当前图层编辑，再移除图层");
      return;
    }
    if (cellDraft) {
      setError("请先应用或取消当前单元格编辑");
      return;
    }
    if (!targetId || !layers.some((layer) => layer.id === targetId)) return;
    await task(async () => {
      const next = layers.filter((l) => l.id !== targetId);
      if (desktop) await writeSnapshot(next);
      setLayers(next);
      currentLayers.current = next;
      histories.current.delete(targetId);
      dbBaselines.current.delete(targetId);
      dbBounds.current.delete(targetId);
      setActiveId(next[0]?.id);
      setModal(null);
    });
  }
  const fields = [
    ...new Set([
      ...(active?.fieldNames ?? []),
      ...(active?.features.flatMap((f) => Object.keys(f.properties)) ?? []),
    ]),
  ];
  const savedOrder = columnOrders[activeId ?? ""] ?? [];
  const displayFields = [
    ...savedOrder.filter((field) => fields.includes(field)),
    ...fields.filter((field) => !savedOrder.includes(field)),
  ];
  const columnKeys = ["index", "geometry", ...displayFields.map((field) => `field:${field}`)];
  const widths = columnWidths[activeId ?? ""];
  function resetColumnWidths() {
    if (!activeId) return;
    setColumnWidths((old) => {
      const next = { ...old };
      delete next[activeId];
      return next;
    });
  }
  function resizeColumn(key: string, width: number, header: HTMLElement) {
    if (!activeId) return;
    const measured = Object.fromEntries(
      [...header.parentElement!.children].map((el, index) => [columnKeys[index], el.getBoundingClientRect().width]),
    );
    setColumnWidths((old) => ({
      ...old,
      [activeId]: { ...measured, ...old[activeId], [key]: Math.max(48, width) },
    }));
  }
  function renderColumnResizer(key: string, label: string) {
    return (
      <span
        className="column-resizer"
        role="separator"
        aria-label={`调整 ${label} 列宽`}
        aria-orientation="vertical"
        aria-valuemin={48}
        aria-valuenow={widths?.[key] == null ? undefined : Math.round(widths[key])}
        tabIndex={0}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); resetColumnWidths(); }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.focus();
          columnResize.current = { x: e.clientX, width: e.currentTarget.parentElement!.getBoundingClientRect().width };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!columnResize.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
          resizeColumn(key, columnResize.current.width + e.clientX - columnResize.current.x, e.currentTarget.parentElement!);
        }}
        onLostPointerCapture={() => { columnResize.current = null; }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Home") { e.preventDefault(); resetColumnWidths(); }
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          e.stopPropagation();
          const header = e.currentTarget.parentElement!;
          resizeColumn(key, header.getBoundingClientRect().width + (e.key === "ArrowRight" ? 16 : -16), header);
        }}
      />
    );
  }
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
  const effectivePage = Math.min(page, totalPages - 1);
  const shown = filtered.slice(
    effectivePage * pageSize,
    (effectivePage + 1) * pageSize,
  );
  useEffect(() => {
    if (page !== effectivePage) setPage(effectivePage);
  }, [page, effectivePage]);
  const selectedRow = useRef<HTMLTableRowElement>(null);
  useLayoutEffect(() => {
    document
      .querySelector(".table-scroll")
      ?.scrollTo({ top: 0, behavior: "instant" });
  }, [activeId, effectivePage, search, tableOpen]);
  useEffect(() => {
    if (!tableOpen || !selectedId) return;
    const index = filtered.findIndex((feature) => feature.id === selectedId);
    if (index >= 0) setPage(Math.floor(index / pageSize));
  }, [selectedId, activeId, tableOpen, tableLocateNonce]);
  useLayoutEffect(() => {
    const row = selectedRow.current;
    const viewport = row?.closest<HTMLDivElement>(".table-scroll");
    if (
      !row ||
      !viewport ||
      !tableOpen ||
      cellDraft ||
      context?.kind === "record" ||
      context?.kind === "map"
    )
      return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout>;
    const center = () => {
      const headerHeight = viewport.querySelector("thead")?.offsetHeight ?? 0;
      const rowBounds = row.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const target =
        viewport.scrollTop +
        rowBounds.top +
        rowBounds.height / 2 -
        viewportBounds.top -
        viewport.clientTop -
        (viewport.clientHeight + headerHeight) / 2;
      viewport.scrollTo({ top: target, behavior: "instant" });
    };
    // A table click may be the first half of a double-click; do not move its
    // target before the second click. Map selections position immediately.
    const schedule = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      if (centerImmediately.current) center();
      else
        timer = setTimeout(() => {
          frame = requestAnimationFrame(center);
        }, 400);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const header = viewport.querySelector("thead");
    if (header) observer.observe(header);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [
    selectedId,
    page,
    tableOpen,
    tableLocateNonce,
    Boolean(cellDraft),
    tableMaximized,
    context?.kind,
  ]);
  const h = active ? histories.current.get(active.id) : undefined;
  const canEdit =
    Boolean(active) &&
    (!active?.db ||
      (Boolean(active.db?.keyColumns.length) &&
        !uncertainDocs.has(active.id!)));
  const editable = canEdit && editing;
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
  useEffect(() => setContext(undefined), [activeId, modal, busy]);

  function copyText(text: string) {
    if (!navigator.clipboard) {
      setError("无法访问剪贴板，请选中文本后复制");
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => setStatus("已复制"),
      () => setError("无法访问剪贴板，请选中文本后复制"),
    );
  }
  function openRecordContext(
    anchor: ContextMenuAnchor,
    feature: GeoFeature,
    field?: string,
  ) {
    if (!active) return;
    if (
      !busy &&
      !cellDraft &&
      (tool === "pan" || tool === "select" || tool === "modify")
    )
      selectFeature(feature.id);
    setContext({
      kind: "record",
      anchor,
      layerId: active.id,
      featureId: feature.id,
      field,
    });
  }
  const contextFeature =
    context &&
    (context.kind === "record" || context.kind === "map") &&
    context.layerId === activeId
      ? active?.features.find((feature) => feature.id === context.featureId)
      : undefined;
  const contextBlocked = busy || Boolean(cellDraft);
  const sketching =
    tool === "Point" || tool === "LineString" || tool === "Polygon";
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.target as Element)?.closest(
          "input, textarea, select, [contenteditable=true]",
        ) ||
        modal ||
        busy ||
        gestureActive
      )
        return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          if (drawDraft && !event.shiftKey) setUndoNodeNonce((n) => n + 1);
          else history(event.shiftKey ? "redo" : "undo");
        } else if (event.key.toLowerCase() === "y") {
          event.preventDefault();
          history("redo");
        } else if (event.key.toLowerCase() === "s") {
          event.preventDefault();
          void save();
        }
      } else if (
        event.key === "Delete" &&
        editable &&
        selected &&
        !drawDraft &&
        !cellDraft
      ) {
        event.preventDefault();
        openModal("delete");
      } else if (
        event.key === "Escape" &&
        editable &&
        sketching &&
        !drawDraft
      ) {
        event.preventDefault();
        setTool("select");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    active,
    selected,
    editable,
    busy,
    modal,
    cellDraft,
    drawDraft,
    gestureActive,
    tool,
  ]);
  const contextItems: ContextMenuItem[] = [];
  function contextAction(
    id: string,
    label: string,
    action: () => void,
    disabled = false,
    danger = false,
    title?: string,
  ) {
    contextItems.push({ id, label, onSelect: action, disabled, danger, title });
  }
  if (context?.kind === "text") {
    contextAction("copy-text", "复制", () => copyText(context.text));
  } else if (context?.kind === "field") {
    contextAction("copy-name", "复制字段名", () => copyText(context.field));
    contextAction("copy-summary", "复制字段摘要", () =>
      copyText(`${context.field}：${fieldSummary(context.field)}`),
    );
    contextItems.push({ id: "field-separator", separator: true });
    contextAction(
      "add-field",
      "添加字段…",
      () => {
        if (!editing) beginEditing();
        openModal("field");
      },
      contextBlocked || sketching || !canEdit,
      false,
      undefined,
    );
    contextAction(
      "rename-field",
      "重命名字段…",
      () => {
        if (!editing) beginEditing();
        setFieldTarget(context.field);
        setNewField(context.field);
        openModal("rename-field");
      },
      contextBlocked || sketching || !canEdit,
    );
    contextAction(
      "delete-field",
      "删除字段…",
      () => {
        if (!editing) beginEditing();
        setFieldTarget(context.field);
        openModal("delete-field");
      },
      contextBlocked || sketching || !canEdit,
      true,
    );
  } else if (context) {
    if (context.kind === "map") {
      contextAction("copy-coordinate", "复制经纬度", () =>
        copyText(
          context.coordinate.map((value) => value.toFixed(6)).join(", "),
        ),
      );
      contextAction(
        "fit-layer",
        "缩放至图层",
        () => setFitNonce((n) => n + 1),
        !active?.features.some((feature) => feature.geometry) ||
          contextBlocked ||
          sketching,
      );
      contextAction(
        "open-table",
        "打开属性表",
        () => {
          setTableOpen(true);
          setTableMaximized(false);
        },
        !active || contextBlocked,
      );
      if (sketching) {
        contextItems.push({ id: "draw-separator", separator: true });
        contextAction(
          "finish-draw",
          "完成绘制",
          () => setFinishNonce((n) => n + 1),
          !editable ||
            busy ||
            nodeCount <
              (tool === "Polygon" ? 3 : tool === "LineString" ? 2 : 1),
        );
        contextAction("cancel-draw", "取消绘制", cancelDrawing, busy);
      } else {
        contextItems.push({ id: "navigation-separator", separator: true });
        contextAction("pan", "手形平移", () => setTool("pan"), contextBlocked);
        contextAction(
          "select",
          "选择要素",
          () => setTool("select"),
          contextBlocked || !active,
        );
        contextAction(
          "clear-selection",
          "清除选择",
          () => selectFeature(undefined),
          contextBlocked || !selected,
        );
      }
    }
    if (contextFeature) {
      contextItems.push({ id: "feature-separator", separator: true });
      const feature = contextFeature;
      const featureBlocked =
        contextBlocked || sketching || feature.id !== selectedId;
      if (context.kind === "record" && context.field !== undefined) {
        const field = context.field;
        contextAction("copy-value", "复制单元格值", () =>
          copyText(
            feature.properties[field] === null
              ? "NULL"
              : stringify(feature.properties[field]),
          ),
        );
        contextAction(
          "edit-cell",
          "编辑单元格",
          () => beginCell(feature, field, true),
          featureBlocked || !canEdit,
          false,
          !canEdit
            ? "当前来源只读"
            : cellDraft
              ? "请先应用或取消当前编辑"
              : undefined,
        );
      }
      contextAction(
        "fit-feature",
        "定位到要素",
        () => setFeatureFitNonce((n) => n + 1),
        featureBlocked || !feature.geometry,
      );
      contextAction(
        "json",
        "JSON 属性…",
        () => openModal("json"),
        featureBlocked,
      );
      contextAction("wkt", "WKT 几何…", () => openModal("wkt"), featureBlocked);
      contextAction("copy-properties", "复制属性 JSON", () =>
        copyText(JSON.stringify(feature.properties, null, 2)),
      );
      contextAction(
        "copy-wkt",
        "复制 WKT",
        () => copyText(geometryToWkt(feature.geometry!)),
        !feature.geometry,
      );
      contextItems.push({ id: "edit-separator", separator: true });
      contextAction(
        "edit-vertices",
        "编辑顶点",
        () => {
          if (!editing) beginEditing();
          setTool("modify");
        },
        featureBlocked || !canEdit || !feature.geometry,
      );
      contextAction(
        "delete-feature",
        "删除要素…",
        () => {
          if (!editing) beginEditing();
          openModal("delete");
        },
        featureBlocked || !canEdit,
        true,
        !canEdit ? "当前来源只读" : undefined,
      );
    }
  }
  return (
    <ErrorContext.Provider value={error}>
      <div
        className="app"
        onContextMenu={(event) => {
          const target = event.target as Element;
          if (nativeTextTarget(target) || target.closest(".app-header")) return;
          const textTarget = target.closest(
            "pre, code, .inline-error, .warning, .error-banner, .form-note",
          );
          if (!textTarget?.textContent?.trim()) return;
          event.preventDefault();
          setContext({
            kind: "text",
            text: textTarget.textContent,
            anchor: {
              x: event.clientX,
              y: event.clientY,
              returnFocus: document.activeElement as HTMLElement,
            },
          });
        }}
      >
        {context && (
          <ContextMenu
            anchor={context.anchor}
            label={
              context.kind === "map"
                ? "地图操作"
                : context.kind === "record"
                  ? "要素操作"
                  : context.kind === "field"
                    ? "字段操作"
                    : "文本操作"
            }
            items={contextItems}
            onClose={() => setContext(undefined)}
          />
        )}
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
              <button onClick={() => requestNewLayer()} disabled={busy}>
                <Plus />
                新建
              </button>
              <button onClick={openFiles} disabled={busy}>
                <FolderOpen />
                打开
              </button>
              <button
                onClick={() => void save(true)}
                disabled={!active || busy || Boolean(active.db)}
              >
                <Save />
                另存为
              </button>
              <hr />
              <button
                disabled={!active || busy}
                onClick={() => openModal("export")}
              >
                <Download />
                导出为
              </button>
            </HeaderMenu>
            <HeaderMenu label="数据">
              <button
                onClick={() => {
                  insertionGroup.current = undefined;
                  requestSources("mysql");
                }}
                disabled={!desktop || busy}
              >
                <Database />
                Mysql 数据源
              </button>
              <button onClick={openSources} disabled={!desktop || busy}>
                <Database />
                PostGIS 数据源
              </button>
            </HeaderMenu>
            <button
              ref={toolboxTrigger}
              className="quiet"
              aria-label="工具"
              aria-pressed={toolboxOpen}
              disabled={busy}
              onClick={toggleToolbox}
            >
              工具
            </button>
            <button
              className="quiet"
              aria-label="设置"
              aria-pressed={modal === "settings"}
              disabled={busy || !configReady}
              onClick={() => {
                setSettingCategory("appearance");
                openModal("settings");
              }}
            >
              设置
            </button>
          </nav>
          <div
            className="document-title"
            title={active?.displayName ?? active?.name}
          >
            {active?.displayName ?? active?.name ?? ""}
            {active?.dirty && <span className="dirty-dot" title="未保存" />}
          </div>
          <div className="header-actions">
            {desktop && modal !== "settings" && (
              <>
                <IconButton
                  label="Codex Agent"
                  active={agentOpen}
                  disabled={busy}
                  onClick={() => {
                    setToolboxOpen(false);
                    setAgentOpen((v) => !v);
                  }}
                >
                  <Bot />
                </IconButton>
              </>
            )}
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
                <Minus />
              </IconButton>
              <IconButton
                label="最大化 / 还原"
                onClick={() =>
                  void getCurrentWindow()
                    .toggleMaximize()
                    .catch((reason) => setError(errorText(reason)))
                }
              >
                <Square />
              </IconButton>
              <IconButton
                label="关闭窗口"
                disabled={busy || !recoveryReady}
                onClick={() => void requestExit()}
              >
                <X />
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
          hidden={
            modal === "settings" ||
            modal === "postgis-manager" ||
            modal === "mysql-manager"
          }
          className="workspace"
          ref={workspaceElement}
          style={
            {
              "--layer-panel-width": `${shownLayerPanelWidth}px`,
              "--right-sidebar-width": `${shownSidebarWidth}px`,
            } as CSSProperties
          }
          data-layers={layersOpen}
          data-sidebar={rightSidebarOpen}
        >
          <aside className="layers-panel" hidden={!layersOpen}>
            <div
              className="layer-panel-resizer"
              role="separator"
              aria-label="调整图层栏宽度"
              aria-orientation="vertical"
              aria-valuenow={shownLayerPanelWidth}
              aria-valuemin={200}
              aria-valuemax={layerPanelMaxWidth}
              tabIndex={0}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                setLayerPanelWidth(
                  e.key === "Home"
                    ? 200
                    : e.key === "End"
                      ? layerPanelMaxWidth
                      : Math.max(
                          200,
                          Math.min(
                            layerPanelMaxWidth,
                            shownLayerPanelWidth +
                              (e.key === "ArrowRight" ? 20 : -20),
                          ),
                        ),
                );
              }}
              onPointerDown={(e) => {
                if (e.button === 0) {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                }
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const left =
                  workspaceElement.current?.getBoundingClientRect().left ?? 0;
                setLayerPanelWidth(
                  Math.max(
                    200,
                    Math.min(layerPanelMaxWidth, Math.round(e.clientX - left)),
                  ),
                );
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
            />

            <LayerTree
              tree={reconcileTree(
                tree,
                layers.map((l) => l.id),
              )}
              layers={layers}
              activeId={activeId}
              busy={busy || Boolean(cellDraft)}
              desktop={desktop}
              readonlyIds={layers
                .filter(
                  (l) =>
                    Boolean(l.db) &&
                    (!l.db?.keyColumns.length || uncertainDocs.has(l.id)),
                )
                .map((l) => l.id)}
              onSelect={(id) => {
                if (cellDraft) return;
                if (!activateLayer(id)) return;
              }}
              onProperties={(id) => {
                if (cellDraft || busy) return;
                if (!layers.some((l) => l.id === id)) return;
                if (!activateLayer(id)) return;
                openModal("layer");
              }}
              onStyle={(id) => {
                if (cellDraft || busy) return;
                const layer = layers.find((l) => l.id === id);
                if (!layer) return;
                if (!activateLayer(id)) return;
                setLayerStyleDraft({
                  layerId: id,
                  color: layer.color,
                  opacity: layer.opacity ?? 1,
                  strokeWidth: layer.strokeWidth ?? 2,
                });
                openModal("style");
              }}
              onAliasLayer={(id, value) => {
                const displayName = value.trim();
                if (
                  cellDraft ||
                  busy ||
                  !displayName ||
                  displayName.length > 120
                )
                  return;
                setLayers((old) =>
                  old.map((l) =>
                    l.id === id
                      ? {
                          ...l,
                          displayName:
                            displayName === l.name ? undefined : displayName,
                        }
                      : l,
                  ),
                );
                setStatus("图层别名已设置");
              }}
              onRenameLayer={(id, name) => {
                const layer = layers.find((l) => l.id === id);
                if (!layer?.sourceId || busy || cellDraft) return;
                void task(async () => {
                  const renamed = await api.renameSourceFile(
                    layer.sourceId!,
                    name,
                  );
                  const next = currentLayers.current.map((l) =>
                    l.sourceId === layer.sourceId
                      ? { ...l, name: renamed.name }
                      : l,
                  );
                  setLayers(next);
                  currentLayers.current = next;
                  if (desktop) await writeSnapshot(next);
                  setStatus("文件已重命名");
                });
              }}
              onNewFile={(group) => requestNewLayer(group)}
              onDeleteGroup={(id) => {
                if (busy || cellDraft) return;
                const ids = new Set(treeGroupLayerIds(tree, id));
                if (editingLayerId && ids.has(editingLayerId)) {
                  setError("请先保存并退出分组内图层编辑，再删除分组");
                  return;
                }
                void task(async () => {
                  const next = currentLayers.current.filter(
                    (l) => !ids.has(l.id),
                  );
                  setTree((old) => deleteTreeGroup(old, id));
                  setLayers(next);
                  currentLayers.current = next;
                  for (const layerId of ids) {
                    histories.current.delete(layerId);
                    dbBaselines.current.delete(layerId);
                    dbBounds.current.delete(layerId);
                  }
                  if (activeId && ids.has(activeId)) setActiveId(next[0]?.id);
                });
              }}
              onFit={(id) => {
                if (cellDraft) return;
                if (!activateLayer(id)) return;
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
              onAddMysql={(group) => {
                insertionGroup.current = group;
                requestSources("mysql");
              }}
              hasMysqlSources={mysqlSourceCount > 0}
              hasPostgisSources={postgisSourceCount > 0}
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
              onOpenTable={(id) => {
                if (busy || cellDraft) return;
                if (!activateLayer(id)) return;
                setTableOpen(true);
                setTableMaximized(false);
              }}
              onRemoveLayer={(id) => {
                if (busy || cellDraft) return;
                const layer = layers.find((item) => item.id === id);
                if (!layer) return;
                if (!activateLayer(id)) return;
                if (layer.dirty) openModal("close");
                else void closeLayer(id);
              }}
              onDissolveGroup={(id) => {
                if (busy || cellDraft) return;
                setTree((old) => dissolveTreeGroup(old, id));
              }}
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
                  {tools
                    .filter(
                      (item) =>
                        editing ||
                        item.value === "select" ||
                        item.value === "pan",
                    )
                    .map((item) => (
                      <IconButton
                        key={item.value}
                        label={item.label}
                        disabled={
                          !active ||
                          (item.value !== "select" &&
                            item.value !== "pan" &&
                            !editable) ||
                          Boolean(cellDraft) ||
                          gestureActive ||
                          busy ||
                          (active?.geometryType !== undefined &&
                            ["Point", "LineString", "Polygon"].includes(
                              item.value,
                            ) &&
                            item.value !== active.geometryType)
                        }
                        active={tool === item.value}
                        onClick={() => {
                          if (drawDraft && item.value !== tool) {
                            setError("请先完成或取消当前绘制");
                            return;
                          }
                          setTool(item.value);
                        }}
                      >
                        <item.icon />
                      </IconButton>
                    ))}
                  {editing && (
                    <IconButton
                      label="删除选中要素"
                      disabled={
                        !selected ||
                        !editable ||
                        busy ||
                        Boolean(cellDraft) ||
                        Boolean(drawDraft) ||
                        gestureActive
                      }
                      onClick={() => openModal("delete")}
                    >
                      <Trash2 />
                    </IconButton>
                  )}
                </div>
                <IconButton
                  label={editing ? "保存并退出编辑" : "编辑"}
                  active={editing}
                  disabled={
                    !canEdit ||
                    busy ||
                    Boolean(cellDraft) ||
                    (editing && (Boolean(drawDraft) || gestureActive))
                  }
                  onClick={() =>
                    editing ? void save(false, true) : beginEditing()
                  }
                >
                  {editing ? <Check /> : <Pencil />}
                </IconButton>
                <span className="map-edit-state">
                  {editing ? "结束" : "浏览"}
                </span>
                {editing && (
                  <>
                    <IconButton
                      label="保存编辑"
                      disabled={
                        !canEdit ||
                        !active?.dirty ||
                        busy ||
                        Boolean(cellDraft) ||
                        Boolean(drawDraft) ||
                        gestureActive
                      }
                      onClick={() => void save()}
                    >
                      <Save />
                    </IconButton>
                    <div className="tool-group">
                      <IconButton
                        label="撤销"
                        disabled={
                          !h?.past.length ||
                          Boolean(drawDraft) ||
                          gestureActive ||
                          !editable ||
                          busy ||
                          Boolean(cellDraft)
                        }
                        onClick={() => history("undo")}
                      >
                        <Undo2 />
                      </IconButton>
                      <IconButton
                        label="重做"
                        disabled={
                          !h?.future.length ||
                          Boolean(drawDraft) ||
                          gestureActive ||
                          !editable ||
                          busy ||
                          Boolean(cellDraft)
                        }
                        onClick={() => history("redo")}
                      >
                        <Redo2 />
                      </IconButton>
                    </div>
                    <IconButton
                      label="捕捉当前图层顶点和边"
                      active={snapping}
                      disabled={!editable || busy}
                      onClick={() => setSnapping((v) => !v)}
                    >
                      <Magnet />
                    </IconButton>
                    {tool !== "select" && tool !== "pan" && (
                      <div className="editing-tools">
                        <span>
                          {tools.find((item) => item.value === tool)?.label}
                          {sketching && <span>{nodeCount} 个节点</span>}
                        </span>
                        {sketching && (
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
                            <Check />
                          </IconButton>
                        )}
                        <IconButton
                          label={
                            sketching
                              ? "取消绘制"
                              : tool === "modify"
                                ? "结束顶点编辑"
                                : "结束移动"
                          }
                          onClick={() => {
                            if (sketching) cancelDrawing();
                            else setTool("select");
                          }}
                        >
                          <X />
                        </IconButton>
                      </div>
                    )}
                  </>
                )}
              </div>
              {editing && (
                <div
                  className="map-edit-help"
                  role="status"
                  aria-label="矢量编辑提示"
                >
                  <strong>
                    {active?.displayName ?? active?.name} · 编辑中
                    {active?.dirty ? " · 未保存" : " · 已保存"}
                  </strong>
                  <span>
                    {tool === "modify"
                      ? "单击要素选择 · 拖动顶点修改 · 拖动边增加顶点 · Alt+单击顶点删除"
                      : tool === "move"
                        ? "直接拖动要素移动 · 拖动空白处平移地图"
                        : sketching
                          ? tool === "Point"
                            ? "单击地图新增点 · Esc 返回选择"
                            : "单击添加节点 · Enter 或双击完成 · Backspace 撤节点 · Esc 取消"
                          : "选择要素后可移动、编辑顶点或修改属性 · 保存后退出编辑"}
                  </span>
                  {drawDraft && (
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => setUndoNodeNonce((n) => n + 1)}
                    >
                      撤回上一节点
                    </button>
                  )}
                </div>
              )}
              <div className="map-coordinates" aria-label="经纬度坐标">
                {position[0].toFixed(5)}, {position[1].toFixed(5)}
              </div>
              {busy && (
                <button
                  className="map-cancel"
                  onClick={() => {
                    cancelParsing();
                    setStatus("已取消解析");
                  }}
                >
                  取消解析
                </button>
              )}

              <MapView
                onContextMenu={(value) => {
                  const sketching =
                    tool === "Point" ||
                    tool === "LineString" ||
                    tool === "Polygon";
                  if (value.featureId && !busy && !cellDraft && !sketching)
                    selectFeature(value.featureId, true);
                  setContext({
                    kind: "map",
                    anchor: {
                      x: value.x,
                      y: value.y,
                      returnFocus: value.returnFocus,
                    },
                    coordinate: value.coordinate,
                    layerId: activeId,
                    featureId: sketching ? undefined : value.featureId,
                  });
                }}
                disabled={busy || Boolean(cellDraft) || Boolean(modal)}
                editable={editable}
                theme={theme}
                snapping={snapping}
                finishNonce={finishNonce}
                cancelNonce={cancelNonce}
                undoNodeNonce={undoNodeNonce}
                drawDraft={drawDraft}
                onDrawDraft={setDrawDraft}
                onGestureState={setGestureActive}
                featureFitNonce={featureFitNonce}
                onNodeCount={setNodeCount}
                layers={mapLayers}
                activeId={activeId}
                selectedId={selectedId}
                tool={tool}
                services={configReady ? services : []}
                basemap={basemap}
                basemapVisible={configReady && basemapVisible}
                fitNonce={fitNonce}
                onSelect={(id) => selectFeature(id, true)}
                onEdit={onGeometry}
                onPosition={setPosition}
                onBounds={setBounds}
              />
              <BasemapControl
                services={configReady ? services : []}
                value={basemap}
                visible={basemapVisible}
                onChange={setBasemap}
                onVisible={setBasemapVisible}
              />
              <div className="map-fit">
                <IconButton
                  label="缩放至图层"
                  disabled={!active}
                  onClick={() => setFitNonce((n) => n + 1)}
                >
                  <LocateFixed />
                </IconButton>
              </div>
            </div>
            <section
              className={`attribute-panel ${tableOpen ? "" : "collapsed"}`}
              data-maximized={tableMaximized}
              style={{
                height: tableOpen
                  ? tableMaximized
                    ? "100%"
                    : tableHeight
                  : "auto",
              }}
            >
              <div
                className="table-resizer"
                role="separator"
                aria-label="调整属性表高度"
                aria-orientation="horizontal"
                aria-valuenow={tableHeight}
                hidden={!tableOpen || tableMaximized}
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
                <span className="attribute-title">
                  属性表
                  {tableOpen && (
                    <>
                      {" "}
                      <span className="count">
                        {active?.features.length ?? 0}
                      </span>
                    </>
                  )}
                </span>
                {tableOpen && (
                  <>
                    <div className="search-field">
                      <Search />
                      <input
                        aria-label="搜索属性"
                        placeholder="搜索属性"
                        value={search}
                        disabled={Boolean(cellDraft)}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(0);
                        }}
                      />
                    </div>
                    <button
                      className={tableEditing ? "active" : "quiet"}
                      aria-pressed={tableEditing}
                      disabled={!canEdit || busy || Boolean(cellDraft)}
                      onClick={() => {
                        if (!editing) {
                          beginEditing();
                          return;
                        }
                        setTableEditing((v) => !v);
                        setTool("select");
                      }}
                    >
                      <Pencil />
                      编辑属性
                    </button>
                    <IconButton
                      label="新增记录"
                      disabled={
                        !editable ||
                        !tableEditing ||
                        busy ||
                        Boolean(cellDraft) ||
                        Boolean(drawDraft) ||
                        gestureActive
                      }
                      onClick={() => {
                        if (!active) return;
                        const feature: GeoFeature = {
                          id: crypto.randomUUID(),
                          geometry: null,
                          properties: Object.fromEntries(
                            fields
                              .filter(
                                (field) =>
                                  !active.db?.columns.some(
                                    (c) =>
                                      c.name === field &&
                                      (c.generated || c.hasDefault),
                                  ),
                              )
                              .map((field) => [field, ""]),
                          ),
                        };
                        edit([...active.features, feature]);
                        setSelectedId(feature.id);
                        setPage(Math.floor(active.features.length / pageSize));
                      }}
                    >
                      <Plus />
                    </IconButton>
                    <IconButton
                      label="删除记录"
                      disabled={
                        !editable ||
                        !tableEditing ||
                        !selected ||
                        busy ||
                        Boolean(cellDraft) ||
                        Boolean(drawDraft) ||
                        gestureActive
                      }
                      onClick={() => openModal("delete")}
                    >
                      <Trash2 />
                    </IconButton>
                    <IconButton
                      label="保存属性编辑"
                      disabled={
                        !editable ||
                        !active?.dirty ||
                        busy ||
                        Boolean(cellDraft) ||
                        Boolean(drawDraft) ||
                        gestureActive
                      }
                      onClick={() => void save()}
                    >
                      <Save />
                    </IconButton>
                    {cellDraft && (
                      <>
                        {!cellDraft.expanded && renderCellActions()}
                        <button
                          disabled={busy || !editable}
                          onClick={() => commitCell()}
                        >
                          应用
                        </button>
                        <button disabled={busy} onClick={cancelCell}>
                          取消
                        </button>
                      </>
                    )}
                    {tableMaximized && editing && (
                      <>
                        <IconButton
                          label="撤销"
                          disabled={
                            !h?.past.length ||
                            Boolean(drawDraft) ||
                            gestureActive ||
                            !editable ||
                            busy ||
                            Boolean(cellDraft)
                          }
                          onClick={() => history("undo")}
                        >
                          <Undo2 />
                        </IconButton>
                        <IconButton
                          label="重做"
                          disabled={
                            !h?.future.length ||
                            Boolean(drawDraft) ||
                            gestureActive ||
                            !editable ||
                            busy ||
                            Boolean(cellDraft)
                          }
                          onClick={() => history("redo")}
                        >
                          <Redo2 />
                        </IconButton>
                      </>
                    )}
                    <IconButton
                      label="定位到选中要素"
                      disabled={!selected || Boolean(cellDraft)}
                      onClick={() => setFeatureFitNonce((n) => n + 1)}
                    >
                      <LocateFixed />
                    </IconButton>
                    <HeaderMenu label="更多">
                      <span className="field-info">
                        {selected ? `选中要素：${selected.id}` : "请先选择要素"}
                      </span>
                      <button
                        disabled={!selected || busy || Boolean(cellDraft)}
                        onClick={() => openModal("json")}
                      >
                        <FileJson />
                        JSON 属性…
                      </button>
                      <button
                        disabled={!selected || busy || Boolean(cellDraft)}
                        onClick={() => openModal("wkt")}
                      >
                        WKT 几何…
                      </button>
                    </HeaderMenu>
                    <div className="pagination">
                      <IconButton
                        label="上一页"
                        disabled={page === 0 || Boolean(cellDraft)}
                        onClick={() => setPage((n) => n - 1)}
                      >
                        <ChevronLeft />
                      </IconButton>
                      <span>
                        {page + 1} / {totalPages}
                      </span>
                      <IconButton
                        label="下一页"
                        disabled={page + 1 >= totalPages || Boolean(cellDraft)}
                        onClick={() => setPage((n) => n + 1)}
                      >
                        <ChevronRight />
                      </IconButton>
                    </div>
                  </>
                )}
                <div
                  className="attribute-window-controls"
                  role="group"
                  aria-label="属性表显示控制"
                >
                  {tableOpen && (
                    <IconButton
                      label={tableMaximized ? "还原属性表" : "最大化属性表"}
                      active={tableMaximized}
                      onClick={() => setTableMaximized((v) => !v)}
                    >
                      {tableMaximized ? <Minimize2 /> : <Maximize2 />}
                    </IconButton>
                  )}
                  <IconButton
                    label={tableOpen ? "收起属性表" : "展开属性表"}
                    onClick={() => {
                      setTableOpen((v) => !v);
                      setTableMaximized(false);
                    }}
                    disabled={Boolean(cellDraft)}
                  >
                    {tableOpen ? <ChevronDown /> : <ChevronUp />}
                  </IconButton>
                </div>
              </header>
              {tableOpen && tableEditing && (
                <div className="table-edit-note">
                  {editable
                    ? "双击单元格或 Enter 编辑 · Enter 应用 · Tab 下一字段 · Esc 取消"
                    : "当前来源只读"}
                </div>
              )}
              {tableOpen &&
                selected &&
                !filtered.some((f) => f.id === selected.id) && (
                  <div className="table-edit-note">
                    选中要素已被筛选隐藏{" "}
                    <button
                      className="quiet"
                      disabled={Boolean(cellDraft)}
                      onClick={() => {
                        setSearch("");
                        setTableLocateNonce((n) => n + 1);
                      }}
                    >
                      显示选中项
                    </button>
                  </div>
                )}
              {cellDraft?.error && !cellDraft.expanded && (
                <div className="cell-error" role="alert">
                  {cellDraft.field}：{cellDraft.error}
                </div>
              )}
              {tableOpen && (
                <div className="table-scroll">
                  <table
                    className={widths ? "resized-columns" : undefined}
                    style={widths ? { width: columnKeys.reduce((sum, key) => sum + (widths[key] ?? 140), 0) } : undefined}
                  >
                    {widths && (
                      <colgroup>
                        {columnKeys.map((key) => <col key={key} style={{ width: widths[key] ?? 140 }} />)}
                      </colgroup>
                    )}
                    <thead>
                      <tr>
                        <th className="index-cell">#{renderColumnResizer("index", "序号")}</th>
                        <th>
                          几何{" "}
                          <button
                            className="quiet field-add"
                            aria-label="添加字段"
                            disabled={!active || !editable || busy}
                            onClick={() => openModal("field")}
                          >
                            <Plus />
                          </button>
                          {renderColumnResizer("geometry", "几何")}
                        </th>
                        {displayFields.map((field) => (
                          <th
                            key={field}
                            title={field}
                            draggable={!cellDraft}
                            onDragStart={(e) => {
                              if ((e.target as HTMLElement).closest(".column-resizer")) { e.preventDefault(); return; }
                              columnDrag.current = field;
                              e.dataTransfer.setData("text/plain", field);
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => { columnDrag.current = null; }}
                            onDragOver={(e) => {
                              if (!columnDrag.current) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDrop={(e) => {
                              const from = columnDrag.current;
                              if (!from || !activeId || from === field) return;
                              e.preventDefault();
                              e.stopPropagation();
                              const next = displayFields.filter((name) => name !== from);
                              const rect = e.currentTarget.getBoundingClientRect();
                              next.splice(next.indexOf(field) + (e.clientX > rect.left + rect.width / 2 ? 1 : 0), 0, from);
                              setColumnOrders((old) => ({ ...old, [activeId]: next }));
                              columnDrag.current = null;
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              event.currentTarget
                                .querySelector("details")
                                ?.removeAttribute("open");
                              if (active)
                                setContext({
                                  kind: "field",
                                  layerId: active.id,
                                  field,
                                  anchor: {
                                    x: event.clientX,
                                    y: event.clientY,
                                    returnFocus:
                                      event.currentTarget.querySelector(
                                        "summary",
                                      ),
                                  },
                                });
                            }}
                            onKeyDown={(event) => {
                              if (event.altKey && !cellDraft && activeId &&
                                  (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                                event.preventDefault();
                                event.stopPropagation();
                                const next = [...displayFields];
                                const from = next.indexOf(field);
                                const to = from + (event.key === "ArrowLeft" ? -1 : 1);
                                if (to >= 0 && to < next.length) {
                                  [next[from], next[to]] = [next[to], next[from]];
                                  setColumnOrders((old) => ({ ...old, [activeId]: next }));
                                }
                                return;
                              }
                              if (!(
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                              ))
                                return;
                              event.preventDefault();
                              event.stopPropagation();
                              event.currentTarget
                                .querySelector("details")
                                ?.removeAttribute("open");
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              if (active)
                                setContext({
                                  kind: "field",
                                  layerId: active.id,
                                  field,
                                  anchor: {
                                    x: rect.left,
                                    y: rect.bottom,
                                    returnFocus:
                                      event.currentTarget.querySelector(
                                        "summary",
                                      ),
                                  },
                                });
                            }}
                          >
                            <HeaderMenu label={field}>
                              <span className="field-info">
                                {fieldSummary(field)}
                              </span>
                              <button
                                disabled={!editable || busy}
                                onClick={() => openModal("field")}
                              >
                                <Plus />
                                添加字段
                              </button>
                              <button
                                disabled={!editable || busy}
                                onClick={() => {
                                  setFieldTarget(field);
                                  setNewField(field);
                                  openModal("rename-field");
                                }}
                              >
                                重命名字段
                              </button>
                              <button
                                disabled={!editable || busy}
                                onClick={() => {
                                  setFieldTarget(field);
                                  openModal("delete-field");
                                }}
                              >
                                删除字段
                              </button>
                            </HeaderMenu>
                            {renderColumnResizer(`field:${field}`, field)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((f, index) => (
                        <tr
                          key={f.id}
                          ref={selectedId === f.id ? selectedRow : undefined}
                          aria-selected={selectedId === f.id}
                          className={selectedId === f.id ? "selected" : ""}
                          tabIndex={
                            selectedId === f.id || (!selectedId && index === 0)
                              ? 0
                              : -1
                          }
                          onContextMenu={(event) => {
                            if (nativeTextTarget(event.target as Element))
                              return;
                            event.preventDefault();
                            event.stopPropagation();
                            openRecordContext(
                              {
                                x: event.clientX,
                                y: event.clientY,
                                returnFocus: event.currentTarget,
                              },
                              f,
                              (event.target as Element).closest<HTMLElement>(
                                "td[data-field]",
                              )?.dataset.field,
                            );
                          }}
                          onKeyDown={(event) => {
                            if (
                              nativeTextTarget(event.target as Element) ||
                              !(
                                event.key === "ContextMenu" ||
                                (event.shiftKey && event.key === "F10")
                              )
                            )
                              return;
                            event.preventDefault();
                            event.stopPropagation();
                            const target = event.target as HTMLElement;
                            const rect = target.getBoundingClientRect();
                            openRecordContext(
                              {
                                x: rect.left,
                                y: rect.bottom,
                                returnFocus: target,
                              },
                              f,
                              target.closest<HTMLElement>("td[data-field]")
                                ?.dataset.field,
                            );
                          }}
                          onClick={() => selectFeature(f.id)}
                          onDoubleClick={() => {
                            if (cellDraft || tableEditing) return;
                            selectFeature(f.id);
                            centerImmediately.current = true;
                            setTableLocateNonce((n) => n + 1);
                            setFeatureFitNonce((n) => n + 1);
                          }}
                        >
                          <td className="index-cell">
                            {page * pageSize + index + 1}
                          </td>
                          <td>{f.geometry?.type ?? "空"}</td>
                          {displayFields.map((field) => {
                            const draft =
                              cellDraft?.featureId === f.id &&
                              cellDraft.layerId === activeId &&
                              cellDraft.field === field
                                ? cellDraft
                                : null;
                            const value = f.properties[field];
                            return (
                              <td
                                key={field}
                                title={
                                  draft
                                    ? undefined
                                    : value === null
                                      ? "NULL"
                                      : stringify(value)
                                }
                                className={
                                  draft
                                    ? "attribute-cell editing"
                                    : "attribute-cell"
                                }
                                data-feature={f.id}
                                data-field={field}
                                tabIndex={
                                  tableEditing && editable ? 0 : undefined
                                }
                                onDoubleClick={(e) => {
                                  if (!tableEditing) return;
                                  e.stopPropagation();
                                  beginCell(f, field);
                                }}
                                onKeyDown={(e) => {
                                  if (
                                    e.target !== e.currentTarget ||
                                    e.key !== "Enter"
                                  )
                                    return;
                                  e.preventDefault();
                                  beginCell(f, field);
                                }}
                              >
                                {draft && !draft.expanded ? (
                                  <>
                                    <span
                                      className="cell-size-reference"
                                      aria-hidden="true"
                                    >
                                      {value === null
                                        ? "NULL"
                                        : stringify(value) || "\u00a0"}
                                    </span>
                                    {renderCellInput()}
                                  </>
                                ) : value === null ? (
                                  <span className="null-value">NULL</span>
                                ) : (
                                  stringify(value)
                                )}
                              </td>
                            );
                          })}
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
          {(toolboxMounted || (agentOpen && desktop)) && (
            <RightSidebar
              hidden={!rightSidebarOpen}
              label={toolboxOpen ? "工具" : "Agent"}
              width={shownSidebarWidth}
              maxWidth={sidebarMaxWidth}
              onWidthChange={setSidebarWidth}
            >
              {toolboxMounted && (
                <div className="processing-toolbox-host" hidden={!toolboxOpen}>
                  <ProcessingToolbox
                    layers={layers}
                    activeLayerId={activeId}
                    selectedFeatureId={selectedId}
                    editing={Boolean(editingLayerId)}
                    blockedReason={
                      !desktop
                        ? "空间分析需要桌面版，请在 zGIS 应用中运行"
                        : modal ||
                            gestureActive ||
                            !recoveryReady ||
                            (busy && !toolboxRunning)
                          ? "请先完成当前操作"
                          : undefined
                    }
                    onRun={runToolboxAnalysis}
                    onRunningChange={setToolboxRunning}
                    onClose={() => {
                      if (busyRef.current) return;
                      setToolboxOpen(false);
                      toolboxTrigger.current?.focus();
                    }}
                    onLocateResult={(id) => {
                      if (busyRef.current || editingLayerId) return;
                      if (
                        !currentLayers.current.some((layer) => layer.id === id)
                      ) {
                        setError("结果图层已移除");
                        return;
                      }
                      activateLayer(id);
                      setFitNonce((n) => n + 1);
                    }}
                  />
                </div>
              )}
              {agentOpen && desktop && (
                <AgentPanel onClose={() => setAgentOpen(false)} />
              )}
            </RightSidebar>
          )}
        </main>
        {error && !modal && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <IconButton label="关闭错误" onClick={() => setError("")}>
              <X />
            </IconButton>
          </div>
        )}
        <div className="operation-status sr-only" role="status">
          {status}
        </div>
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
            title="导出为"
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
        <PostgisManager
          open={modal === "postgis-manager"}
          onSourcesChange={setPostgisSourceCount}
          onClose={() => openModal(null)}
          inUseConnectionIds={layers.flatMap((l) =>
            l.db ? [l.db.connectionId] : [],
          )}
          onActive={(id, config) => {
            setConnectionId(id);
            setConnection(config);
          }}
          onLoad={(id, config, layer) => {
            if (editingLayerId || cellDraft) {
              setError("请先保存并退出当前图层编辑，再加载数据源");
              return;
            }
            setDbEngine("postgis");
            setConnectionId(id);
            setConnection(config);
            setDbLayers([layer]);
            setDbIndex(0);
            setDbWktColumn("");
            setDbSrid(layer.srid || 4326);
            openModal("db-load");
          }}
        />
        <PostgisManager
          engine="mysql"
          onSourcesChange={setMysqlSourceCount}
          open={modal === "mysql-manager"}
          onClose={() => openModal(null)}
          inUseConnectionIds={layers.flatMap((l) =>
            l.db ? [l.db.connectionId] : [],
          )}
          onActive={() => {}}
          onLoad={(id, config, layer) => {
            if (editingLayerId || cellDraft) {
              setError("请先保存并退出当前图层编辑，再加载数据源");
              return;
            }
            setDbEngine("mysql");
            setConnectionId(id);
            setConnection(config);
            setDbLayers([{ ...layer, engine: "mysql" }]);
            setDbIndex(0);
            setDbWktColumn("");
            setDbSrid(layer.srid || 4326);
            setDbLimit(Math.min(dbLimit, 10000));
            setDbUseViewport(false);
            openModal("db-load");
          }}
        />
        {modal === "settings" && (
          <SettingsPage
            services={services}
            onServices={changeServices}
            category={settingCategory}
            onCategory={setSettingCategory}
            theme={theme}
            onTheme={setTheme}
            error={error}
            onClose={() => openModal(null)}
          />
        )}
        {modal === "layer" && active && (
          <Modal
            title={`图层属性：${active.displayName ?? active.name}`}
            onClose={() => openModal(null)}
          >
            <div className="layer-details">
              <h3>{active.displayName ?? active.name}</h3>
              <span className="count">
                {active.features.length.toLocaleString()} 个要素
              </span>
              <details open>
                <summary>属性字段 · {fields.length}</summary>
                <div className="layer-field-list">
                  {fields.length ? (
                    fields.map((field) => (
                      <div key={field}>
                        <strong>{field}</strong>
                        <span>{fieldSummary(field)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="form-note">没有属性字段</p>
                  )}
                </div>
                <button
                  disabled={!editable || busy}
                  onClick={() => openModal("field")}
                >
                  <Plus />
                  添加字段…
                </button>
                <button
                  className="quiet"
                  onClick={() => {
                    setTableOpen(true);
                    openModal(null);
                  }}
                >
                  打开属性表
                </button>
              </details>
              <details open>
                <summary>来源详情</summary>
                {active.restored && (
                  <p className="form-note">恢复副本 · {active.restoredFrom}</p>
                )}
                <dl>
                  <dt>来源名称</dt>
                  <dd>{active.name}</dd>
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
                {!canEdit && (
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
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>关闭</button>
            </div>
          </Modal>
        )}
        {modal === "style" && active && layerStyleDraft && (
          <Modal
            title={`图层样式：${active.displayName ?? active.name}`}
            onClose={() => openModal(null)}
          >
            <div className="layer-details">
              <h4>样式</h4>
              <label>
                <span>颜色</span>
                <input
                  type="color"
                  value={layerStyleDraft.color}
                  aria-label={`${active.displayName ?? active.name}颜色`}
                  onChange={(e) =>
                    setLayerStyleDraft((d) =>
                      d ? { ...d, color: e.target.value } : null,
                    )
                  }
                />
              </label>
              <label>
                <span>不透明度</span>
                <output>{Math.round(layerStyleDraft.opacity * 100)}%</output>
                <input
                  type="range"
                  aria-label="不透明度"
                  min="0"
                  max="1"
                  step="0.05"
                  value={layerStyleDraft.opacity}
                  onChange={(e) =>
                    setLayerStyleDraft((d) =>
                      d ? { ...d, opacity: Number(e.target.value) } : null,
                    )
                  }
                />
              </label>
              <label>
                <span>线宽</span>
                <output>{layerStyleDraft.strokeWidth} px</output>
                <input
                  type="range"
                  aria-label="线宽"
                  min="1"
                  max="8"
                  step="1"
                  value={layerStyleDraft.strokeWidth}
                  onChange={(e) =>
                    setLayerStyleDraft((d) =>
                      d ? { ...d, strokeWidth: Number(e.target.value) } : null,
                    )
                  }
                />
              </label>
            </div>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>取消</button>
              <button
                disabled={busy}
                onClick={() => {
                  setLayers((old) =>
                    old.map((l) =>
                      l.id === layerStyleDraft.layerId
                        ? {
                            ...l,
                            color: layerStyleDraft.color,
                            opacity: layerStyleDraft.opacity,
                            strokeWidth: layerStyleDraft.strokeWidth,
                          }
                        : l,
                    ),
                  );
                  setStatus("图层样式已更新");
                  openModal(null);
                }}
              >
                应用样式
              </button>
            </div>
          </Modal>
        )}
        {modal === "cell" && cellDraft && (
          <Modal
            title={`编辑属性：${cellDraft.field}`}
            onClose={cancelCell}
            showError={false}
          >
            <p className="form-note">
              图层：{active?.displayName ?? active?.name} · 要素：
              {cellDraft.featureId} ·{" "}
              {cellDraft.original == null
                ? "输入 JSON 值"
                : typeof cellDraft.original === "object"
                  ? "输入 JSON，类型不变"
                  : "输入文本"}
            </p>
            {renderCellInput(true)}
            {cellDraft.error && (
              <p className="inline-error" role="alert">
                {cellDraft.error}
              </p>
            )}
            <div className="modal-actions">
              <button onClick={cancelCell}>取消</button>
              <button disabled={!editable || busy} onClick={() => commitCell()}>
                应用
              </button>
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
                  <dd>{active?.displayName ?? active?.name}</dd>
                  <dt>要素</dt>
                  <dd>{selected.id}</dd>
                  <dt>{modal === "json" ? "草稿字段" : "草稿类型"}</dt>
                  <dd>{draftError ? "未通过校验" : draftSummary}</dd>
                  <dt>工作坐标</dt>
                  <dd>WGS84</dd>
                </dl>
                {!canEdit && <p className="form-note">当前来源只读</p>}
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
                <Check />
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
                {active?.displayName ?? active?.name} ·{" "}
                {active?.features.length ?? 0} 个要素，初始值为空字符串。
              </p>
            </div>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>取消</button>
              <button
                disabled={!newField.trim() || !editable || busy}
                onClick={() => {
                  const name = newField.trim();
                  if (name.length > 1024 || fields.length >= 10_000) {
                    setError("字段名最多 1024 个字符，图层最多 10000 个字段");
                    return;
                  }
                  if (fields.includes(name)) {
                    setError("字段已存在，不能覆盖原值");
                    return;
                  }
                  edit(
                    active!.features.map((f) => ({
                      ...f,
                      properties: { ...f.properties, [name]: "" },
                    })),
                    [...fields, name],
                    active!.db
                      ? [
                          ...(active!.schemaChanges ?? []),
                          { kind: "add", name },
                        ]
                      : active!.schemaChanges,
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
        {(modal === "rename-field" || modal === "delete-field") && active && (
          <Modal
            title={modal === "rename-field" ? "重命名字段" : "删除字段"}
            onClose={() => openModal(null)}
          >
            {modal === "rename-field" ? (
              <label>
                新字段名
                <input
                  aria-label="新字段名"
                  autoFocus
                  value={newField}
                  onChange={(e) => setNewField(e.target.value)}
                />
              </label>
            ) : (
              <p>
                删除字段“{fieldTarget}”及该字段的全部值？保存编辑后同步到来源。
              </p>
            )}
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>取消</button>
              <button
                className={modal === "delete-field" ? "danger" : undefined}
                disabled={
                  !editable ||
                  busy ||
                  (modal === "rename-field" && !newField.trim())
                }
                onClick={() => {
                  const rename = modal === "rename-field";
                  const name = newField.trim();
                  if (
                    rename &&
                    (name.length > 1024 ||
                      (fields.includes(name) && name !== fieldTarget))
                  ) {
                    setError("字段名无效或已存在，不能覆盖原值");
                    return;
                  }
                  if (rename && name === fieldTarget) {
                    openModal(null);
                    return;
                  }
                  const features = active.features.map((f) => {
                    const properties = { ...f.properties };
                    if (rename && Object.hasOwn(properties, fieldTarget))
                      properties[name] = properties[fieldTarget];
                    delete properties[fieldTarget];
                    return { ...f, properties };
                  });
                  edit(
                    features,
                    rename
                      ? fields.map((f) => (f === fieldTarget ? name : f))
                      : fields.filter((f) => f !== fieldTarget),
                    active.db
                      ? [
                          ...(active.schemaChanges ?? []),
                          rename
                            ? {
                                kind: "rename",
                                name: fieldTarget,
                                newName: name,
                              }
                            : { kind: "delete", name: fieldTarget },
                        ]
                      : active.schemaChanges,
                  );
                  setNewField("");
                  openModal(null);
                }}
              >
                {modal === "rename-field" ? "重命名字段" : "删除字段"}
              </button>
            </div>
          </Modal>
        )}
        {modal === "new-layer" && (
          <Modal
            title="新建矢量图层"
            onClose={() => {
              insertionGroup.current = undefined;
              openModal(null);
            }}
          >
            <div className="form-grid">
              <label>
                图层名称
                <input
                  autoFocus
                  aria-label="矢量图层名称"
                  maxLength={120}
                  value={newLayerName}
                  onChange={(e) => setNewLayerName(e.target.value)}
                />
              </label>
              <label>
                几何类型
                <select
                  aria-label="矢量几何类型"
                  value={newGeometryType}
                  onChange={(e) =>
                    setNewGeometryType(e.target.value as typeof newGeometryType)
                  }
                >
                  <option value="Point">点</option>
                  <option value="LineString">线</option>
                  <option value="Polygon">面</option>
                </select>
              </label>
              <label>
                属性字段（可选）
                <input
                  aria-label="矢量属性字段"
                  placeholder="用逗号分隔字段名"
                  value={newLayerFields}
                  onChange={(e) => setNewLayerFields(e.target.value)}
                />
              </label>
              <p className="form-note">
                工作坐标为 WGS84。创建后进入编辑模式，保存为
                GeoJSON；需要其他格式可导出。
              </p>
            </div>
            <div className="modal-actions">
              <button onClick={() => openModal(null)}>取消</button>
              <button
                disabled={!newLayerName.trim() || busy}
                onClick={() => {
                  const fieldNames = newLayerFields
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (new Set(fieldNames).size !== fieldNames.length) {
                    setError("字段名不能重复");
                    return;
                  }
                  if (
                    fieldNames.length > 10_000 ||
                    fieldNames.some((field) => field.length > 1024)
                  ) {
                    setError("字段名最多 1024 个字符，图层最多 10000 个字段");
                    return;
                  }
                  const layer = makeLayer(
                    newLayerName.trim().replace(/\.(geojson|json)$/i, "") +
                      ".geojson",
                    [],
                    "geojson",
                    { dirty: true, geometryType: newGeometryType, fieldNames },
                  );
                  restoringSession.current = {
                    layerId: layer.id,
                    tool: newGeometryType,
                    snapping,
                  };
                  addLayers([layer]);
                  setModal(null);
                }}
              >
                <Plus />
                创建并编辑
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
                disabled={
                  !selected ||
                  !editable ||
                  busy ||
                  Boolean(cellDraft) ||
                  Boolean(drawDraft) ||
                  gestureActive
                }
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
              engine={dbEngine}
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
        {modal === "close" && (
          <Modal title="移除未保存图层" onClose={() => setModal(null)}>
            <p>“{active?.displayName ?? active?.name}” 存在未保存修改。</p>
            <div className="modal-actions">
              <button onClick={() => setModal(null)}>取消</button>
              <button className="danger" onClick={() => void closeLayer()}>
                放弃并移除
              </button>
            </div>
          </Modal>
        )}
        {modal === "quit" && (
          <Modal title="退出 zGIS" onClose={cancelExit}>
            <p>当前图层仍处于编辑模式。</p>
            <p className="form-note">
              退出并保留工作区会保存修改和未完成草稿，下次启动继续编辑。源文件尚未保存；需要保存源文件时，请返回编辑完成保存。
            </p>
            <div className="modal-actions">
              <button disabled={busy} onClick={cancelExit}>
                返回编辑
              </button>
              <button disabled={busy} onClick={() => void processExit()}>
                {busy ? <LoaderCircle className="spin" /> : <Check />}
                退出并保留工作区
              </button>
            </div>
          </Modal>
        )}
      </div>
    </ErrorContext.Provider>
  );
}
