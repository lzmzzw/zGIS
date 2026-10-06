import { snapshotWorkspace, restoreWorkspace } from "./workspace";
import { moveTreeNode, type LayerTreeNode } from "./layerTree";
import { expect, it } from "vitest";
import { makeLayer } from "./domain";
import { restoreLayers, snapshotLayers } from "./workspace";

it("恢复只保留内容和样式，数据库身份及基线不进入快照", () => {
  const layer = makeLayer(
    "database",
    [
      {
        id: "f",
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { a: 1 },
        dbKey: [1],
        baseline: "secret-baseline",
      },
    ],
    "postgis",
    { sourceId: "source", opacity: 0.5, strokeWidth: 4 },
  );
  const snapshot = snapshotLayers([layer]);
  expect(snapshot).not.toContain("baseline");
  expect(snapshot).not.toContain("sourceId");
  expect(snapshot).not.toContain("dbKey");
  const [restored] = restoreLayers(snapshot);
  expect(restored).toMatchObject({
    sourceKind: "geojson",
    dirty: true,
    restored: true,
    opacity: 0.5,
    strokeWidth: 4,
  });
  expect(restored.db).toBeUndefined();
  expect(restored.features[0].properties).toEqual({ a: 1 });
});

it("无效恢复内容被拒绝，不静默跳过或降低维度", () => {
  expect(() => restoreLayers("{}")).toThrow("图层列表");
  expect(() =>
    restoreLayers(
      '[{"name":"bad","features":[{"geometry":{"type":"Point","coordinates":[1,2,3,4]},"properties":{}}]}]',
    ),
  ).toThrow("XYZ");
});

it("XYZ 恢复保留高程", () => {
  const layer = makeLayer(
    "height",
    [
      {
        id: "z",
        geometry: { type: "Point", coordinates: [1, 2, 12.5] },
        properties: {},
      },
    ],
    "geojson",
  );
  expect(
    restoreLayers(snapshotLayers([layer]))[0].features[0].geometry,
  ).toEqual(layer.features[0].geometry);
});

it("工作区分组与顺序恢复重映射ID，安全元数据与旧格式兼容", () => {
  const a = makeLayer("a", [], "geojson", { sourceId: "sensitive-handle" }),
    b = makeLayer("b", [], "geojson");
  const tree: LayerTreeNode[] = [
    {
      kind: "group",
      id: "group",
      name: "分组",
      visible: false,
      collapsed: true,
      children: [{ kind: "layer", id: b.id }],
    },
    { kind: "layer", id: a.id },
  ];
  const snapshot = snapshotWorkspace([a, b], tree);
  expect(snapshot).not.toContain("sensitive-handle");
  const restored = restoreWorkspace(snapshot);
  expect(restored.tree).toEqual([
    { ...tree[0], children: [{ kind: "layer", id: restored.layers[1].id }] },
    { kind: "layer", id: restored.layers[0].id },
  ]);
  expect(restoreWorkspace(snapshotLayers([a])).tree[0].kind).toBe("layer");
  expect(snapshotWorkspace([], tree)).toBe("[]");
});
it("恢复拒绝重复、未知与缺失图层引用", () => {
  const layer = makeLayer("a", [], "geojson");
  const base = { version: 2, layers: JSON.parse(snapshotLayers([layer])) };
  expect(() => restoreWorkspace(JSON.stringify({ ...base, tree: [] }))).toThrow(
    "不完整",
  );
  expect(() =>
    restoreWorkspace(
      JSON.stringify({ ...base, tree: [{ kind: "layer", id: "unknown" }] }),
    ),
  ).toThrow("不存在");
  expect(() =>
    restoreWorkspace(
      JSON.stringify({
        ...base,
        tree: [
          { kind: "layer", id: layer.id },
          { kind: "layer", id: layer.id },
        ],
      }),
    ),
  ).toThrow("重复");
});

it("整组移动后的多级树恢复保留全部图层内容及高程", () => {
  const layer = makeLayer(
    "嵌套图层",
    [
      {
        id: "height",
        geometry: { type: "Point", coordinates: [116, 40, 19] },
        properties: { name: "保留属性" },
      },
    ],
    "geojson",
  );
  const source: LayerTreeNode = {
    kind: "group",
    id: "source",
    name: "源组",
    visible: false,
    collapsed: false,
    children: [
      {
        kind: "group",
        id: "sub",
        name: "子组",
        visible: true,
        collapsed: true,
        children: [{ kind: "layer", id: layer.id }],
      },
    ],
  };
  const target: LayerTreeNode = {
    kind: "group",
    id: "target",
    name: "目标组",
    visible: true,
    collapsed: false,
    children: [
      {
        kind: "group",
        id: "destination",
        name: "目标子组",
        visible: true,
        collapsed: true,
        children: [],
      },
    ],
  };
  const moved = moveTreeNode(
    [source, target],
    "source",
    "destination",
    "inside",
  );
  const restored = restoreWorkspace(snapshotWorkspace([layer], moved));
  expect(
    restored.layers[0].features.map(({ geometry, properties }) => ({
      geometry,
      properties,
    })),
  ).toEqual(
    layer.features.map(({ geometry, properties }) => ({
      geometry,
      properties,
    })),
  );
  expect(restored.tree).toEqual([
    {
      ...target,
      children: [
        {
          ...target.children[0],
          collapsed: false,
          children: [
            {
              ...source,
              children: [
                {
                  ...source.children[0],
                  children: [{ kind: "layer", id: restored.layers[0].id }],
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
});
