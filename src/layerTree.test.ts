import { expect, it } from "vitest";
import { makeLayer } from "./domain";
import {
  reconcileTree,
  moveTreeNode,
  orderedTreeLayers,
  addTreeGroup,
  updateTreeGroup,
  dissolveTreeGroup,
  deleteTreeGroup,
  treeGroupLayerIds,
  type LayerTreeNode,
} from "./layerTree";
const tree: LayerTreeNode[] = [
  { kind: "layer", id: "a" },
  {
    kind: "group",
    id: "g",
    name: "组",
    visible: false,
    collapsed: true,
    children: [{ kind: "layer", id: "b" }],
  },
];
it("协调保留空组并补充新增图层，无变化保持引用", () => {
  expect(reconcileTree(tree, ["a", "b"])).toBe(tree);
  expect(reconcileTree(tree, ["c"])).toEqual([
    { kind: "layer", id: "c" },
    { ...tree[1], children: [] },
  ]);
});
it("移动支持排序、进出分组并拒绝周期", () => {
  const moved = moveTreeNode(tree, "a", "g", "inside");
  expect(moved).toEqual([
    {
      ...tree[1],
      collapsed: false,
      children: [
        { kind: "layer", id: "b" },
        { kind: "layer", id: "a" },
      ],
    },
  ]);
  expect(moveTreeNode(moved, "a", null, "inside")[1]).toEqual({
    kind: "layer",
    id: "a",
  });
  expect(() => moveTreeNode(moved, "g", "a", "inside")).toThrow("后代");
  expect(moveTreeNode(tree, "b", "a", "before")[0]).toEqual({
    kind: "layer",
    id: "b",
  });
});
it("折叠不隐藏图层，组显隐不污染源数据", () => {
  const a = makeLayer("a", [], "geojson"),
    b = makeLayer("b", [], "geojson");
  a.id = "a";
  b.id = "b";
  const ordered = orderedTreeLayers(tree, [a, b]);
  expect(ordered[0]).toBe(a);
  expect(ordered[1].visible).toBe(false);
  expect(b.visible).toBe(true);
});

it("分组创建与更新保留原树且验证目标", () => {
  const group: Extract<LayerTreeNode, { kind: "group" }> = {
    kind: "group",
    id: "new",
    name: "新增",
    visible: true,
    collapsed: false,
    children: [],
  };
  const added = addTreeGroup(tree, group, "g");
  expect(added[1]).toMatchObject({ collapsed: false });
  expect(added[1].kind === "group" && added[1].children[1]).toEqual(group);
  expect(
    updateTreeGroup(added, "new", { name: "改名", visible: false })[1],
  ).toMatchObject({
    children: [{ id: "b" }, { id: "new", name: "改名", visible: false }],
  });
  expect(() => addTreeGroup(tree, group, "a")).toThrow("分组");
  expect(() => updateTreeGroup(tree, "g", { name: " " })).toThrow("不能为空");
  expect(tree[1]).toMatchObject({ name: "组", children: [{ id: "b" }] });
});

it("解散分组仅提升直属子节点，保留子组、图层、顺序且不修改原树", () => {
  const child: LayerTreeNode = {
    kind: "group",
    id: "child",
    name: "子组",
    visible: false,
    collapsed: true,
    children: [{ kind: "layer", id: "c" }],
  };
  const group: LayerTreeNode = {
    kind: "group",
    id: "nested",
    name: "待解散",
    visible: true,
    collapsed: false,
    children: [{ kind: "layer", id: "b" }, child],
  };
  const parent: LayerTreeNode = {
    kind: "group",
    id: "parent",
    name: "父组",
    visible: false,
    collapsed: false,
    children: [{ kind: "layer", id: "a" }, group, { kind: "layer", id: "d" }],
  };
  expect(dissolveTreeGroup([parent], "nested")).toEqual([
    {
      ...parent,
      children: [
        { kind: "layer", id: "a" },
        { kind: "layer", id: "d" },
      ],
    },
    ...group.children,
  ]);
  expect(treeGroupLayerIds([parent], "nested")).toEqual(["b", "c"]);
  expect(deleteTreeGroup([parent], "nested")).toEqual([
    {
      ...parent,
      children: [
        { kind: "layer", id: "a" },
        { kind: "layer", id: "d" },
      ],
    },
  ]);
  expect(dissolveTreeGroup([group], "nested")).toEqual(group.children);
  expect(parent.children[1]).toBe(group);
  expect(group.children[1]).toBe(child);
  expect(() => dissolveTreeGroup([parent], "a")).toThrow("分组不存在");
  expect(() => dissolveTreeGroup([parent], "missing")).toThrow("分组不存在");
});

it("整组移入其他子组时保留全部后代、顺序和状态并展开目标", () => {
  const moving: LayerTreeNode = {
    kind: "group",
    id: "a",
    name: "整组",
    visible: false,
    collapsed: true,
    children: [
      {
        kind: "group",
        id: "a-child",
        name: "子组",
        visible: true,
        collapsed: false,
        children: [{ kind: "layer", id: "layer-a" }],
      },
      { kind: "layer", id: "layer-b" },
    ],
  };
  const target: LayerTreeNode = {
    kind: "group",
    id: "b",
    name: "目标",
    visible: true,
    collapsed: false,
    children: [
      {
        kind: "group",
        id: "b-child",
        name: "目标子组",
        visible: true,
        collapsed: true,
        children: [],
      },
    ],
  };
  const original = [moving, target];
  const moved = moveTreeNode(original, "a", "b-child", "inside");
  expect(moved).toEqual([
    {
      ...target,
      children: [
        { ...target.children[0], collapsed: false, children: [moving] },
      ],
    },
  ]);
  expect(original).toEqual([moving, target]);
  expect(() => moveTreeNode(original, "a", "a-child", "inside")).toThrow(
    "后代",
  );
  expect(() => moveTreeNode(original, "a", "layer-a", "before")).toThrow(
    "后代",
  );
  expect(() => moveTreeNode(original, "a", "a", "inside")).toThrow("自身");
});
