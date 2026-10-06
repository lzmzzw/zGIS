import type { DocumentLayer } from "./domain";

export type LayerTreeNode =
  | { kind: "layer"; id: string }
  | {
      kind: "group";
      id: string;
      name: string;
      visible: boolean;
      collapsed: boolean;
      children: LayerTreeNode[];
    };
export type DropPosition = "before" | "after" | "inside";

export function reconcileTree(
  tree: LayerTreeNode[],
  layerIds: string[],
): LayerTreeNode[] {
  const valid = new Set(layerIds),
    seen = new Set<string>();
  const visit = (nodes: LayerTreeNode[]): LayerTreeNode[] => {
    let changed = false;
    const result: LayerTreeNode[] = [];
    for (const node of nodes) {
      if (node.kind === "layer") {
        if (!valid.has(node.id) || seen.has(node.id)) {
          changed = true;
          continue;
        }
        seen.add(node.id);
        result.push(node);
      } else {
        const children = visit(node.children);
        if (children !== node.children) {
          changed = true;
          result.push({ ...node, children });
        } else result.push(node);
      }
    }
    return changed ? result : nodes;
  };
  const result = visit(tree);
  const missing: LayerTreeNode[] = layerIds
    .filter((id) => !seen.has(id))
    .map((id) => ({ kind: "layer", id }));
  return missing.length ? [...missing, ...result] : result;
}

function findNode(
  nodes: LayerTreeNode[],
  id: string,
): LayerTreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "group") {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
}
function mapGroups(
  nodes: LayerTreeNode[],
  id: string,
  change: (node: Extract<LayerTreeNode, { kind: "group" }>) => LayerTreeNode,
): LayerTreeNode[] {
  return nodes.map((node) =>
    node.kind === "group"
      ? node.id === id
        ? change(node)
        : { ...node, children: mapGroups(node.children, id, change) }
      : node,
  );
}
export function updateTreeGroup(
  tree: LayerTreeNode[],
  id: string,
  patch: { name?: string; visible?: boolean; collapsed?: boolean },
): LayerTreeNode[] {
  if (findNode(tree, id)?.kind !== "group") throw new Error("分组不存在");
  if (patch.name !== undefined && !patch.name.trim())
    throw new Error("分组名称不能为空");
  return mapGroups(tree, id, (node) => ({ ...node, ...patch }));
}
export function addTreeGroup(
  tree: LayerTreeNode[],
  groupNode: Extract<LayerTreeNode, { kind: "group" }>,
  parentId?: string,
): LayerTreeNode[] {
  if (findNode(tree, groupNode.id)) throw new Error("节点标识重复");
  if (!groupNode.name.trim()) throw new Error("分组名称不能为空");
  if (!parentId) return [...tree, groupNode];
  if (findNode(tree, parentId)?.kind !== "group")
    throw new Error("目标分组不存在");
  return mapGroups(tree, parentId, (node) => ({
    ...node,
    children: [...node.children, groupNode],
  }));
}
export function moveTreeNode(
  tree: LayerTreeNode[],
  id: string,
  targetId: string | null,
  position: DropPosition,
): LayerTreeNode[] {
  const moving = findNode(tree, id);
  if (!moving) throw new Error("移动节点不存在");
  if (
    targetId === id ||
    (moving.kind === "group" && targetId && findNode(moving.children, targetId))
  )
    throw new Error("不能将节点移动到自身或其后代");
  const target = targetId === null ? null : findNode(tree, targetId);
  if (targetId !== null && !target) throw new Error("目标节点不存在");
  if (position === "inside" && target && target.kind !== "group")
    throw new Error("只能移入分组");
  if (targetId === null && position !== "inside")
    throw new Error("根目录只能使用移入操作");
  const remove = (nodes: LayerTreeNode[]): LayerTreeNode[] =>
    nodes
      .filter((n) => n.id !== id)
      .map((n) =>
        n.kind === "group" ? { ...n, children: remove(n.children) } : n,
      );
  const removed = remove(tree);
  if (targetId === null) return [...removed, moving];
  const insert = (nodes: LayerTreeNode[]): LayerTreeNode[] => {
    const result: LayerTreeNode[] = [];
    for (const n of nodes) {
      if (n.id === targetId) {
        if (position === "before") result.push(moving, n);
        else if (position === "after") result.push(n, moving);
        else if (n.kind === "group")
          result.push({ ...n, children: [...n.children, moving] });
      } else
        result.push(
          n.kind === "group" ? { ...n, children: insert(n.children) } : n,
        );
    }
    return result;
  };
  return insert(removed);
}
export function orderedTreeLayers(
  tree: LayerTreeNode[],
  layers: DocumentLayer[],
): DocumentLayer[] {
  const byId = new Map(layers.map((layer) => [layer.id, layer])),
    result: DocumentLayer[] = [];
  const visit = (nodes: LayerTreeNode[], visible: boolean) => {
    for (const node of nodes) {
      if (node.kind === "group") visit(node.children, visible && node.visible);
      else {
        const layer = byId.get(node.id);
        if (layer) result.push(visible ? layer : { ...layer, visible: false });
      }
    }
  };
  visit(tree, true);
  return result;
}
