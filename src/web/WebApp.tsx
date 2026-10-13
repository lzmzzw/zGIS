import { useLocale } from "../i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Download,
  FolderOpen,
  Hand,
  Check,
  LocateFixed,
  Magnet,
  MapPin,
  MousePointer2,
  Move,
  Pencil,
  Pentagon,
  Route,
  Search,
  Spline,
  Trash2,
  X,
} from "lucide-react";
import MapView, { type Tool } from "../MapView";
import { ImportPanel } from "../FilePanels";
import ProcessingToolbox, {
  type ProcessingRequest,
  type ProcessingOutcome,
} from "../ProcessingToolbox";
import { defaultBasemaps } from "../basemaps";
import { getAnalysisTool } from "../analysisTools";
import {
  importGeoJSON,
  makeLayer,
  type DocumentLayer,
  type ImportOptions,
  type InputFile,
} from "../domain";
import { searchFeatures } from "../attributeSearch";
import { cancelParsing, parseInWorker } from "../workers";
import { runAnalysis, cancelAnalysis, exportShapefile } from "./analysis";
import { downloadFile, readBrowserFiles, textExport } from "./files";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const nameOf = (layer: DocumentLayer) => layer.displayName || layer.name;
const cell = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { locale, setLocale, t } = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal web-modal"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <select
          aria-label={t("语言")}
          value={locale}
          onChange={(event) => setLocale(event.target.value as typeof locale)}
        >
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
        <button aria-label={t(`关闭${title}`)} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export default function WebApp() {
  const { locale, setLocale, t } = useLocale();
  const [layers, setLayers] = useState<DocumentLayer[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [fitNonce, setFitNonce] = useState(0);
  const [featureFitNonce, setFeatureFitNonce] = useState(0);
  const [tool, setTool] = useState<Tool>("select");
  const [editingLayerId, setEditingLayerId] = useState<string>();
  const [snapping, setSnapping] = useState(true);
  const [finishNonce, setFinishNonce] = useState(0);
  const [cancelNonce, setCancelNonce] = useState(0);
  const [nodeCount, setNodeCount] = useState(0);
  const [gestureActive, setGestureActive] = useState(false);
  const [basemap, setBasemap] = useState("osm");
  const [toolboxOpen, setToolboxOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<InputFile[]>([]);
  const [exportId, setExportId] = useState<string>();
  const [removeId, setRemoveId] = useState<string>();
  const [exportMode, setExportMode] = useState<
    "geojson" | "wkt" | "xy" | "shp"
  >("geojson");
  const [exportCrs, setExportCrs] = useState("EPSG:4326");
  const [exportName, setExportName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(
    "选择或拖入文件开始；文件仅在本地浏览器处理。",
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [position, setPosition] = useState<number[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const job = useRef<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const active = layers.find((layer) => layer.id === activeId);
  const editing = Boolean(activeId && editingLayerId === activeId);
  const exporting = layers.find((layer) => layer.id === exportId);
  const removing = layers.find((layer) => layer.id === removeId);
  const dirty = layers.some((layer) => layer.dirty);
  const cancellable = busy && (pendingFiles.length > 0 || job.current !== null);
  const filtered = useMemo(
    () => searchFeatures(active?.features ?? [], search),
    [active?.features, search],
  );
  const fields = useMemo(
    () => [
      ...new Set([
        ...(active?.fieldNames ?? []),
        ...(active?.features.flatMap((feature) =>
          Object.keys(feature.properties),
        ) ?? []),
      ]),
    ],
    [active],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 100));
  useEffect(() => {
    setPage(0);
  }, [activeId, search]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelParsing();
      if (job.current) void cancelAnalysis(job.current);
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const locate = (id: string) => {
    if (editingLayerId && editingLayerId !== id) {
      setError("请先保存并退出当前图层编辑，再切换图层");
      return;
    }
    setActiveId(id);
    setSelectedId(undefined);
    setFitNonce((value) => value + 1);
  };
  const beginEditing = () => {
    if (!active || busy || !active.features.length) return;
    setEditingLayerId(active.id);
    setTool("select");
    setStatus("编辑中：可新增、移动或修改要素");
  };
  const finishEditing = () => {
    if (gestureActive) return;
    setEditingLayerId(undefined);
    setTool("pan");
    setNodeCount(0);
    setCancelNonce((value) => value + 1);
    setStatus("已退出编辑");
  };
  const editFeature = (feature: DocumentLayer["features"][number], insert: boolean) => {
    if (!active || !editing) return false;
    setLayers((old) =>
      old.map((layer) => {
        if (layer.id !== active.id) return layer;
        const features = insert
          ? [...layer.features, feature]
          : layer.features.map((item) =>
              item.id === feature.id ? { ...item, geometry: feature.geometry } : item,
            );
        return { ...layer, features, dirty: true };
      }),
    );
    setSelectedId(feature.id);
    setStatus(insert ? "已新增要素，继续绘制或保存编辑" : "几何已更新，可保存编辑");
    return true;
  };
  const deleteSelected = () => {
    if (!active || !editing || !selectedId) return;
    setLayers((old) =>
      old.map((layer) =>
        layer.id === active.id
          ? { ...layer, features: layer.features.filter((feature) => feature.id !== selectedId), dirty: true }
          : layer,
      ),
    );
    setSelectedId(undefined);
    setStatus("已删除要素，可撤销或保存编辑");
  };
  const patchLayer = (id: string, patch: Partial<DocumentLayer>) =>
    setLayers((old) =>
      old.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)),
    );
  const addLayers = (items: DocumentLayer[]) => {
    setLayers((old) => [...old, ...items]);
    if (items[0]) locate(items[0].id);
  };
  async function selectFiles(files: File[]) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await readBrowserFiles(files);
      if (mounted.current) setPendingFiles(result);
    } catch (reason) {
      if (mounted.current) setError(message(reason));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function importFiles(options: ImportOptions[]) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setStatus("正在解析文件…");
    try {
      const result = await parseInWorker(pendingFiles, {}, options);
      if (!mounted.current) return;
      addLayers(result);
      setPendingFiles([]);
      setStatus(
        `已导入 ${result.length} 个图层，${result.reduce((sum, layer) => sum + layer.features.length, 0)} 个要素`,
      );
    } catch (reason) {
      if (mounted.current) {
        setError(message(reason));
        setStatus("导入未完成");
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function analyze(
    request: ProcessingRequest,
  ): Promise<ProcessingOutcome> {
    if (locked.current) throw new Error("请等待当前操作完成");
    const definition = getAnalysisTool(request.operation);
    const source = layers.find((layer) => layer.id === request.sourceId);
    const target = layers.find((layer) => layer.id === request.targetId);
    if (!definition || !source || (request.targetId && !target))
      throw new Error("输入图层不可用，请重新选择");
    const features = request.selectedOnly
      ? source.id === activeId
        ? source.features.filter((feature) => feature.id === selectedId)
        : []
      : source.features;
    if (!features.length) throw new Error("输入范围没有要素");
    const name = request.outputName.trim();
    if (!definition.report && (!name || name.length > 100))
      throw new Error("结果名称须为 1–100 个字符");
    locked.current = true;
    setBusy(true);
    setError("");
    const jobId = crypto.randomUUID();
    job.current = jobId;
    const start = performance.now();
    setStatus(`正在运行${definition.label}…`);
    try {
      const raw = await runAnalysis(
        request.operation,
        request.parameters,
        features,
        target?.features,
        jobId,
      );
      if (!mounted.current) throw new Error("分析已取消");
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("分析结果结构无效");
      const result = raw as Record<string, unknown>;
      if (
        result.type === "FeatureCollection" &&
        Array.isArray(result.features)
      ) {
        const output = importGeoJSON(JSON.stringify(result));
        const layer = makeLayer(
          /\.geojson$/i.test(name) ? name : `${name}.geojson`,
          output,
          "geojson",
          {
            displayName: name,
            dirty: true,
            warnings: [
              `${definition.label}结果；浏览器中的独立副本，请下载保存。`,
            ],
          },
        );
        addLayers([layer]);
        setStatus(`${definition.label}完成：${output.length} 个结果要素`);
        return {
          featureCount: output.length,
          layerId: layer.id,
          layerName: name,
          durationMs: performance.now() - start,
        };
      }
      if (!["layer_summary", "topology_check"].includes(request.operation))
        throw new Error("分析未返回矢量结果");
      setStatus(`${definition.label}完成`);
      return { report: result, durationMs: performance.now() - start };
    } catch (reason) {
      setStatus(message(reason).includes("取消") ? "分析已取消" : "分析失败");
      throw reason;
    } finally {
      job.current = null;
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function exportLayer() {
    if (!exporting || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const stem = exportName.trim().replace(/\.(geojson|json|csv|zip)$/i, "");
      if (!stem || stem.length > 100 || /[\\/:*?"<>|]/.test(stem))
        throw new Error("文件名须为 1–100 个字符，不能包含路径或特殊字符。");
      if (exportMode === "shp") job.current = crypto.randomUUID();
      if (exportMode === "shp")
        downloadFile(
          `${stem}.zip`,
          await exportShapefile(
            exporting.features,
            stem,
            exportCrs,
            job.current ?? undefined,
          ),
          "application/zip",
        );
      else
        downloadFile(
          `${stem}.${exportMode === "geojson" ? "geojson" : "csv"}`,
          textExport(exporting.features, exportMode, exportCrs),
          exportMode === "geojson"
            ? "application/geo+json"
            : "text/csv;charset=utf-8",
        );
      patchLayer(exporting.id, { dirty: false });
      setExportId(undefined);
      setStatus("已生成图层下载，请确认浏览器下载已保存。");
    } catch (reason) {
      setError(message(reason));
    } finally {
      job.current = null;
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function cancelCurrent() {
    if (job.current) await cancelAnalysis(job.current);
    else cancelParsing();
  }
  return (
    <div
      className="web-app"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!pendingFiles.length && !exportId && !removeId)
          void selectFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="web-header">
        <strong>
          zGIS <span>Web</span>
        </strong>
        <button disabled={busy} onClick={() => input.current?.click()}>
          <FolderOpen size={16} />
          {t("导入文件")}
        </button>
        <input
          hidden
          ref={input}
          aria-label={t("选择空间文件")}
          type="file"
          multiple
          accept=".geojson,.json,.csv,.zip"
          onChange={(event) => {
            void selectFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          disabled={busy}
          aria-pressed={toolboxOpen}
          onClick={() => setToolboxOpen((open) => !open)}
        >
          {t("空间分析")}
        </button>
        <label className="web-language">
          {t("语言")}
          <select
            aria-label={t("语言")}
            value={locale}
            onChange={(event) => setLocale(event.target.value as typeof locale)}
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <span className="web-local-note">
          {t("文件本地处理 · 结果下载保存")}
        </span>
      </header>
      <div className={`web-workspace ${toolboxOpen ? "with-toolbox" : ""}`}>
        <aside className="web-layers" aria-label={t("图层列表")}>
          <header>
            <strong>{t("图层")}</strong>
            <span>{layers.length}</span>
          </header>
          {!layers.length && (
            <p className="web-empty">
              {t(
                "导入 GeoJSON、CSV（WKT 或 X/Y）或 SHP ZIP。可将多个文件拖入地图。",
              )}
            </p>
          )}
          {layers.map((layer) => (
            <section
              key={layer.id}
              className={`web-layer ${layer.id === activeId ? "active" : ""}`}
            >
              <div className="web-layer-name">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  disabled={busy}
                  aria-label={t(`${nameOf(layer)} 显示`)}
                  onChange={(event) =>
                    patchLayer(layer.id, { visible: event.target.checked })
                  }
                />
                <button
                  className="web-name-button"
                  aria-label={nameOf(layer)}
                  onClick={() => {
                    if (editingLayerId && editingLayerId !== layer.id) {
                      setError("请先保存并退出当前图层编辑，再切换图层");
                      return;
                    }
                    setActiveId(layer.id);
                    setSelectedId(undefined);
                  }}
                >
                  {nameOf(layer)}
                  {layer.dirty && " *"}
                </button>
              </div>
              <p>
                {t(`${layer.features.length} 个要素`)} ·{" "}
                {layer.originalCrs || layer.crs}
              </p>
              <div className="web-layer-actions">
                <input
                  type="color"
                  value={layer.color}
                  disabled={busy}
                  aria-label={t(`${nameOf(layer)} 颜色`)}
                  onChange={(event) =>
                    patchLayer(layer.id, { color: event.target.value })
                  }
                />
                <label>
                  {t("透明度")}
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={layer.opacity ?? 1}
                    disabled={busy}
                    aria-label={t(`${nameOf(layer)} 透明度`)}
                    onChange={(event) =>
                      patchLayer(layer.id, {
                        opacity: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <button
                  aria-label={t(`${nameOf(layer)} 定位`)}
                  onClick={() => locate(layer.id)}
                >
                  <LocateFixed size={15} />
                </button>
                <button
                  disabled={busy}
                  aria-label={t(`${nameOf(layer)} 移除`)}
                  onClick={() => setRemoveId(layer.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {!!layer.warnings?.length && (
                <details>
                  <summary>{t(`图层提示（${layer.warnings.length}）`)}</summary>
                  {layer.warnings.map((warning, index) => (
                    <p key={index}>{t(warning)}</p>
                  ))}
                </details>
              )}
            </section>
          ))}
        </aside>
        <main className="web-map-and-table">
          <div className="web-map">
            <MapView
              services={defaultBasemaps}
              theme="light"
              snapping={snapping}
              editable={editing}
              disabled={busy}
              finishNonce={finishNonce}
              cancelNonce={cancelNonce}
              featureFitNonce={featureFitNonce}
              onNodeCount={setNodeCount}
              onGestureState={setGestureActive}
              layers={layers}
              activeId={activeId}
              selectedId={selectedId}
              tool={tool}
              basemap={basemap}
              basemapVisible={basemap !== "none"}
              fitNonce={fitNonce}
              onSelect={setSelectedId}
              onEdit={editFeature}
              onPosition={setPosition}
            />
            <div className="web-map-controls">
              <button
                aria-label={t("选择要素")}
                aria-pressed={tool === "select"}
                onClick={() => setTool("select")}
              >
                <MousePointer2 size={16} />
              </button>
              <button
                aria-label={t("平移地图")}
                aria-pressed={tool === "pan"}
                disabled={editing && Boolean(nodeCount)}
                onClick={() => setTool("pan")}
              >
                <Hand size={16} />
              </button>
              <button
                aria-label={t(editing ? "退出编辑" : "编辑")}
                aria-pressed={editing}
                disabled={!active || busy || gestureActive}
                onClick={() => (editing ? finishEditing() : beginEditing())}
              >
                {editing ? <X size={16} /> : <Pencil size={16} />}
              </button>
              {editing && (
                <div className="web-edit-controls" role="group" aria-label={t("几何编辑")}>
                  {([
                    ["Point", "新增点", MapPin],
                    ["LineString", "新增线", Route],
                    ["Polygon", "新增面", Pentagon],
                    ["modify", "编辑顶点", Spline],
                    ["move", "移动要素", Move],
                  ] as const).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      aria-label={t(label)}
                      aria-pressed={tool === value}
                      disabled={busy || gestureActive}
                      onClick={() => setTool(value)}
                    >
                      <Icon size={15} />
                    </button>
                  ))}
                  {(tool === "Point" || tool === "LineString" || tool === "Polygon") && (
                    <button
                      aria-label={t("完成绘制")}
                      disabled={nodeCount < (tool === "Polygon" ? 3 : tool === "LineString" ? 2 : 1)}
                      onClick={() => setFinishNonce((value) => value + 1)}
                    >
                      <Check size={15} />
                    </button>
                  )}
                  <button
                    aria-label={t("捕捉当前图层顶点和边")}
                    aria-pressed={snapping}
                    onClick={() => setSnapping((value) => !value)}
                  >
                    <Magnet size={15} />
                  </button>
                  <button
                    aria-label={t("删除选中要素")}
                    disabled={!selectedId || busy || Boolean(nodeCount)}
                    onClick={deleteSelected}
                  >
                    <Trash2 size={15} />
                  </button>
                  <button
                    aria-label={t("保存编辑")}
                    disabled={!active?.dirty || busy || Boolean(nodeCount)}
                    onClick={() => {
                      if (!active) return;
                      setExportName(nameOf(active).replace(/\.[^.]+$/, ""));
                      setExportMode("geojson");
                      setExportId(active.id);
                    }}
                  >
                    <Download size={15} />
                  </button>
                </div>
              )}
              <select
                aria-label={t("底图")}
                value={basemap}
                onChange={(event) => setBasemap(event.target.value)}
              >
                <option value="osm">OpenStreetMap</option>
                <option value="none">{t("无底图")}</option>
              </select>
            </div>
            {basemap === "osm" && (
              <a
                className="web-attribution"
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("© OpenStreetMap 贡献者")}
              </a>
            )}
          </div>
          <section className="web-attributes" aria-label={t("属性查看")}>
            <header>
              <strong>
                {active ? t(`${nameOf(active)} · 属性`) : t("属性表")}
              </strong>
              <label>
                <Search size={15} />
                <input
                  aria-label={t("搜索属性")}
                  placeholder={t("搜索属性")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <button
                disabled={!active || busy}
                onClick={() => {
                  setError("");
                  setExportName(
                    active ? nameOf(active).replace(/\.[^.]+$/, "") : "layer",
                  );
                  setExportId(activeId);
                }}
              >
                <Download size={15} />
                {t("下载图层")}
              </button>
            </header>
            <div className="web-table-scroll">
              <table aria-label={t("图层属性")}>
                <thead>
                  <tr>
                    <th>{t("要素")}</th>
                    <th>{t("几何")}</th>
                    {fields.map((field) => (
                      <th key={field}>{field}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered
                    .slice(
                      Math.min(page, pages - 1) * 100,
                      (Math.min(page, pages - 1) + 1) * 100,
                    )
                    .map((feature) => (
                      <tr
                        key={feature.id}
                        aria-selected={selectedId === feature.id}
                        tabIndex={0}
                        aria-label={t(`选择要素 ${feature.id}`)}
                        onKeyDown={(event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedId(feature.id);
                          }
                        }}
                        onClick={() => setSelectedId(feature.id)}
                      >
                        <td>
                          <button
                            aria-label={t(`定位要素 ${feature.id}`)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedId(feature.id);
                              setFeatureFitNonce((value) => value + 1);
                            }}
                          >
                            {feature.id}
                          </button>
                        </td>
                        <td>{feature.geometry?.type ?? t("空几何")}</td>
                        {fields.map((field) => (
                          <td
                            key={field}
                            title={cell(feature.properties[field])}
                          >
                            {cell(feature.properties[field])}
                          </td>
                        ))}
                      </tr>
                    ))}
                </tbody>
              </table>
              {!filtered.length && (
                <p className="web-empty">
                  {active ? t("没有匹配要素。") : t("选择图层查看属性。")}
                </p>
              )}
            </div>
            <footer>
              <span>
                {t(
                  `${filtered.length} 个要素 · 第 ${Math.min(page, pages - 1) + 1} / ${pages} 页`,
                )}
              </span>
              <button
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                {t("上一页")}
              </button>
              <button
                disabled={page >= pages - 1}
                onClick={() => setPage((value) => value + 1)}
              >
                {t("下一页")}
              </button>
            </footer>
          </section>
        </main>
        {toolboxOpen && (
          <div className="web-toolbox">
            <ProcessingToolbox
              layers={layers}
              activeLayerId={activeId}
              selectedFeatureId={selectedId}
              editing={editing}
              blockedReason={
                busy && !job.current ? t("请等待当前操作完成") : undefined
              }
              onRun={analyze}
              onClose={() => setToolboxOpen(false)}
              onLocateResult={locate}
            />
          </div>
        )}
      </div>
      <footer className="web-status" role="status">
        <span>{t(status)}</span>
        {cancellable && (
          <button onClick={() => void cancelCurrent()}>
            {t("取消当前操作")}
          </button>
        )}
        <span>
          {position.length
            ? `${position[0].toFixed(5)}, ${position[1].toFixed(5)}`
            : "WGS84"}
        </span>
      </footer>
      {error && !pendingFiles.length && !exportId && (
        <div className="web-error" role="alert">
          {t(error)}
          <button aria-label={t("关闭错误")} onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {!!pendingFiles.length && (
        <Modal
          title={t("导入文件")}
          onClose={() => {
            if (!busy) {
              setPendingFiles([]);
              setError("");
            }
          }}
        >
          <p className="form-note">
            {t("文件不会上传。工作坐标为 WGS84；单次文件总大小上限 100 MB。")}
          </p>
          <ImportPanel
            files={pendingFiles}
            busy={busy}
            error={t(error)}
            onImport={(options) => void importFiles(options)}
            onClose={() => {
              setPendingFiles([]);
              setError("");
            }}
            onChange={() => setError("")}
          />
          {cancellable && (
            <button onClick={() => void cancelCurrent()}>
              {t("取消当前操作")}
            </button>
          )}
        </Modal>
      )}
      {exporting && (
        <Modal
          title={t("下载图层")}
          onClose={() => {
            if (!busy) setExportId(undefined);
          }}
        >
          <div className="web-export">
            <p>
              {nameOf(exporting)} · {t(`${exporting.features.length} 个要素`)}
            </p>
            <label>
              {t("文件名")}
              <input
                aria-label={t("文件名")}
                value={exportName}
                disabled={busy}
                onChange={(event) => setExportName(event.target.value)}
              />
            </label>
            <label>
              {t("输出格式")}
              <select
                aria-label={t("输出格式")}
                value={exportMode}
                disabled={busy}
                onChange={(event) =>
                  setExportMode(event.target.value as typeof exportMode)
                }
              >
                <option value="geojson">GeoJSON</option>
                <option value="wkt">CSV · WKT</option>
                <option value="xy">CSV · X/Y</option>
                <option value="shp">Shapefile · ZIP</option>
              </select>
            </label>
            <label>
              {t("目标坐标系")}
              <select
                aria-label={t("目标坐标系")}
                value={exportCrs}
                disabled={busy}
                onChange={(event) => setExportCrs(event.target.value)}
              >
                <option>EPSG:4326</option>
                <option>EPSG:4490</option>
                <option>EPSG:3857</option>
              </select>
            </label>
            {exportMode === "xy" && (
              <p className="form-note">
                {t("X/Y 仅支持二维点，线面或高程请使用 WKT 或 GeoJSON。")}
              </p>
            )}
            {exportMode !== "geojson" && (
              <p className="form-note">
                {t(
                  "CSV 中嵌套属性为 JSON 文本，空字符串与 NULL 不保真；SHP 字段和几何须满足格式限制，无法保真时会提示错误。",
                )}
              </p>
            )}
            {exportMode === "geojson" && exportCrs !== "EPSG:4326" && (
              <p className="form-note">
                {t(
                  "输出含 crs 标记的传统 GeoJSON，仅接受 RFC 7946 的软件可能不支持。",
                )}
              </p>
            )}
            {error && (
              <p role="alert" className="inline-error">
                {t(error)}
              </p>
            )}
          </div>
          <div className="modal-actions">
            {cancellable && exportMode === "shp" && (
              <button onClick={() => void cancelCurrent()}>
                {t("取消当前操作")}
              </button>
            )}
            <button disabled={busy} onClick={() => setExportId(undefined)}>
              {t("取消")}
            </button>
            <button disabled={busy} onClick={() => void exportLayer()}>
              {busy ? t("生成中…") : t("下载")}
            </button>
          </div>
        </Modal>
      )}
      {removing && (
        <Modal title={t("移除图层")} onClose={() => setRemoveId(undefined)}>
          <p>
            {t(`移除“${nameOf(removing)}”？`)}{" "}
            {removing.dirty
              ? t("此结果尚未下载，移除后将丢失。")
              : t("本地源文件不会改变。")}
          </p>
          <div className="modal-actions">
            <button onClick={() => setRemoveId(undefined)}>{t("取消")}</button>
            <button
              onClick={() => {
                setLayers((old) =>
                  old.filter((layer) => layer.id !== removeId),
                );
                if (activeId === removeId) {
                  setActiveId(
                    layers.find((layer) => layer.id !== removeId)?.id,
                  );
                  setSelectedId(undefined);
                }
                setRemoveId(undefined);
              }}
            >
              {t("移除")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
