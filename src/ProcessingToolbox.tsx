import type { AnalysisExplanation } from "./analysisResult";
import { locateAnalysisIssue, refreshAnalysisLocation, type AnalysisLocation, type AnalysisFocus } from "./analysisLocation";
import { t, useLocale } from "./i18n";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, LocateFixed, Play, Search, X } from "lucide-react";
import type { Geometry } from "geojson";
import type { DocumentLayer } from "./domain/types";
import {
  analysisToolCategories,
  analysisTools,
  getAnalysisTool,
  validAnalysisNumber,
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
  location?: AnalysisLocation;
  explanation?: AnalysisExplanation;
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
  onLocateIssue?: (focus?: AnalysisFocus) => void;
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
interface AnalysisResult {
  request: ProcessingRequest;
  outcome: ProcessingOutcome;
}
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
function hasUnsupportedCoordinates(geometry: Geometry): boolean {
  if (geometry.type === "GeometryCollection")
    return geometry.geometries.some(hasUnsupportedCoordinates);
  const walk = (coordinates: unknown): boolean =>
    Array.isArray(coordinates) &&
    (typeof coordinates[0] === "number"
      ? ![2, 3].includes(coordinates.length) ||
        coordinates.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        )
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
    if (feature.geometry && hasUnsupportedCoordinates(feature.geometry))
      return `${label}仅支持有限数值的 XY 或 XYZ 坐标，不支持 M/ZM。`;
  }
  for (const feature of layer.features) {
    if (!feature.geometry) {
      if (["topology_check", "clean_geometries"].includes(tool.id) && !target) continue;
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
      ? `${layerName(source).replace(/\.[^.]+$/, "")}_${t(tool.label)}`
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
  return typeof value === "number" ? t("第 {0} 个", value + 1) : "—";
}
function AnalysisReport({
  operation,
  report,
  onLocate,
}: {
  operation: string;
  report: Record<string, unknown>;
  onLocate?: (issue: Record<string, unknown>) => void;
}) {
  useLocale();
  if (operation === "topology_check") {
    const issues = Array.isArray(report.issues)
      ? report.issues
          .map(recordObject)
          .filter((item): item is Record<string, unknown> => Boolean(item))
      : [];
    const issueLabels: Record<string, string> = {
      invalid_geometry: "无效几何",
      duplicate_geometry: "重复几何",
      topological_duplicate: "拓扑重复几何（XY）",
      polygon_overlap: "面重叠",
    };
    return (
      <div className="processing-report">
        <p>
          {t(
            "已检查 {0} 个要素，发现 {1} 个问题。",
            formatNumber(report.featureCount),
            issues.length.toLocaleString(),
          )}
        </p>
        {issues.length === 0 ? (
          <p>{t("未发现本次检查范围内的问题。")}</p>
        ) : (
          <>
            <div className="processing-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("问题")}</th>
                    <th>{t("输入要素序号")}</th>
                    <th>{t("说明")}</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.slice(0, 100).map((issue, index) => (
                    <tr key={index}>
                      <td>
                        {t(
                          issueLabels[String(issue.kind)] ??
                            String(issue.kind ?? "几何问题"),
                        )}
                      </td>
                      <td>
                        {onLocate && <button type="button" onClick={() => onLocate(issue)}>{t("定位问题")}</button>}
                        {Array.isArray(issue.featureIndices)
                          ? issue.featureIndices.map(featureOrdinal).join("、")
                          : featureOrdinal(issue.featureIndex)}
                      </td>
                      <td>
                        {typeof issue.message === "string"
                          ? t(issue.message)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {issues.length > 100 && (
              <p className="processing-note">
                {t("显示前 100 个问题，请缩小输入范围逐批检查。")}
              </p>
            )}
          </>
        )}
        <p className="processing-note">
          {t("检查几何有效性、精确重复、XY 拓扑重复和面重叠；不自动修复。")}
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
          <dt>{t("要素数量")}</dt>
          <dd>{formatNumber(report.featureCount)}</dd>
          <dt>{t("坐标系")}</dt>
          <dd>{typeof report.crs === "string" ? report.crs : "WGS84"}</dd>
          <dt>{t("几何类型")}</dt>
          <dd>
            {Object.entries(types)
              .map(
                ([type, count]) =>
                  `${t(geometryLabels[type] ?? type)} ${formatNumber(count)}`,
              )
              .join("、") || t("无几何")}
          </dd>
          <dt>{t("字段（{0}）", fields.length)}</dt>
          <dd>
            {fields.map((field) => field || t("（空字段名）")).join(", ") ||
              t("无属性字段")}
          </dd>
          <dt>{t("经度范围")}</dt>
          <dd>
            {bbox
              ? `${formatNumber(bbox[0])} ～ ${formatNumber(bbox[2])}`
              : t("无范围")}
          </dd>
          <dt>{t("纬度范围")}</dt>
          <dd>
            {bbox
              ? `${formatNumber(bbox[1])} ～ ${formatNumber(bbox[3])}`
              : t("无范围")}
          </dd>
        </dl>
      </div>
    );
  }
  return <p className="processing-note">{t("分析报告已生成。")}</p>;
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
  onLocateIssue,
  onRunningChange,
}: ProcessingToolboxProps) {
  useLocale();
  const [toolId, setToolId] = useState("");
  const [forms, setForms] = useState<Record<string, ToolForm>>({});
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AnalysisResult>();
  useEffect(() => {
    const snapshot = result?.outcome.location;
    if (snapshot && !snapshot.stale && !refreshAnalysisLocation(snapshot, layers)) {
      setError("输入数据已变化，请重新运行检查后定位。");
      onLocateIssue?.();
    }
  }, [layers, result, onLocateIssue]);
  const locked = useRef(false);
  const alive = useRef(true);
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
  const numericKey = tool.parameters.includes("distanceMeters")
    ? "distanceMeters"
    : "toleranceMeters";
  const numericSchema = tool.parameterSchema.properties[numericKey];
  const numericValue = tool.parameters.includes("distanceMeters")
    ? form.distanceMeters
    : form.toleranceMeters;
  const numericError =
    (tool.parameters.includes("distanceMeters") ||
      tool.parameters.includes("toleranceMeters")) &&
    !validAnalysisNumber(tool, numericKey, numericValue)
      ? `距离或容差须大于 ${numericSchema?.exclusiveMinimum} 且不超过 ${numericSchema?.maximum} 米。`
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
  const visibleTools = analysisTools.filter((item) =>
    `${t(item.label)} ${item.label} ${item.id} ${item.keywords.map((keyword) => t(keyword)).join(" ")} ${item.keywords.join(" ")}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (toolId && form.selectedOnly && !canUseSelected)
      setForms((current) => ({
        ...current,
        [tool.id]: { ...form, selectedOnly: false },
      }));
  }, [canUseSelected, form, tool.id, toolId]);

  function changeForm(patch: Partial<ToolForm>) {
    if (locked.current) return;
    setForms((current) => ({ ...current, [tool.id]: { ...form, ...patch } }));
    setError("");
  }
  function chooseTool(id: string) {
    if (locked.current) return;
    onLocateIssue?.();
    const next = getAnalysisTool(id);
    if (!next) return;
    if (id === toolId) {
      setToolId("");
      setError("");
      setResult(undefined);
      return;
    }
    setToolId(id);
    setForms((current) =>
      current[id]
        ? current
        : { ...current, [id]: initialForm(next, layers, activeLayerId) },
    );
    setError("");
    setResult(undefined);
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!toolId || locked.current || unavailableReason) return;
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
    try {
      const outcome = await onRun(request);
      if (alive.current) {
        setResult({ request, outcome });
      }
    } catch (reason) {
      if (alive.current) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        setError(message);
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
      aria-label={t("空间分析工具")}
      aria-busy={running}
    >
      <header className="processing-heading">
        <strong>{t("工具")}</strong>
        <button
          type="button"
          className="icon-button"
          aria-label={t("关闭工具侧栏")}
          title={running ? t("请等待分析完成") : t("关闭工具侧栏")}
          disabled={running}
          onClick={() => {
            if (!locked.current) onClose();
          }}
        >
          <X size={16} />
        </button>
      </header>
      <div className="processing-body">
        <section className="processing-browser" aria-label={t("分析工具")}>
          <div className="processing-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label={t("搜索分析工具")}
              placeholder={t("搜索工具…")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={running}
            />
          </div>
          <nav className="processing-tool-list" aria-label={t("工具分类树")}>
            {visibleTools.length === 0 ? (
              <p className="processing-empty">{t("没有匹配的工具。")}</p>
            ) : (
              analysisToolCategories.map((group, index) => {
                const items = visibleTools.filter(
                  (item) => item.category === group,
                );
                if (!items.length) return null;
                const expanded =
                  Boolean(query.trim()) || expandedGroups.includes(group);
                return (
                  <div className="processing-tool-group" key={group}>
                    <button
                      type="button"
                      className="processing-group-toggle"
                      aria-expanded={expanded}
                      aria-controls={`processing-group-${index}`}
                      disabled={running}
                      onClick={() =>
                        setExpandedGroups((current) =>
                          current.includes(group)
                            ? current.filter((value) => value !== group)
                            : [...current, group],
                        )
                      }
                    >
                      <ChevronDown size={14} aria-hidden="true" />
                      <span>{t(group)}</span>
                    </button>
                    <div
                      id={`processing-group-${index}`}
                      role="group"
                      aria-label={t(group)}
                      hidden={!expanded}
                    >
                      {items.map((item) => (
                        <button
                          className="processing-tool-option"
                          type="button"
                          key={item.id}
                          disabled={running}
                          aria-pressed={toolId === item.id}
                          onClick={() => chooseTool(item.id)}
                        >
                          <span>{t(item.label)}</span>
                          {toolId === item.id && (
                            <Check size={13} aria-hidden="true" />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </nav>
        </section>
        {toolId && (
          <>
            <form
              className="processing-form"
              onSubmit={(event) => void run(event)}
            >
              <div className="processing-configuration">
                <div className="processing-tool-title">
                  <h3>{t(tool.label)}</h3>
                  <span>{t(tool.category)}</span>
                </div>
                <p className="processing-description">{t(tool.description)}</p>
                <div className="processing-parameters">
                  <fieldset disabled={running}>
                    <legend>{t("输入数据")}</legend>
                    <label>
                      <span>{t("输入图层")}</span>
                      <select
                        aria-label={t("输入图层")}
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
                        <option value="">{t("请选择输入图层")}</option>
                        {form.sourceId && !source && (
                          <option value={form.sourceId}>
                            {t("原输入图层已移除")}
                          </option>
                        )}
                        {layers.map((layer) => (
                          <option key={layer.id} value={layer.id}>
                            {layerName(layer)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="processing-selected">
                      <input
                        type="checkbox"
                        aria-label={t("仅使用选中的要素")}
                        checked={selectedOnly}
                        disabled={!canUseSelected || running}
                        onChange={(event) =>
                          changeForm({ selectedOnly: event.target.checked })
                        }
                      />
                      <span className="processing-selected-label">
                        {t("仅使用选中的要素")}
                      </span>
                      {canUseSelected && <span>{t("1 个")}</span>}
                    </label>
                    {tool.requiresTarget && (
                      <label>
                        <span>{t("目标图层")}</span>
                        <select
                          aria-label={t("目标图层")}
                          value={form.targetId}
                          onChange={(event) =>
                            changeForm({ targetId: event.target.value })
                          }
                        >
                          <option value="">{t("请选择目标图层")}</option>
                          {form.targetId && !target && (
                            <option value={form.targetId}>
                              {t("原目标图层已移除")}
                            </option>
                          )}
                          {layers.map((layer) => (
                            <option key={layer.id} value={layer.id}>
                              {layerName(layer)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {tool.parameters.includes("distanceMeters") && (
                      <label>
                        <span>{t("缓冲距离")}</span>
                        <div className="processing-number-unit">
                          <input
                            aria-label={t("缓冲距离（米）")}
                            type="number"
                            min={numericSchema?.exclusiveMinimum}
                            max={numericSchema?.maximum}
                            step="any"
                            value={form.distanceMeters}
                            onChange={(event) =>
                              changeForm({ distanceMeters: event.target.value })
                            }
                            required
                          />
                          <span aria-hidden="true">{t("米")}</span>
                        </div>
                      </label>
                    )}
                    {tool.parameters.includes("toleranceMeters") && (
                      <label>
                        <span>{t("简化容差（米）")}</span>
                        <input
                          type="number"
                          min={numericSchema?.exclusiveMinimum}
                          max={numericSchema?.maximum}
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
                        <span>{t("分组字段")}</span>
                        <select
                          aria-label={t("分组字段")}
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
                          <option value="all">{t("不分组，融合全部面")}</option>
                          {form.groupBy !== undefined &&
                            !fields.includes(form.groupBy) && (
                              <option value="field:-1">
                                {t("原分组字段已移除")}
                              </option>
                            )}
                          {fields.map((field, index) => (
                            <option key={field} value={`field:${index}`}>
                              {field || t("（空字段名）")}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {tool.parameters.includes("predicate") && (
                      <label>
                        <span>{t("空间关系")}</span>
                        <select
                          aria-label={t("空间关系")}
                          value={form.predicate}
                          onChange={(event) =>
                            changeForm({ predicate: event.target.value })
                          }
                        >
                          {predicates.map(([value, label]) => (
                            <option key={value} value={value}>
                              {t(label)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </fieldset>
                  {!tool.report && (
                    <fieldset className="processing-output" disabled={running}>
                      <legend>{t("输出设置")}</legend>
                      {!tool.report && (
                        <label>
                          <span>{t("结果图层名称")}</span>
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
                  )}
                </div>
                <details className="processing-help">
                  <summary>
                    {t("使用说明")}
                    <ChevronDown size={14} aria-hidden="true" />
                  </summary>
                  <p>{t(tool.help)}</p>
                  {tool.metric && (
                    <p>
                      {tool.id === "nearest"
                        ? t(
                            "Point 对使用 WGS84 椭球测地距离；其他几何使用成对局部近似，受 ±75° 纬度和 5° 跨度限制。",
                          )
                        : t(
                            "使用近似米制度量，适用于局部、低中纬度数据；大范围或高纬度分析请使用专业投影工具。",
                          )}
                    </p>
                  )}
                  <p>
                    {t(
                      "按 XY 分析，保留原顶点高程；无法确定高程的新点 Z=0。结果可保存为 GeoJSON 或 WKT。",
                    )}
                  </p>
                </details>
              </div>
              <section className="processing-action" aria-label={t("运行分析")}>
                <div className="processing-feedback">
                  {unavailableReason && (
                    <p
                      className="processing-notice"
                      id="processing-unavailable"
                    >
                      {t(unavailableReason)}
                    </p>
                  )}
                  {error && (
                    <div role="alert" className="processing-error">
                      {t("分析失败：")}
                      {t(error)}
                      <p>{t("输入已保留，调整后可重新运行。")}</p>
                    </div>
                  )}
                  <div
                    role="status"
                    aria-live="polite"
                    className="processing-status"
                  >
                    {running
                      ? t("正在处理输入数据，请等待完成。")
                      : result?.outcome
                        ? t(
                            "分析完成{0}，用时 {1} 秒。",
                            result.outcome.featureCount === undefined
                              ? ""
                              : t(
                                  "，输出 {0} 个要素",
                                  result.outcome.featureCount.toLocaleString(),
                                ),
                            (result.outcome.durationMs / 1000).toFixed(2),
                          )
                        : ""}
                  </div>
                  {result?.outcome && (
                    <section
                      className="processing-result"
                      aria-label={t("分析结果")}
                    >
                      {result.outcome.layerId && (
                        <div className="processing-result-layer">
                          <strong>
                            {result.outcome.layerName ||
                              result.request.outputName}
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
                            {t("定位结果")}
                          </button>
                        </div>
                      )}
                      {result.outcome.featureCount === 0 && (
                        <p>
                          {t(
                            "没有匹配要素。可调整空间关系或输入范围后重新分析。",
                          )}
                        </p>
                      )}
                      {result.outcome.explanation && (
                        <details
                          className="processing-report processing-explanation"
                          open
                        >
                          <summary>{t("结果说明")}</summary>
                          <dl>
                            {result.outcome.explanation.details.map(
                              (detail) => (
                                <div
                                  key={detail.label}
                                  className="processing-detail-row"
                                >
                                  <dt>{t(detail.label)}</dt>
                                  <dd>
                                    {detail.translate
                                      ? t(detail.value)
                                      : detail.value}
                                  </dd>
                                </div>
                              ),
                            )}
                          </dl>
                          {result.outcome.explanation.removed?.map((entry) => (
                            <p key={entry.index} className="processing-note">
                              {featureOrdinal(entry.index)}: {t(entry.reason)}
                            </p>
                          ))}
                          {result.outcome.explanation.warnings.map(
                            (warning) => (
                              <p className="processing-note" key={warning}>
                                {t(warning)}
                              </p>
                            ),
                          )}
                        </details>
                      )}
                      {result.outcome.report && (
                        <AnalysisReport
                          operation={result.request.operation}
                          report={result.outcome.report}
                          onLocate={result.outcome.location ? (issue) => {
                            const focus = locateAnalysisIssue(result.outcome.location!, layers, issue);
                            if (!focus) { setError("输入数据已变化，请重新运行检查后定位。"); onLocateIssue?.(); }
                            else { setError(""); onLocateIssue?.(focus); }
                          } : undefined}
                        />
                      )}
                    </section>
                  )}
                </div>
                <button
                  className="processing-run"
                  type="submit"
                  disabled={running || Boolean(unavailableReason)}
                  aria-describedby={
                    unavailableReason ? "processing-unavailable" : undefined
                  }
                >
                  <Play size={15} aria-hidden="true" />
                  {running ? t("正在分析…") : t("运行分析")}
                </button>
              </section>
            </form>
          </>
        )}
      </div>
    </aside>
  );
}

export default ProcessingToolbox;
