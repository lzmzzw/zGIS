import { reconcileTree, type LayerTreeNode } from "./layerTree";
import {
  exportGeoJSON,
  importGeoJSON,
  makeLayer,
  type DocumentLayer,
} from "./domain";

// Recovery stores document content and visual settings, never source handles or database state.
export function snapshotLayers(layers: DocumentLayer[]): string {
  return JSON.stringify(
    layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
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
    })),
  );
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
    const features = importGeoJSON(exportGeoJSON(value.features));
    return makeLayer(value.name, features, "geojson", {
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
    });
  });
}

export type ExitAction = "save" | "keep" | "submit" | "discard";

// Versioned recovery contains only safe document snapshots and their visual tree.
export function snapshotWorkspace(
  layers: DocumentLayer[],
  tree: LayerTreeNode[],
): string {
  if (!layers.length) return "[]";
  const safeTree = reconcileTree(
    tree,
    layers.map((layer) => layer.id),
  );
  if (
    safeTree.length === layers.length &&
    safeTree.every(
      (node, index) => node.kind === "layer" && node.id === layers[index].id,
    )
  )
    return snapshotLayers(layers);
  return JSON.stringify({
    version: 2,
    layers: JSON.parse(snapshotLayers(layers)),
    tree: safeTree,
  });
}

export function restoreWorkspace(raw: string): {
  layers: DocumentLayer[];
  tree: LayerTreeNode[];
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
    data.version !== 2 ||
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
  return { layers, tree: map(tree) };
}
