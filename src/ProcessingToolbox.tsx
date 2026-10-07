import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  History,
  LocateFixed,
  Play,
  Search,
  Star,
  X,
} from "lucide-react";
import type { Geometry } from "geojson";
import type { DocumentLayer } from "./domain/types";
import {
  analysisToolCategories,
  analysisTools,
  getAnalysisTool,
  type AnalysisGeometryKind,
  type AnalysisTool,
} from "./analysisTools";
import "./processing-toolbox.css";

export interface ProcessingRequest {
  operation: string;
  sourceId: string;
  targetId?: string;
  selectedOnly: boolean;
  parameters: Record<string, unknown>;
  outputName: string;
}
export interface ProcessingOutcome {
  featureCount?: number;
  layerId?: string;
  layerName?: string;
  report?: Record<string, unknown>;
  durationMs: number;
}
export interface ProcessingToolboxProps {
  layers: DocumentLayer[];
  activeLayerId?: string;
  selectedFeatureId?: string;
  editing: boolean;
  blockedReason?: string;
  onRun: (request: ProcessingRequest) => Promise<ProcessingOutcome>;
  onClose: () => void;
  onLocateResult: (layerId: string) => void;
  onRunningChange?: (running: boolean) => void;
}
interface ToolForm {
  sourceId: string;
  targetId: string;
  selectedOnly: boolean;
  distanceMeters: string;
  toleranceMeters: string;
  groupBy?: string;
  predicate: string;
  outputName: string;
  customName: boolean;
}
interface RunRecord {
  id: number;
  request: ProcessingRequest;
  sourceName: string;
  targetName?: string;
  time: string;
  outcome?: ProcessingOutcome;
  error?: string;
}
type ToolFilter = "all" | "favorites" | "recent";
const favoriteKey = "zgis.processing.favorites.v1";
const recentKey = "zgis.processing.recent.v1";
const predicates = [
  ["intersects", "相交或接触"],
  ["within", "输入在目标内部"],
  ["contains", "输入包含目标"],
  ["touches", "仅边界接触"],
  ["disjoint", "与全部目标不相交"],
] as const;
const kindLabels: Record<AnalysisGeometryKind, string> = {
  point: "点",
  line: "线",
  polygon: "面",
};

function readToolIds(key: string): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(ids)
      ? [
          ...new Set(
            ids.filter(
              (id): id is string =>
                typeof id === "string" && Boolean(getAnalysisTool(id)),
            ),
          ),
        ].slice(0, analysisTools.length)
      : [];
  } catch {
    return [];
  }
}
function persistToolIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* 不影响分析功能。 */
  }
}
function layerName(layer: DocumentLayer): string {
  return layer.displayName || layer.name;
}
function geometryKind(geometry: Geometry): AnalysisGeometryKind | undefined {
  if (geometry.type === "Point" || geometry.type === "MultiPoint")
    return "point";
  if (geometry.type === "LineString" || geometry.type === "MultiLineString")
    return "line";
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon")
    return "polygon";
}
function hasElevation(geometry: Geometry): boolean {
  if (geometry.type === "GeometryCollection")
    return geometry.geometries.some(hasElevation);
  const walk = (coordinates: unknown): boolean =>
    Array.isArray(coordinates) &&
    (typeof coordinates[0] === "number"
      ? coordinates.length > 2
      : coordinates.some(walk));
  return walk(geometry.coordinates);
}
function layerIssue(
  layer: DocumentLayer | undefined,
  tool: AnalysisTool,
  target = false,
): string {
  const label = target ? "目标图层" : "输入图层";
  if (!layer) return `请选择${label}。`;
  if (layer.features.length === 0) return `${label}为空，请先导入或创建要素。`;
  if (layer.features.length > 10000)
    return target
      ? `${label}超过 10000 个要素，请缩小目标范围。`
      : `${label}超过 10000 个要素，请缩小输入范围或仅使用选中的要素。`;
  const kinds = target
    ? (tool.targetKinds ?? tool.sourceKinds)
    : tool.sourceKinds;
  for (const feature of layer.features) {
    if (feature.geometry && hasElevation(feature.geometry))
      return `${label}含高程。分析仅支持二维；含高程请先导出二维副本。`;
  }
  for (const feature of layer.features) {
    if (!feature.geometry) {
      if (tool.id === "topology_check" && !target) continue;
      return `${label}包含无几何要素，请先补充几何或使用拓扑检查定位问题。`;
    }
    const kind = geometryKind(feature.geometry);
    if (!kind || !kinds.includes(kind))
      return `${label}须只包含${kinds.map((value) => kindLabels[value]).join("、")}几何。`;
  }
  return "";
}
function defaultOutput(tool: AnalysisTool, source?: DocumentLayer) {
  return (
    source
      ? `${layerName(source).replace(/\.[^.]+$/, "")}_${tool.label}`
      : tool.label
  ).slice(0, 100);
}
function initialForm(
  tool: AnalysisTool,
  layers: DocumentLayer[],
  activeId?: string,
): ToolForm {
  const source =
    layers.find((layer) => layer.id === activeId) ??
    layers.find((layer) => !layerIssue(layer, tool)) ??
    layers[0];
  const target = layers.find(
    (layer) => layer.id !== source?.id && !layerIssue(layer, tool, true),
  );
  return {
    sourceId: source?.id ?? "",
    targetId: target?.id ?? "",
    selectedOnly: false,
    distanceMeters: "100",
    toleranceMeters: "10",
    predicate: "intersects",
    outputName: defaultOutput(tool, source),
    customName: false,
  };
}
function recordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: 6 })
    : "—";
}
function featureOrdinal(value: unknown): string {
  return typeof value === "number" ? `第 ${value + 1} 个` : "—";
}
function AnalysisReport({
  operation,
  report,
}: {
  operation: string;
  report: Record<string, unknown>;
}) {
  if (operation === "topology_check") {
    const issues = Array.isArray(report.issues)
      ? report.issues
          .map(recordObject)
          .filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const issueLabels: Record<string, string> = {
      invalid_geometry: "无效几何",
      duplicate_geometry: "重复几何",
      polygon_overlap: "面重叠",
    };
    return (
      <div className="processing-report">
        <p>
          已检查 {formatNumber(report.featureCount)} 个要素，发现{" "}
          {issues.length.toLocaleString("zh-CN")} 个问题。
        </p>
        {issues.length === 0 ? (
          <p>未发现本次检查范围内的问题。</p>
        ) : (
          <>
            <div className="processing-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>问题</th>
                    <th>输入要素序号</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.slice(0, 100).map((issue, index) => (
                    <tr key={index}>
                      <td>
                        {issueLabels[String(issue.kind)] ??
                          String(issue.kind ?? "几何问题")}
                      </td>
                      <td>
                        {Array.isArray(issue.featureIndices)
                          ? issue.featureIndices.map(featureOrdinal).join("、")
                          : featureOrdinal(issue.featureIndex)}
                      </td>
                      <td>
                        {typeof issue.message === "string"
                          ? issue.message
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {issues.length > 100 && (
              <p className="processing-note">
                显示前 100 个问题，请缩小输入范围逐批检查。
              </p>
            )}
          </>
        )}
        <p className="processing-note">
          检查几何有效性、完全重复和面重叠；不自动修复。
        </p>
      </div>
    );
  }
  if (operation === "layer_summary") {
    const types = recordObject(report.geometryTypes) ?? {};
    const geometryLabels: Record<string, string> = {
      Point: "点",
      MultiPoint: "多点",
      LineString: "线",
      MultiLineString: "多线",
      Polygon: "面",
      MultiPolygon: "多面",
    };
    const bbox =
      Array.isArray(report.bbox) && report.bbox.length === 4
        ? report.bbox
        : undefined;
    const fields = Array.isArray(report.fields)
      ? report.fields.filter(
          (field): field is string => typeof field === "string",
        )
      : [];
    return (
      <div className="processing-report">
        <dl>
          <dt>要素数量</dt>
          <dd>{formatNumber(report.featureCount)}</dd>
          <dt>坐标系</dt>
          <dd>{typeof report.crs === "string" ? report.crs : "WGS84"}</dd>
          <dt>几何类型</dt>
          <dd>
            {Object.entries(types)
              .map(
                ([type, count]) =>
                  `${geometryLabels[type] ?? type} ${formatNumber(count)}`,
              )
              .join("、") || "无几何"}
          </dd>
          <dt>字段（{fields.length}）</dt>
          <dd>
            {fields.map((field) => field || "（空字段名）").join("、") ||
              "无属性字段"}
          </dd>
          <dt>经度范围</dt>
          <dd>
            {bbox
              ? `${formatNumber(bbox[0])} ～ ${formatNumber(bbox[2])}`
              : "无范围"}
          </dd>
          <dt>纬度范围</dt>
          <dd>
            {bbox
              ? `${formatNumber(bbox[1])} ～ ${formatNumber(bbox[3])}`
              : "无范围"}
          </dd>
        </dl>
      </div>
    );
  }
  return <p className="processing-note">分析报告已生成。</p>;
}

export function ProcessingToolbox({
  layers,
  activeLayerId,
  selectedFeatureId,
  editing,
  blockedReason,
  onRun,
  onClose,
  onLocateResult,
  onRunningChange,
}: ProcessingToolboxProps) {
  const [toolId, setToolId] = useState("buffer");
  const [forms, setForms] = useState<Record<string, ToolForm>>(() => ({
    buffer: initialForm(analysisTools[0], layers, activeLayerId),
  }));
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");
  const [favorites, setFavorites] = useState(() => readToolIds(favoriteKey));
  const [recent, setRecent] = useState(() => readToolIds(recentKey));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RunRecord>();
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const locked = useRef(false);
  const alive = useRef(true);
  const runSequence = useRef(0);
  const tool = getAnalysisTool(toolId) ?? analysisTools[0];
  const form = forms[tool.id] ?? initialForm(tool, layers, activeLayerId);
  const source = layers.find((layer) => layer.id === form.sourceId);
  const target = layers.find((layer) => layer.id === form.targetId);
  const canUseSelected = Boolean(
    source &&
    source.id === activeLayerId &&
    selectedFeatureId &&
    source.features.some((feature) => feature.id === selectedFeatureId),
  );
  const selectedOnly = form.selectedOnly && canUseSelected;
  const validationSource = useMemo(
    () =>
      selectedOnly && source
        ? {
            ...source,
            features: source.features.filter(
              (feature) => feature.id === selectedFeatureId,
            ),
          }
        : source,
    [source, selectedOnly, selectedFeatureId],
  );
  const fields = useMemo(
    () =>
      source
        ? [
            ...new Set([
              ...(source.fieldNames ?? []),
              ...source.features.flatMap((feature) =>
                Object.keys(feature.properties),
              ),
            ]),
          ]
            .filter(Boolean)
            .sort()
        : [],
    [source],
  );
  const geometryError = useMemo(
    () =>
      layerIssue(validationSource, tool) ||
      (tool.requiresTarget ? layerIssue(target, tool, true) : ""),
    [validationSource, target, tool],
  );
  const numericValue = tool.parameters.includes("distanceMeters")
    ? form.distanceMeters
    : form.toleranceMeters;
  const numericError =
    (tool.parameters.includes("distanceMeters") ||
      tool.parameters.includes("toleranceMeters")) &&
    !(
      numericValue.trim() &&
      Number.isFinite(Number(numericValue)) &&
      Number(numericValue) > 0 &&
      Number(numericValue) <= 100000
    )
      ? "距离或容差须大于 0 且不超过 100000 米。"
      : "";
  const fieldError =
    tool.parameters.includes("groupBy") &&
    form.groupBy !== undefined &&
    !fields.includes(form.groupBy)
      ? "分组字段已不存在，请重新选择。"
      : "";
  const unavailableReason = running
    ? ""
    : editing
      ? "请先保存并退出编辑模式，再运行分析。"
      : blockedReason ||
        geometryError ||
        numericError ||
        fieldError ||
        (!tool.report && !form.outputName.trim()
          ? "请输入结果图层名称。"
          : "") ||
        (!tool.report && form.outputName.trim().length > 100
          ? "结果图层名称不超过 100 个字符。"
          : "");
  const visibleTools = analysisTools.filter(
    (item) =>
      (!category || item.category === category) &&
      (filter === "all" ||
        (filter === "favorites" ? favorites : recent).includes(item.id)) &&
      `${item.label} ${item.id} ${item.description} ${item.keywords.join(" ")}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const sortedTools =
    filter === "recent"
      ? [...visibleTools].sort(
          (a, b) => recent.indexOf(a.id) - recent.indexOf(b.id),
        )
      : visibleTools;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (form.selectedOnly && !canUseSelected)
      setForms((current) => ({
        ...current,
        [tool.id]: { ...form, selectedOnly: false },
      }));
  }, [canUseSelected, form, tool.id]);

  function changeForm(patch: Partial<ToolForm>) {
    if (locked.current) return;
    setForms((current) => ({ ...current, [tool.id]: { ...form, ...patch } }));
    setError("");
  }
  function chooseTool(id: string) {
    if (locked.current) return;
    const next = getAnalysisTool(id);
    if (!next) return;
    setToolId(id);
    setForms((current) =>
      current[id]
        ? current
        : { ...current, [id]: initialForm(next, layers, activeLayerId) },
    );
    setError("");
    setResult(undefined);
  }
  function toggleFavorite(id: string) {
    const next = favorites.includes(id)
      ? favorites.filter((value) => value !== id)
      : [...favorites, id];
    setFavorites(next);
    persistToolIds(favoriteKey, next);
  }
  function refill(record: RunRecord) {
    if (locked.current) return;
    const nextTool = getAnalysisTool(record.request.operation);
    if (!nextTool) return;
    const parameters = record.request.parameters;
    setToolId(nextTool.id);
    setForms((current) => ({
      ...current,
      [nextTool.id]: {
        ...initialForm(nextTool, layers, activeLayerId),
        sourceId: record.request.sourceId,
        targetId: record.request.targetId ?? "",
        selectedOnly:
          record.request.selectedOnly &&
          record.request.sourceId === activeLayerId &&
          Boolean(selectedFeatureId),
        outputName: record.request.outputName,
        customName: true,
        distanceMeters: String(parameters.distanceMeters ?? 100),
        toleranceMeters: String(parameters.toleranceMeters ?? 10),
        groupBy:
          typeof parameters.groupBy === "string"
            ? parameters.groupBy
            : undefined,
        predicate:
          typeof parameters.predicate === "string"
            ? parameters.predicate
            : "intersects",
      },
    }));
    setError("");
    setResult(record);
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || unavailableReason) return;
    locked.current = true;
    setRunning(true);
    onRunningChange?.(true);
    setError("");
    setResult(undefined);
    const parameters: Record<string, unknown> = {};
    if (tool.parameters.includes("distanceMeters"))
      parameters.distanceMeters = Number(form.distanceMeters);
    if (tool.parameters.includes("toleranceMeters"))
      parameters.toleranceMeters = Number(form.toleranceMeters);
    if (tool.parameters.includes("groupBy") && form.groupBy !== undefined)
      parameters.groupBy = form.groupBy;
    if (tool.parameters.includes("predicate"))
      parameters.predicate = form.predicate;
    const request: ProcessingRequest = {
      operation: tool.id,
      sourceId: form.sourceId,
      ...(tool.requiresTarget ? { targetId: form.targetId } : {}),
      selectedOnly,
      parameters,
      outputName: form.outputName.trim(),
    };
    const record: RunRecord = {
      id: ++runSequence.current,
      request,
      sourceName: source ? layerName(source) : "",
      targetName: tool.requiresTarget && target ? layerName(target) : undefined,
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    };
    const nextRecent = [
      tool.id,
      ...recent.filter((id) => id !== tool.id),
    ].slice(0, 8);
    setRecent(nextRecent);
    persistToolIds(recentKey, nextRecent);
    try {
      const outcome = await onRun(request);
      if (alive.current) {
        const completed = { ...record, outcome };
        setResult(completed);
        setRecords((current) => [completed, ...current].slice(0, 20));
      }
    } catch (reason) {
      if (alive.current) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        setError(message);
        setRecords((current) =>
          [{ ...record, error: message }, ...current].slice(0, 20),
        );
      }
    } finally {
      locked.current = false;
      if (alive.current) setRunning(false);
      onRunningChange?.(false);
    }
  }

  return (
    <aside
      className="processing-toolbox"
      aria-label="空间分析工具箱"
      aria-busy={running}
    >
      <header className="processing-heading">
        <strong>空间分析工具箱</strong>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭空间分析工具箱"
          title={running ? "请等待分析完成" : "关闭工具箱"}
          disabled={running}
          onClick={() => {
            if (!locked.current) onClose();
          }}
        >
          <X size={16} />
        </button>
      </header>
      <div className="processing-body">
        <section className="processing-browser" aria-label="分析工具">
          <div className="processing-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="搜索分析工具"
              placeholder="搜索工具名称 / 英文别名"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={running}
            />
          </div>
          <div className="processing-filter-row">
            <div className="processing-filter" aria-label="工具筛选">
              {(
                [
                  ["all", "全部"],
                  ["favorites", "收藏"],
                  ["recent", "最近"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  disabled={running}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              aria-label="分析工具分类"
              value={category}
              disabled={running}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">所有分类</option>
              {analysisToolCategories.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </div>
          <div className="processing-tool-list">
            {sortedTools.length === 0 ? (
              <p className="processing-empty">
                {query.trim()
                  ? "没有匹配的工具，试试中文或英文名称。"
                  : filter === "favorites"
                    ? "点击工具旁的星标，收藏常用工具。"
                    : "还没有使用记录。选择全部工具开始分析。"}
              </p>
            ) : (
              analysisToolCategories.map((group) => {
                const items = sortedTools.filter(
                  (item) => item.category === group,
                );
                return (
                  items.length > 0 && (
                    <div className="processing-tool-group" key={group}>
                      <p className="processing-group-label">{group}</p>
                      {items.map((item) => (
                        <div className="processing-tool-row" key={item.id}>
                          <button
                            className="processing-tool-option"
                            type="button"
                            disabled={running}
                            aria-pressed={tool.id === item.id}
                            title={item.description}
                            onClick={() => chooseTool(item.id)}
                          >
                            <span>{item.label}</span>
                            {tool.id === item.id && (
                              <Check size={13} aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            className={`processing-favorite${favorites.includes(item.id) ? " is-favorite" : ""}`}
                            disabled={running}
                            aria-label={`${favorites.includes(item.id) ? "取消收藏" : "收藏"}${item.label}`}
                            aria-pressed={favorites.includes(item.id)}
                            onClick={() => toggleFavorite(item.id)}
                          >
                            <Star size={14} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )
                );
              })
            )}
          </div>
        </section>
        <form className="processing-form" onSubmit={(event) => void run(event)}>
          <div className="processing-tool-title">
            <h3>{tool.label}</h3>
            <span>{tool.category}</span>
          </div>
          <p className="processing-description">{tool.description}</p>
          <fieldset disabled={running}>
            <label>
              输入图层
              <select
                aria-label="输入图层"
                value={form.sourceId}
                onChange={(event) => {
                  const next = layers.find(
                    (layer) => layer.id === event.target.value,
                  );
                  changeForm({
                    sourceId: event.target.value,
                    selectedOnly: false,
                    groupBy: undefined,
                    ...(!form.customName
                      ? { outputName: defaultOutput(tool, next) }
                      : {}),
                  });
                }}
              >
                <option value="">请选择输入图层</option>
                {form.sourceId && !source && (
                  <option value={form.sourceId}>原输入图层已移除</option>
                )}
                {layers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layerName(layer)} ·{" "}
                    {layer.features.length.toLocaleString("zh-CN")} 个要素
                  </option>
                ))}
              </select>
            </label>
            <label className="processing-selected">
              <input
                type="checkbox"
                aria-label="仅使用选中的要素"
                checked={selectedOnly}
                disabled={!canUseSelected || running}
                onChange={(event) =>
                  changeForm({ selectedOnly: event.target.checked })
                }
              />
              仅使用选中的要素
              <span>
                {canUseSelected ? "1 个" : "先在当前输入图层选中要素"}
              </span>
            </label>
            {tool.requiresTarget && (
              <label>
                目标图层
                <select
                  aria-label="目标图层"
                  value={form.targetId}
                  onChange={(event) =>
                    changeForm({ targetId: event.target.value })
                  }
                >
                  <option value="">请选择目标图层</option>
                  {form.targetId && !target && (
                    <option value={form.targetId}>原目标图层已移除</option>
                  )}
                  {layers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layerName(layer)} ·{" "}
                      {layer.features.length.toLocaleString("zh-CN")} 个要素
                    </option>
                  ))}
                </select>
              </label>
            )}
            {tool.parameters.includes("distanceMeters") && (
              <label>
                缓冲距离（米）
                <input
                  type="number"
                  min="0"
                  max="100000"
                  step="any"
                  value={form.distanceMeters}
                  onChange={(event) =>
                    changeForm({ distanceMeters: event.target.value })
                  }
                  required
                />
              </label>
            )}
            {tool.parameters.includes("toleranceMeters") && (
              <label>
                简化容差（米）
                <input
                  type="number"
                  min="0"
                  max="100000"
                  step="any"
                  value={form.toleranceMeters}
                  onChange={(event) =>
                    changeForm({ toleranceMeters: event.target.value })
                  }
                  required
                />
              </label>
            )}
            {tool.parameters.includes("groupBy") && (
              <label>
                分组字段
                <select
                  aria-label="分组字段"
                  value={
                    form.groupBy === undefined
                      ? "all"
                      : `field:${fields.indexOf(form.groupBy)}`
                  }
                  onChange={(event) =>
                    changeForm({
                      groupBy:
                        event.target.value === "all"
                          ? undefined
                          : fields[Number(event.target.value.slice(6))],
                    })
                  }
                >
                  <option value="all">不分组，融合全部面</option>
                  {form.groupBy !== undefined &&
                    !fields.includes(form.groupBy) && (
                      <option value="field:-1">原分组字段已移除</option>
                    )}
                  {fields.map((field, index) => (
                    <option key={field} value={`field:${index}`}>
                      {field || "（空字段名）"}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {tool.parameters.includes("predicate") && (
              <label>
                空间关系
                <select
                  aria-label="空间关系"
                  value={form.predicate}
                  onChange={(event) =>
                    changeForm({ predicate: event.target.value })
                  }
                >
                  {predicates.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!tool.report && (
              <label>
                结果图层名称
                <input
                  maxLength={100}
                  value={form.outputName}
                  onChange={(event) =>
                    changeForm({
                      outputName: event.target.value,
                      customName: true,
                    })
                  }
                  required
                />
              </label>
            )}
          </fieldset>
          {layers.length === 0 && (
            <p className="processing-notice">
              尚无图层。先从文件导入数据，或新建矢量图层并保存编辑。
            </p>
          )}
          {tool.metric && (
            <p className="processing-note">
              使用近似米制度量，适用于局部、低中纬度数据；大范围或高纬度分析请使用专业投影工具。
            </p>
          )}
          <details className="processing-help">
            <summary>
              使用说明
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <p>{tool.help}</p>
            <p>
              分析仅支持二维。不修改输入数据；生成的独立结果图层可通过正常保存入口保存。
            </p>
          </details>
          {unavailableReason && (
            <p className="processing-notice" id="processing-unavailable">
              {unavailableReason}
            </p>
          )}
          {error && (
            <div role="alert" className="processing-error">
              分析失败：{error}
              <p>输入已保留，调整后可重新运行。</p>
            </div>
          )}
          <button
            className="processing-run"
            type="submit"
            disabled={running || Boolean(unavailableReason)}
            aria-describedby={
              unavailableReason ? "processing-unavailable" : undefined
            }
          >
            <Play size={15} aria-hidden="true" />
            {running ? "正在分析…" : "运行分析"}
          </button>
          <div role="status" aria-live="polite" className="processing-status">
            {running
              ? "正在处理输入数据，请等待完成。"
              : result?.outcome
                ? `分析完成${result.outcome.featureCount === undefined ? "" : `，输出 ${result.outcome.featureCount.toLocaleString("zh-CN")} 个要素`}，用时 ${(result.outcome.durationMs / 1000).toFixed(2)} 秒。`
                : ""}
          </div>
          {result?.outcome && (
            <section className="processing-result" aria-label="分析结果">
              {result.outcome.layerId && (
                <div className="processing-result-layer">
                  <strong>
                    {result.outcome.layerName || result.request.outputName}
                  </strong>
                  <button
                    type="button"
                    disabled={
                      running ||
                      !layers.some(
                        (layer) => layer.id === result.outcome?.layerId,
                      )
                    }
                    onClick={() => {
                      if (result.outcome?.layerId)
                        onLocateResult(result.outcome.layerId);
                    }}
                  >
                    <LocateFixed size={14} />
                    定位结果
                  </button>
                </div>
              )}
              {result.outcome.featureCount === 0 && (
                <p>没有匹配要素。可调整空间关系或输入范围后重新分析。</p>
              )}
              {result.outcome.report && (
                <AnalysisReport
                  operation={result.request.operation}
                  report={result.outcome.report}
                />
              )}
            </section>
          )}
        </form>
        <section className="processing-history" aria-label="本次运行记录">
          <button
            className="processing-history-toggle"
            type="button"
            aria-expanded={historyOpen}
            aria-controls="processing-run-records"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <History size={15} />
            <span>本次运行记录</span>
            <span>{records.length}</span>
            <ChevronDown size={14} />
          </button>
          {historyOpen && (
            <div id="processing-run-records">
              {records.length === 0 ? (
                <p className="processing-note">
                  运行后可在这里回填参数。本次会话最多保留 20 条。
                </p>
              ) : (
                <>
                  <p className="processing-note">
                    点击记录回填参数；不会自动运行。
                  </p>
                  {records.map((record) => (
                    <button
                      type="button"
                      key={record.id}
                      className="processing-history-item"
                      disabled={running}
                      onClick={() => refill(record)}
                    >
                      <span>
                        <strong>
                          {getAnalysisTool(record.request.operation)?.label}
                        </strong>
                        <time>{record.time}</time>
                      </span>
                      <span className="processing-history-source">
                        {record.sourceName}
                        {record.targetName ? ` → ${record.targetName}` : ""}
                      </span>
                      <span
                        className={
                          record.error
                            ? "processing-history-error"
                            : "processing-history-state"
                        }
                      >
                        {record.error
                          ? "失败 · 可调整后重试"
                          : record.outcome?.featureCount === undefined
                            ? "报告已生成"
                            : `${record.outcome.featureCount.toLocaleString("zh-CN")} 个结果要素`}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

export default ProcessingToolbox;
