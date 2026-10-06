import { expect, it } from "vitest";
import { makeLayer } from "./domain";
import {
  reconcileTree,
  moveTreeNode,
  orderedTreeLayers,
  addTreeGroup,
  updateTreeGroup,
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
