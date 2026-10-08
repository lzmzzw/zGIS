import { reconcileTree, type LayerTreeNode } from "./layerTree";
import {
  exportGeoJSON,
  importGeoJSON,
  makeLayer,
  type DocumentLayer,
  type GeoFeature,
} from "./domain";

export interface WorkspaceEditSession {
  layerId: string;
  selectedId?: string;
  tool:
    "pan" | "select" | "modify" | "move" | "Point" | "LineString" | "Polygon";
  snapping: boolean;
  // 只保存固定节点，不包含绘图时跟随鼠标的临时坐标。
  drawDraft?: { type: "LineString" | "Polygon"; coordinates: number[][] };
  cellDraft?: {
    featureId: string;
    field: string;
    text: string;
    isNull: boolean;
    original?: unknown;
  };
  panelDraft?: { kind: "json" | "wkt"; featureId: string; text: string };
  history?: {
    undo: GeoFeature[][];
    redo: GeoFeature[][];
    undoFieldNames?: string[][];
    redoFieldNames?: string[][];
    baseline?: {
      features: GeoFeature[];
      dirty: boolean;
      fieldNames?: string[];
    };
  };
}

const geometryTypes = new Set(["Point", "LineString", "Polygon"]);
const tools = new Set(["pan", "select", "modify", "move", ...geometryTypes]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
let recoveryRevision = 0;

// WebView2 may replay an older localStorage write after a forced process exit.
// Both copies carry the same revision; prefer the newest, native on ties.
export function selectRecoverySnapshot(
  native: string | null,
  local: string | null,
): string | null {
  const revision = (raw: string | null): number => {
    try {
      const value: unknown = raw ? JSON.parse(raw) : null;
      return isRecord(value) &&
        Number.isSafeInteger(value.recoveryRevision) &&
        Number(value.recoveryRevision) > 0
        ? Number(value.recoveryRevision)
        : 0;
    } catch {
      return 0;
    }
  };
  const nativeRevision = revision(native);
  const localRevision = revision(local);
  recoveryRevision = Math.max(recoveryRevision, nativeRevision, localRevision);
  if (!local) return native;
  if (!native) return local;
  if (!nativeRevision && !localRevision) return local;
  return localRevision > nativeRevision ? local : native;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

// History must never prevent the current document and draft from being recovered.
export function boundedRecoveryHistory(
  history: NonNullable<WorkspaceEditSession["history"]>,
  featureBudget = 500_000,
): NonNullable<WorkspaceEditSession["history"]> {
  let remaining = featureBudget;
  const take = (frames: GeoFeature[][]): GeoFeature[][] => {
    const result: GeoFeature[][] = [];
    for (const frame of frames.slice(-30).reverse()) {
      if (frame.length > remaining) break;
      result.unshift(frame);
      remaining -= frame.length;
    }
    return result;
  };
  const baseline =
    history.baseline && history.baseline.features.length <= remaining
      ? history.baseline
      : undefined;
  if (baseline) remaining -= baseline.features.length;
  const undo = take(history.undo),
    redo = take(history.redo);
  return {
    undo,
    redo,
    baseline,
    undoFieldNames: history.undoFieldNames?.slice(
      -undo.length || history.undoFieldNames.length,
    ),
    redoFieldNames: history.redoFieldNames?.slice(
      -redo.length || history.redoFieldNames.length,
    ),
  };
}

function safeFeatures(values: unknown, requireIds = false): GeoFeature[] {
  if (!Array.isArray(values)) throw new Error("恢复要素列表结构无效");
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !("geometry" in value))
      throw new Error("恢复要素结构无效");
    if (requireIds || value.id !== undefined) {
      if (!validId(value.id) || ids.has(value.id))
        throw new Error("恢复要素标识无效或重复");
      ids.add(value.id);
    }
    if (value.properties !== null && !isRecord(value.properties))
      throw new Error("恢复要素属性结构无效");
  }
  // 沿用导入器的坐标、几何与属性校验，独立保留内部 ID，丢弃数据库身份。
  const imported = importGeoJSON(exportGeoJSON(values as GeoFeature[]));
  return imported.map((feature, index) => ({
    ...feature,
    ...(validId(values[index].id) ? { id: values[index].id } : {}),
  }));
}

function safeSession(
  value: unknown,
  layers: DocumentLayer[],
): WorkspaceEditSession {
  if (
    !isRecord(value) ||
    !validId(value.layerId) ||
    typeof value.tool !== "string" ||
    !tools.has(value.tool) ||
    typeof value.snapping !== "boolean"
  )
    throw new Error("恢复编辑会话结构无效");
  const layer = layers.find((item) => item.id === value.layerId);
  if (!layer) throw new Error("恢复编辑会话引用不存在的图层");
  const feature = (id: unknown): GeoFeature => {
    if (!validId(id)) throw new Error("恢复编辑草稿要素标识无效");
    const found = layer.features.find((item) => item.id === id);
    if (!found) throw new Error("恢复编辑草稿引用不存在的要素");
    return found;
  };
  const text = (input: unknown): input is string =>
    typeof input === "string" && input.length <= 1_000_000;
  const result: WorkspaceEditSession = {
    layerId: layer.id,
    tool: value.tool as WorkspaceEditSession["tool"],
    snapping: value.snapping,
  };
  if (value.selectedId !== undefined)
    result.selectedId = feature(value.selectedId).id;
  if (value.drawDraft !== undefined) {
    const draft = value.drawDraft;
    if (
      !isRecord(draft) ||
      (draft.type !== "LineString" && draft.type !== "Polygon") ||
      draft.type !== value.tool ||
      !Array.isArray(draft.coordinates) ||
      draft.coordinates.length === 0 ||
      draft.coordinates.length > 100_000
    )
      throw new Error("恢复绘图草稿结构无效或超出节点限制");
    let dimension: number | undefined;
    const coordinates = draft.coordinates.map((position: unknown) => {
      if (
        !Array.isArray(position) ||
        (position.length !== 2 && position.length !== 3) ||
        position.some(
          (component) =>
            typeof component !== "number" || !Number.isFinite(component),
        ) ||
        Math.abs(position[0]) > 180 ||
        Math.abs(position[1]) > 90 ||
        (dimension !== undefined && dimension !== position.length)
      )
        throw new Error("恢复绘图草稿坐标无效，仅支持一致的二维或 XYZ 坐标");
      dimension = position.length;
      return [...position] as number[];
    });
    result.drawDraft = { type: draft.type, coordinates };
  }
  if (value.cellDraft !== undefined) {
    const draft = value.cellDraft;
    if (
      !isRecord(draft) ||
      typeof draft.field !== "string" ||
      draft.field.length > 1024 ||
      !text(draft.text) ||
      typeof draft.isNull !== "boolean"
    )
      throw new Error("恢复属性草稿结构无效或超出文本限制");
    const target = feature(draft.featureId);
    if (
      !layer.fieldNames?.includes(draft.field) &&
      !layer.features.some((item) =>
        Object.hasOwn(item.properties, draft.field as string),
      )
    )
      throw new Error("恢复属性草稿引用不存在的字段");
    result.cellDraft = {
      featureId: target.id,
      field: draft.field,
      text: draft.text,
      isNull: draft.isNull,
      // 编辑类型来自已验证的要素属性，不信任恢复文件单独提供的 original。
      original: target.properties[draft.field],
    };
  }
  if (value.panelDraft !== undefined) {
    const draft = value.panelDraft;
    if (
      !isRecord(draft) ||
      (draft.kind !== "json" && draft.kind !== "wkt") ||
      !text(draft.text)
    )
      throw new Error("恢复要素面板草稿结构无效或超出文本限制");
    result.panelDraft = {
      kind: draft.kind,
      featureId: feature(draft.featureId).id,
      text: draft.text,
    };
  }
  if (
    [result.drawDraft, result.cellDraft, result.panelDraft].filter(Boolean)
      .length > 1
  )
    throw new Error("恢复编辑会话不能同时包含多个未完成草稿");
  if (value.history !== undefined) {
    const history = value.history;
    if (!isRecord(history)) throw new Error("恢复编辑历史结构无效");
    let historyFeatures = 0;
    const historyFrame = (input: unknown): GeoFeature[] => {
      if (!Array.isArray(input)) throw new Error("恢复编辑历史要素列表无效");
      historyFeatures += input.length;
      if (historyFeatures > 500_000)
        throw new Error("恢复编辑历史超出 500000 个要素限制");
      return safeFeatures(input, true);
    };
    const frames = (input: unknown): GeoFeature[][] => {
      if (!Array.isArray(input) || input.length > 30)
        throw new Error("恢复编辑历史结构无效或超出 30 步限制");
      return input.map(historyFrame);
    };
    result.history = { undo: frames(history.undo), redo: frames(history.redo) };
    const fields = (input: unknown): string[] => {
      if (
        !Array.isArray(input) ||
        input.length > 10_000 ||
        input.some((name) => typeof name !== "string" || name.length > 1024) ||
        new Set(input).size !== input.length
      )
        throw new Error("恢复字段历史结构无效");
      return input as string[];
    };
    for (const direction of ["undo", "redo"] as const) {
      const key = direction === "undo" ? "undoFieldNames" : "redoFieldNames";
      if (history[key] !== undefined) {
        if (
          !Array.isArray(history[key]) ||
          history[key].length !== result.history[direction].length
        )
          throw new Error("恢复字段历史与要素历史不一致");
        result.history[key] = history[key].map(fields);
      }
    }
    if (history.baseline !== undefined) {
      const baseline = history.baseline;
      if (!isRecord(baseline) || typeof baseline.dirty !== "boolean")
        throw new Error("恢复编辑历史基线无效");
      result.history.baseline = {
        features: historyFrame(baseline.features),
        dirty: baseline.dirty,
        ...(baseline.fieldNames !== undefined
          ? { fieldNames: fields(baseline.fieldNames) }
          : {}),
      };
    }
  }
  return result;
}

// 恢复只保存文档与显示配置，排除来源句柄和数据库身份。
function snapshotLayerData(layers: DocumentLayer[]) {
  return layers.map((layer) => ({
    id: layer.id,
    name: layer.name,
    displayName: layer.displayName,
    features: layer.features.map(
      ({ id, geometry, properties, sourceFeatureId }) => ({
        id,
        geometry,
        properties,
        sourceFeatureId,
      }),
    ),
    visible: layer.visible,
    color: layer.color,
    opacity: layer.opacity,
    strokeWidth: layer.strokeWidth,
    sourceKind: "geojson",
    restoredFrom: layer.restoredFrom ?? layer.sourceKind,
    crs: "EPSG:4326",
    dirty: layer.dirty,
    geometryType: layer.geometryType,
    fieldNames: layer.fieldNames,
  }));
}

export function snapshotLayers(layers: DocumentLayer[]): string {
  return JSON.stringify(snapshotLayerData(layers));
}

export function restoreLayers(raw: string): DocumentLayer[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("恢复文件必须是图层列表");
  return data.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.name !== "string" ||
      !Array.isArray(value.features)
    )
      throw new Error("恢复图层结构无效");
    if (
      value.displayName !== undefined &&
      (typeof value.displayName !== "string" ||
        !value.displayName.trim() ||
        value.displayName.length > 120)
    )
      throw new Error("恢复图层显示名无效");
    if (
      value.geometryType !== undefined &&
      !geometryTypes.has(value.geometryType)
    )
      throw new Error("恢复图层几何类型无效");
    if (
      value.fieldNames !== undefined &&
      (!Array.isArray(value.fieldNames) ||
        value.fieldNames.length > 10000 ||
        value.fieldNames.some(
          (field: unknown) => typeof field !== "string" || field.length > 1024,
        ) ||
        new Set(value.fieldNames).size !== value.fieldNames.length)
    )
      throw new Error("恢复图层字段结构无效或重复");
    const features = safeFeatures(value.features);
    return makeLayer(value.name, features, "geojson", {
      displayName: value.displayName?.trim(),
      visible: value.visible !== false,
      color:
        typeof value.color === "string" && /^#[0-9a-f]{6}$/i.test(value.color)
          ? value.color
          : "#5479b6",
      opacity:
        typeof value.opacity === "number" &&
        value.opacity >= 0 &&
        value.opacity <= 1
          ? value.opacity
          : 1,
      strokeWidth:
        typeof value.strokeWidth === "number" &&
        value.strokeWidth >= 1 &&
        value.strokeWidth <= 8
          ? value.strokeWidth
          : 2,
      dirty: true,
      restored: true,
      restoredFrom:
        typeof value.restoredFrom === "string"
          ? value.restoredFrom
          : typeof value.sourceKind === "string"
            ? value.sourceKind
            : "geojson",
      warnings: ["已恢复为本地 GeoJSON 副本，请另存文件。"],
      geometryType: value.geometryType,
      fieldNames: value.fieldNames,
    });
  });
}

export type ExitAction = "save" | "keep" | "submit" | "discard";

// Versioned recovery contains only safe document snapshots and their visual tree.
export function snapshotWorkspace(
  layers: DocumentLayer[],
  tree: LayerTreeNode[],
  session?: WorkspaceEditSession,
): string {
  const safeTree = reconcileTree(
    tree,
    layers.map((layer) => layer.id),
  );
  const data = {
    version: 3,
    recoveryRevision: ++recoveryRevision,
    layers: snapshotLayerData(layers),
    tree: safeTree,
    ...(session
      ? {
          session: safeSession(
            {
              ...session,
              history: session.history
                ? boundedRecoveryHistory(session.history)
                : undefined,
            },
            layers,
          ),
        }
      : {}),
  };
  let content = JSON.stringify(data);
  // Keep room below the native 100 MB limit for the live document and draft.
  if (
    data.session?.history &&
    // UTF-8 每个 UTF-16 码元最多占 3 字节，普通快照无需分配额外编码缓冲区。
    content.length > (95 * 1024 * 1024) / 3 &&
    new TextEncoder().encode(content).length > 95 * 1024 * 1024
  ) {
    data.session.history = undefined;
    content = JSON.stringify(data);
  }
  return content;
}

export function restoreWorkspace(raw: string): {
  layers: DocumentLayer[];
  tree: LayerTreeNode[];
  session?: WorkspaceEditSession;
} {
  const data: unknown = JSON.parse(raw);
  if (Array.isArray(data)) {
    const layers = restoreLayers(raw);
    return {
      layers,
      tree: layers.map((layer) => ({ kind: "layer", id: layer.id })),
    };
  }
  if (
    !data ||
    typeof data !== "object" ||
    !("version" in data) ||
    (data.version !== 2 && data.version !== 3) ||
    !("layers" in data) ||
    !Array.isArray(data.layers) ||
    !("tree" in data) ||
    !Array.isArray(data.tree)
  )
    throw new Error("恢复工作区结构无效");
  const ids = new Set<string>();
  for (const layer of data.layers) {
    if (
      !layer ||
      typeof layer !== "object" ||
      typeof layer.id !== "string" ||
      !layer.id ||
      ids.has(layer.id)
    )
      throw new Error("恢复图层标识无效或重复");
    ids.add(layer.id);
  }
  const nodes = new Set<string>(),
    references = new Set<string>();
  const validate = (values: unknown[]): LayerTreeNode[] =>
    values.map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !value.id ||
        nodes.has(value.id)
      )
        throw new Error("恢复树节点标识无效或重复");
      nodes.add(value.id);
      if ("kind" in value && value.kind === "layer") {
        if (!ids.has(value.id)) throw new Error("恢复树引用不存在的图层");
        references.add(value.id);
        return { kind: "layer", id: value.id };
      }
      if (
        "kind" in value &&
        value.kind === "group" &&
        "name" in value &&
        typeof value.name === "string" &&
        value.name.trim() &&
        "visible" in value &&
        typeof value.visible === "boolean" &&
        "collapsed" in value &&
        typeof value.collapsed === "boolean" &&
        "children" in value &&
        Array.isArray(value.children)
      )
        return {
          kind: "group",
          id: value.id,
          name: value.name,
          visible: value.visible,
          collapsed: value.collapsed,
          children: validate(value.children),
        };
      throw new Error("恢复树节点结构无效");
    });
  const tree = validate(data.tree);
  if (references.size !== ids.size) throw new Error("恢复树图层引用不完整");
  const layers = restoreLayers(JSON.stringify(data.layers));
  const remap = new Map(
    data.layers.map((layer, index) => [layer.id, layers[index].id]),
  );
  const map = (values: LayerTreeNode[]): LayerTreeNode[] =>
    values.map((node) =>
      node.kind === "layer"
        ? { kind: "layer", id: remap.get(node.id)! }
        : { ...node, children: map(node.children) },
    );
  let session: WorkspaceEditSession | undefined;
  if (data.version === 3 && "session" in data && data.session !== undefined) {
    if (
      !isRecord(data.session) ||
      !validId(data.session.layerId) ||
      !remap.has(data.session.layerId)
    )
      throw new Error("恢复编辑会话引用不存在的图层");
    session = safeSession(
      { ...data.session, layerId: remap.get(data.session.layerId) },
      layers,
    );
  }
  return { layers, tree: map(tree), ...(session ? { session } : {}) };
}
