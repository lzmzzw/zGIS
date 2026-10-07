import {
  snapshotWorkspace,
  selectRecoverySnapshot,
  restoreWorkspace,
  type WorkspaceEditSession,
} from "./workspace";
import { moveTreeNode, type LayerTreeNode } from "./layerTree";
import { expect, it } from "vitest";
import { makeLayer, type GeoFeature } from "./domain";
import { restoreLayers, snapshotLayers } from "./workspace";
import { boundedRecoveryHistory } from "./workspace";

it("恢复采用较新副本，避免强退后旧浏览器日志覆盖原生保存", () => {
  const old = JSON.stringify({
    version: 3,
    recoveryRevision: 100,
    layers: [],
    tree: [],
  });
  const latest = JSON.stringify({
    version: 3,
    recoveryRevision: 101,
    layers: [],
    tree: [],
  });
  expect(selectRecoverySnapshot(latest, old)).toBe(latest);
  expect(selectRecoverySnapshot(old, latest)).toBe(latest);
  expect(selectRecoverySnapshot(latest, latest)).toBe(latest);
  expect(selectRecoverySnapshot(null, latest)).toBe(latest);
  expect(selectRecoverySnapshot(latest, null)).toBe(latest);
  expect(
    JSON.parse(snapshotWorkspace([], [])).recoveryRevision,
  ).toBeGreaterThan(101);
  const legacy = JSON.stringify({ version: 2, layers: [], tree: [] });
  expect(selectRecoverySnapshot(legacy, old)).toBe(old);
  expect(selectRecoverySnapshot(latest, legacy)).toBe(latest);
});

it("历史预算优先保留基线和最近连续操作，不阻断当前内容恢复", () => {
  const feature = (id: string) => ({ id, geometry: null, properties: {} });
  const baseline = { features: [feature("baseline")], dirty: false };
  const undo = [[feature("old")], [feature("middle")], [feature("new")]];
  expect(
    boundedRecoveryHistory({ undo, redo: [[feature("redo")]], baseline }, 3),
  ).toEqual({ baseline, undo: undo.slice(-2), redo: [] });
  expect(
    boundedRecoveryHistory(
      {
        undo,
        redo: [],
        baseline: { features: [feature("a"), feature("b")], dirty: true },
      },
      1,
    ),
  ).toEqual({ baseline: undefined, undo: undo.slice(-1), redo: [] });
});

it("图层显示名与来源名分别恢复，旧快照仍可读取", () => {
  const layer = makeLayer("source.geojson", [], "geojson", {
    displayName: "行政边界",
  });
  const restored = restoreLayers(snapshotLayers([layer]))[0];
  expect(restored.name).toBe("source.geojson");
  expect(restored.displayName).toBe("行政边界");
  const legacy = makeLayer("legacy.geojson", [], "geojson");
  expect(
    restoreLayers(snapshotLayers([legacy]))[0].displayName,
  ).toBeUndefined();
  for (const displayName of ["", 12, "x".repeat(121)]) {
    const raw = JSON.parse(snapshotLayers([layer]));
    raw[0].displayName = displayName;
    expect(() => restoreLayers(JSON.stringify(raw))).toThrow("显示名");
  }
});

it("外部 JSON 空字段名的属性草稿可以恢复", () => {
  const layer = makeLayer(
    "empty-key",
    [{ id: "f", geometry: null, properties: { "": "原值" } }],
    "geojson",
    { fieldNames: [""] },
  );
  const snapshot = snapshotWorkspace(
    [layer],
    [{ kind: "layer", id: layer.id }],
    {
      layerId: layer.id,
      selectedId: "f",
      tool: "select",
      snapping: false,
      cellDraft: { featureId: "f", field: "", text: "草稿", isNull: false },
    },
  );
  expect(restoreWorkspace(snapshot).session?.cellDraft).toMatchObject({
    field: "",
    text: "草稿",
    original: "原值",
  });
});

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
  expect(restoreWorkspace(snapshotWorkspace([], tree)).tree).toEqual([
    { ...tree[0], children: [] },
  ]);
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

function editingFixture() {
  const initial: GeoFeature = {
    id: "stable-feature",
    geometry: { type: "Point", coordinates: [116, 40, 12] },
    properties: { count: 3 },
    dbKey: [99],
    baseline: "private-baseline",
  };
  const layer = makeLayer(
    "待保存图层",
    [{ ...initial, properties: { count: 4 } }],
    "postgis",
    {
      sourceId: "private-source",
      dirty: true,
    },
  );
  const tree: LayerTreeNode[] = [{ kind: "layer", id: layer.id }];
  const session: WorkspaceEditSession = {
    layerId: layer.id,
    selectedId: initial.id,
    tool: "modify",
    snapping: true,
    history: {
      undo: [[initial]],
      redo: [],
      baseline: { features: [initial], dirty: false },
    },
  };
  return { initial, layer, tree, session };
}

it("v3 恢复编辑模式、已应用修改、属性草稿与安全撤销基线", () => {
  const { initial, layer, tree, session } = editingFixture();
  session.cellDraft = {
    featureId: initial.id,
    field: "count",
    text: "尚未提交的无效数字",
    isNull: false,
    original: "不可信的类型提示",
  };
  const raw = snapshotWorkspace([layer], tree, session);
  expect(JSON.parse(raw).version).toBe(3);
  for (const forbidden of ["dbKey", "private-baseline", "private-source"])
    expect(raw).not.toContain(forbidden);
  const restored = restoreWorkspace(raw);
  expect(restored.layers[0].id).not.toBe(layer.id);
  expect(restored.layers[0].features[0]).toMatchObject({
    id: initial.id,
    properties: { count: 4 },
  });
  expect(restored.session).toEqual({
    ...session,
    layerId: restored.layers[0].id,
    cellDraft: { ...session.cellDraft, original: 4 },
    history: {
      undo: [
        [
          {
            id: initial.id,
            geometry: initial.geometry,
            properties: initial.properties,
          },
        ],
      ],
      redo: [],
      baseline: {
        features: [
          {
            id: initial.id,
            geometry: initial.geometry,
            properties: initial.properties,
          },
        ],
        dirty: false,
      },
    },
  });
});

it("未完成线面固定节点可以恢复，不要求已完成几何的最小节点数", () => {
  for (const type of ["LineString", "Polygon"] as const) {
    const { layer, tree, session } = editingFixture();
    session.tool = type;
    session.drawDraft = { type, coordinates: [[116, 40, 12]] };
    const restored = restoreWorkspace(
      snapshotWorkspace([layer], tree, session),
    );
    expect(restored.session?.drawDraft).toEqual(session.drawDraft);
    expect(restored.session?.tool).toBe(type);
  }
});

it("属性表已有列在当前要素缺失时仍可恢复编辑草稿", () => {
  const { initial, layer, tree, session } = editingFixture();
  layer.fieldNames = ["备注"];
  session.cellDraft = {
    featureId: initial.id,
    field: "备注",
    text: "新值",
    isNull: false,
  };
  expect(
    restoreWorkspace(snapshotWorkspace([layer], tree, session)).session
      ?.cellDraft,
  ).toEqual({ ...session.cellDraft, original: undefined });
});

it("JSON 与 WKT 无效待编辑文本按原文恢复，留给用户继续修正", () => {
  for (const kind of ["json", "wkt"] as const) {
    const { initial, layer, tree, session } = editingFixture();
    session.panelDraft = {
      kind,
      featureId: initial.id,
      text: "未完成的输入 ( {",
    };
    expect(
      restoreWorkspace(snapshotWorkspace([layer], tree, session)).session
        ?.panelDraft,
    ).toEqual(session.panelDraft);
  }
});

it("v3 拒绝无效编辑草稿、悬空引用与不完整历史，不静默丢弃", () => {
  const { layer, tree, session } = editingFixture();
  const base = JSON.parse(snapshotWorkspace([layer], tree, session));
  for (const patch of [
    { layerId: "unknown" },
    { selectedId: "unknown" },
    { tool: "unknown" },
    { snapping: "true" },
    {
      tool: "LineString",
      drawDraft: { type: "LineString", coordinates: [[1, 2, 3, 4]] },
    },
    {
      tool: "Polygon",
      drawDraft: {
        type: "Polygon",
        coordinates: [
          [1, 2],
          [2, 3, 4],
        ],
      },
    },
    {
      tool: "LineString",
      drawDraft: { type: "Polygon", coordinates: [[1, 2]] },
    },
    { tool: "LineString", drawDraft: { type: "LineString", coordinates: [] } },
    {
      cellDraft: {
        featureId: "unknown",
        field: "count",
        text: "",
        isNull: false,
      },
    },
    {
      cellDraft: {
        featureId: "stable-feature",
        field: "unknown",
        text: "",
        isNull: false,
      },
    },
    { panelDraft: { featureId: "stable-feature", kind: "unknown", text: "" } },
    { history: { undo: new Array(31).fill([]), redo: [] } },
    {
      history: {
        undo: [
          [
            {
              geometry: { type: "Point", coordinates: [1, 2] },
              properties: {},
            },
          ],
        ],
        redo: [],
      },
    },
    {
      history: {
        undo: [],
        redo: [],
        baseline: { features: [], dirty: "false" },
      },
    },
  ]) {
    expect(() =>
      restoreWorkspace(
        JSON.stringify({ ...base, session: { ...base.session, ...patch } }),
      ),
    ).toThrow("恢复");
  }
});

it("重复或非法要素 ID 被拒绝，旧无 ID 要素仍可恢复", () => {
  const { layer } = editingFixture();
  const base = JSON.parse(snapshotLayers([layer]));
  base[0].features.push(base[0].features[0]);
  expect(() => restoreLayers(JSON.stringify(base))).toThrow("重复");
  base[0].features.pop();
  base[0].features[0].id = 12;
  expect(() => restoreLayers(JSON.stringify(base))).toThrow("标识");
  delete base[0].features[0].id;
  expect(restoreLayers(JSON.stringify(base))[0].features[0].id).toBeTruthy();
});

it("空图层的几何类型与字段定义恢复，并兼容 v2 工作区", () => {
  const layer = makeLayer("新建点", [], "geojson", {
    geometryType: "Point",
    fieldNames: ["名称", "数量"],
  });
  const tree: LayerTreeNode[] = [{ kind: "layer", id: layer.id }];
  const raw = JSON.parse(snapshotWorkspace([layer], tree));
  expect(restoreWorkspace(JSON.stringify(raw)).layers[0]).toMatchObject({
    geometryType: "Point",
    fieldNames: ["名称", "数量"],
  });
  raw.version = 2;
  expect(restoreWorkspace(JSON.stringify(raw)).session).toBeUndefined();
  raw.layers[0].fieldNames = ["名称", "名称"];
  expect(() => restoreWorkspace(JSON.stringify(raw))).toThrow("字段");
  raw.layers[0].fieldNames = [];
  raw.layers[0].geometryType = "Circle";
  expect(() => restoreWorkspace(JSON.stringify(raw))).toThrow("几何类型");
});
