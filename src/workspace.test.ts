import {
  snapshotWorkspace,
  selectRecoverySnapshot,
  restoreWorkspace,
  type WorkspaceEditSession,
} from "./workspace";
import { moveTreeNode, type LayerTreeNode } from "./layerTree";
import { expect, it, vi } from "vitest";
import { makeLayer, normalizeWorkingFeature, type GeoFeature } from "./domain";
import { restoreLayers, snapshotLayers } from "./workspace";
import { boundedRecoveryHistory } from "./workspace";

it("旧副本缺少 dirty 时保留未保存状态，显式非法 dirty 仍拒绝", () => {
  const legacy = { name: "legacy.geojson", features: [] };
  expect(restoreLayers(JSON.stringify([legacy]))[0].dirty).toBe(true);
  expect(
    restoreLayers(JSON.stringify([{ ...legacy, dirty: false }]))[0].dirty,
  ).toBe(false);
  expect(() =>
    restoreLayers(JSON.stringify([{ ...legacy, dirty: "false" }])),
  ).toThrow("恢复图层结构无效");
});

it("大工作区选择与恢复共用一次解析，不为整层内容重新编码或重复解析", () => {
  const payload = "x".repeat(12 * 1024 * 1024);
  const raw = JSON.stringify({
    version: 3, recoveryRevision: 100_000, tree: [{ kind: "layer", id: "large" }],
    layers: [{ id: "large", name: "large", features: [{ id: "row", geometry: { type: "Point", coordinates: [116, 39, 12] }, properties: { payload, code: "9007199254740993" }, dbKey: { forbidden: true }, baseline: { forbidden: true } }] }],
  });
  const parse = vi.spyOn(JSON, "parse");
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    expect(selectRecoverySnapshot(raw, null) === raw).toBe(true);
    expect(selectRecoverySnapshot(raw, raw) === raw).toBe(true);
    const restored = restoreWorkspace(raw);
    expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(1);
    expect(stringify).not.toHaveBeenCalled();
    expect(restored.layers[0].features[0].properties.payload === payload).toBe(true);
    expect(restored.layers[0].features[0].properties.code).toBe("9007199254740993");
    expect(restored.layers[0].features[0].id).toBe("row");
    expect(restored.layers[0].features[0].geometry).toEqual({ type: "Point", coordinates: [116, 39, 12] });
    expect(restored.layers[0].features[0].dbKey).toBeUndefined();
    expect(restored.layers[0].features[0].baseline).toBeUndefined();
    // 消费后不缓存公开对象，下一次恢复仍从独立的原始数据构造工作副本。
    restored.layers[0].features[0].properties.payload = "changed";
    expect(restoreWorkspace(raw).layers[0].features[0].properties.payload === payload).toBe(true);
    expect(parse.mock.calls.filter(([input]) => input === raw)).toHaveLength(2);
  } finally {
    parse.mockRestore();
    stringify.mockRestore();
  }
});

it("比较两个副本后直接恢复被选中的解析对象，嵌套字段不会影响修订号", () => {
  const snapshot = (revision: number) => JSON.stringify({
    version: 3, recoveryRevision: revision, tree: [{ kind: "layer", id: "l" }],
    layers: [{ id: "l", name: "l", features: [{ id: "f", geometry: null, properties: { nested: { recoveryRevision: 999_999 }, text: '"recoveryRevision":999999' } }] }],
  });
  const native = snapshot(100_001), local = snapshot(100_002);
  const parse = vi.spyOn(JSON, "parse");
  try {
    selectRecoverySnapshot(native, null);
    const chosen = selectRecoverySnapshot(native, local)!;
    expect(chosen).toBe(local);
    expect(restoreWorkspace(chosen).layers[0].features[0].id).toBe("f");
    expect(parse.mock.calls.filter(([input]) => input === native)).toHaveLength(1);
    expect(parse.mock.calls.filter(([input]) => input === local)).toHaveLength(1);
  } finally {
    parse.mockRestore();
  }
});

it("工作要素纯验证保留精度并移除数据库身份，不修改冻结的公开属性分支", () => {
  const nested = Object.freeze({ unsafe: 9007199254740992, finite: 1.25, missing: undefined });
  const properties = Object.freeze({ large: "x".repeat(1024), nested, list: Object.freeze([NaN, undefined, -0]) });
  const geometry = Object.freeze({ type: "Point" as const, coordinates: Object.freeze([116, 39, 12]) }) as unknown as GeoFeature["geometry"];
  const feature = Object.freeze({ id: "internal", geometry, properties, sourceFeatureId: "source-1", dbKey: { id: 1 }, baseline: { id: 1 } });
  const normalized = normalizeWorkingFeature(feature);
  expect(normalized.geometry).toBe(geometry);
  expect(normalized.properties).not.toBe(properties);
  expect(normalized.properties.nested).toEqual({ unsafe: "9007199254740992", finite: 1.25 });
  expect(normalized.properties.list).toEqual([null, null, 0]);
  expect(normalized.sourceFeatureId).toBe("source-1");
  expect(normalized.dbKey).toBeUndefined();
  expect(normalized.baseline).toBeUndefined();
  expect(nested.unsafe).toBe(9007199254740992);
  expect(Object.hasOwn(nested, "missing")).toBe(true);
  expect(properties.list[0]).toBeNaN();
  expect(Object.is(properties.list[2], -0)).toBe(true);
});

it("已解析属性保留既有 JSON 序列化语义，罕见包装值不扩散为运行期对象", () => {
  const list: unknown[] & { extra?: string } = [1, 2];
  list.extra = "runtime-only";
  const feature = normalizeWorkingFeature({ id: "f", geometry: null, properties: { list, date: new Date("2026-11-03T00:00:00Z"), wrapped: new Number(3), omitted: undefined } });
  expect(feature.properties).toEqual({ list: [1, 2], date: "2026-11-03T00:00:00.000Z", wrapped: 3 });
  expect(Object.hasOwn(feature.properties.list as object, "extra")).toBe(false);
  expect(list.extra).toBe("runtime-only");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => normalizeWorkingFeature({ id: "f", geometry: null, properties: cyclic })).toThrow();
});

it("大属性历史在编码前裁剪，不物化整帧字符串，当前修改和未完成草稿优先", () => {
  const payload = "x".repeat(2 * 1024 * 1024);
  const previous: GeoFeature[] = [{ id: "large-row", geometry: null, properties: { payload, name: "before" } }];
  const layer = makeLayer("large", [{ ...previous[0], properties: { payload, name: "latest" } }], "geojson", { dirty: true });
  const tree: LayerTreeNode[] = [{ kind: "layer", id: layer.id }];
  const session: WorkspaceEditSession = {
    layerId: layer.id, selectedId: "large-row", tool: "select", snapping: false,
    panelDraft: { kind: "json", featureId: "large-row", text: "unfinished {" },
    history: { undo: [previous, previous], redo: [previous], baseline: { features: previous, dirty: false } },
  };
  const stringify = vi.spyOn(JSON, "stringify");
  const featureEncodes = () => stringify.mock.calls.filter(([input]) => input?.properties?.payload === payload && input.properties.name === "before");
  try {
    const raw = snapshotWorkspace([layer], tree, session, 3 * 1024 * 1024);
    const restored = restoreWorkspace(raw);
    expect(restored.layers[0].features[0].properties.name).toBe("latest");
    expect(restored.layers[0].features[0].properties.payload === payload).toBe(true);
    expect(restored.layers[0].dirty).toBe(true);
    expect(restored.session?.panelDraft?.text).toBe("unfinished {");
    expect(restored.session?.history).toBeUndefined();
    // 仅编码当前要素；超限的旧帧尚未形成 JSON 字符串。
    expect(featureEncodes()).toHaveLength(0);
    stringify.mockClear();
    const withHistory = restoreWorkspace(snapshotWorkspace([layer], tree, session, 12 * 1024 * 1024));
    expect(withHistory.session?.history?.undo).toHaveLength(2);
    expect(withHistory.session?.history?.redo).toHaveLength(1);
    expect(withHistory.session?.history?.baseline?.features[0].properties.name).toBe("before");
    // 输出可重放，字节计数可复用，但不长期缓存整帧 JSON。
    expect(featureEncodes().length).toBeGreaterThan(0);
    expect(stringify.mock.calls.some(([input]) => Array.isArray(input) && input[0]?.properties?.payload === payload)).toBe(false);
  } finally {
    stringify.mockRestore();
  }
});

it("历史预算按 UTF-8 计量，裁剪不会误删当前多字节属性或草稿", () => {
  const payload = "界🙂".repeat(1024);
  const features: GeoFeature[] = [{ id: "f", geometry: null, properties: { payload } }];
  const layer = makeLayer("unicode", features, "geojson");
  const tree: LayerTreeNode[] = [{ kind: "layer", id: layer.id }];
  const session: WorkspaceEditSession = { layerId: layer.id, tool: "select", snapping: false, history: { undo: [features], redo: [], baseline: { features, dirty: false } } };
  const base = snapshotWorkspace([layer], tree, { ...session, history: undefined });
  const budget = new TextEncoder().encode(base).length + 1024;
  const raw = snapshotWorkspace([layer], tree, session, budget);
  const restored = restoreWorkspace(raw);
  expect(restored.layers[0].features[0].properties.payload === payload).toBe(true);
  expect(restored.session?.history).toBeUndefined();
  expect(new TextEncoder().encode(raw).length).toBeLessThan(budget);
});

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

it("恢复工作区时保留图层的已保存状态", () => {
  const saved = makeLayer("saved.geojson", [], "geojson", { dirty: false });
  const dirty = makeLayer("dirty.geojson", [], "geojson", { dirty: true });
  const restored = restoreLayers(snapshotLayers([saved, dirty]));
  expect(restored.map((layer) => layer.dirty)).toEqual([false, true]);
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

it("旧数据库副本保留数据库来源标识，无来源配置时不猜原表和基线", () => {
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
    sourceKind: "postgis",
    dirty: false,
    restored: true,
    opacity: 0.5,
    strokeWidth: 4,
  });
  expect(restored.db).toMatchObject({
    engine: "postgis",
    connectionId: "",
    schema: "",
    table: "",
    keyColumns: [],
  });
  expect(restored.dbBaseline).toBeUndefined();
  expect(restored.dbNeedsVerification).toBe(true);
  expect(restored.features[0].properties).toEqual({ a: 1 });
});

it("无效恢复内容被拒绝，不静默跳过或降低维度", () => {
  expect(() => restoreLayers("{}")).toThrow("图层列表");
  expect(() =>
    restoreLayers(
      '[{"name":"bad","dirty":false,"features":[{"geometry":{"type":"Point","coordinates":[1,2,3,4]},"properties":{}}]}]',
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

it("文件恢复保留输出格式、CRS、CSV 几何列和 ZIP 成员，运行期句柄不持久化", () => {
  const csv = makeLayer("custom.csv", [], "csv", {
    sourceId: "transient",
    sourcePath: "F:/owned/custom.csv",
    sourceHash: "hash",
    originalCrs: "EPSG:3857",
    csvConfig: {
      geometryMode: "wkt",
      wktColumn: "shape_text",
      crs: "EPSG:3857",
    },
  });
  const shp = makeLayer("cities", [], "shp", {
    sourcePath: "F:/owned/multi.zip",
    sourceHash: "zip-hash",
    zipMember: "nested/cities",
    originalCrs: "EPSG:4490",
  });
  const restored = restoreLayers(snapshotLayers([csv, shp]));
  expect(restored[0]).toMatchObject({
    sourceKind: "csv",
    sourcePath: csv.sourcePath,
    sourceHash: "hash",
    originalCrs: "EPSG:3857",
    csvConfig: csv.csvConfig,
  });
  expect(restored[0].sourceId).toBeUndefined();
  expect(restored[1]).toMatchObject({
    sourceKind: "shp",
    zipMember: "nested/cities",
    originalCrs: "EPSG:4490",
  });
});

it("旧统一 GeoJSON 快照按来源路径识别格式，缺失元数据不会补造", () => {
  const [csv] = restoreLayers(
    JSON.stringify([
      {
        name: "old.csv",
        sourceKind: "geojson",
        sourcePath: "F:/owned/old.csv",
        features: [],
      },
    ]),
  );
  expect(csv.sourceKind).toBe("csv");
  expect(csv.originalCrs).toBeUndefined();
  expect(csv.csvConfig).toBeUndefined();
});

function databaseRecoveryFixture(engine: "postgis" | "mysql" = "postgis") {
  const original: GeoFeature = {
    id: "database-row-1",
    geometry: { type: "Point", coordinates: [116, 40] },
    properties: { name: "原始记录" },
    dbKey: { id: "9007199254740993" },
    baseline: {
      id: "9007199254740993",
      name: "原始记录",
      geom: "010100-original",
      nested: { a: true },
    },
  };
  return makeLayer(
    "points",
    [{ ...original, properties: { name: "工作稿" } }],
    engine,
    {
      dirty: true,
      db: {
        engine,
        sourceId: "configured-source-1",
        connectionId: "transient-connection",
        schema: "public",
        table: "points",
        geometryColumn: "geom",
        geometryKind: "geometry",
        srid: 4326,
        keyColumns: ["id"],
        columns: [
          { name: "id", type: "int8", nullable: false, generated: true },
          { name: "name", type: "text", nullable: true, hasDefault: true },
        ],
      },
      dbBaseline: [original],
      dbReadLimit: 10_000,
      dbBounds: [100, 20, 130, 50],
      schemaChanges: [{ kind: "rename", name: "name", newName: "label" }],
      dbCommitUncertain: true,
      dbConnectionError: "do-not-persist-runtime-error",
    },
  );
}

it("数据库恢复白名单保留配置 ID、完整原始基线和字段修改，排除凭据及连接句柄", () => {
  for (const engine of ["postgis", "mysql"] as const) {
    const layer = databaseRecoveryFixture(engine);
    Object.assign(layer.db!, {
      host: "private-host",
      user: "private-user",
      password: "private-password",
      connectionString: "private-connection-string",
    });
    Object.assign(layer.db!.columns[0], { token: "private-column-token" });
    const snapshot = snapshotLayers([layer]);
    for (const forbidden of [
      "connectionId",
      "transient-connection",
      "private-host",
      "private-user",
      "private-password",
      "private-connection-string",
      "private-column-token",
      "do-not-persist-runtime-error",
    ])
      expect(snapshot).not.toContain(forbidden);
    expect(snapshot).toContain("configured-source-1");
    const raw = JSON.parse(snapshot)[0];
    expect(raw.features[0].dbKey).toBeUndefined();
    expect(raw.features[0].baseline).toBeUndefined();
    expect(raw.dbBaseline).toEqual(layer.dbBaseline);
    const [restored] = restoreLayers(snapshot);
    expect(restored).toMatchObject({
      sourceKind: engine,
      dbNeedsVerification: true,
      dbCommitUncertain: true,
      db: { ...raw.db, connectionId: "" },
      dbBaseline: layer.dbBaseline,
      dbReadLimit: 10_000,
      dbBounds: [100, 20, 130, 50],
      schemaChanges: layer.schemaChanges,
    });
    expect(restored.features[0].properties).toEqual({ name: "工作稿" });
    expect(restored.features[0].dbKey).toBeUndefined();
    expect(restored.dbConnectionError).toBeUndefined();
    expect(restoreLayers(snapshotLayers([restored]))[0].dbCommitUncertain).toBe(
      true,
    );
  }
});

it("legacy restoredFrom 数据库来源不降为文件或工作区，不补造原表身份", () => {
  for (const engine of ["postgis", "mysql"] as const) {
    const [restored] = restoreLayers(
      JSON.stringify([
        {
          name: "legacy.geojson",
          sourceKind: "geojson",
          restoredFrom: engine,
          sourcePath: "F:/do-not-overwrite.geojson",
          features: [],
        },
      ]),
    );
    expect(restored).toMatchObject({
      sourceKind: engine,
      dbNeedsVerification: true,
      db: { engine, connectionId: "", table: "", schema: "", keyColumns: [] },
    });
    expect(restored.db?.sourceId).toBeUndefined();
    expect(restored.dbBaseline).toBeUndefined();
    expect(restored.sourcePath).toBeUndefined();
  }
});

it("旧快照仅残留数据库 connectionId 时恢复为无原表身份占位，残缺真实 metadata 仍拒绝", () => {
  for (const engine of ["postgis", "mysql"] as const) {
    for (const db of [
      { connectionId: "expired-handle" },
      { engine, connectionId: "expired-handle" },
    ]) {
      const [restored] = restoreLayers(
        JSON.stringify([
          {
            name: "old-database",
            sourceKind: engine,
            db,
            features: [
              { id: "row", geometry: null, properties: { name: "保留工作稿" } },
            ],
            dirty: true,
          },
        ]),
      );
      expect(restored).toMatchObject({
        sourceKind: engine,
        dirty: true,
        dbNeedsVerification: true,
        db: { engine, connectionId: "", schema: "", table: "", keyColumns: [] },
      });
      expect(restored.features[0].properties).toEqual({ name: "保留工作稿" });
      expect(restored.db?.sourceId).toBeUndefined();
      expect(restored.dbBaseline).toBeUndefined();
    }
    expect(() =>
      restoreLayers(
        JSON.stringify([
          {
            name: "corrupt-database",
            sourceKind: engine,
            db: { connectionId: "expired-handle", table: "partial-table" },
            features: [],
          },
        ]),
      ),
    ).toThrow("数据库");
  }
});

it("只读数据库图层的空键记录可保存和恢复，不保留不可核对的提交基线", () => {
  for (const engine of ["postgis", "mysql"] as const) {
    const layer = databaseRecoveryFixture(engine);
    layer.db!.keyColumns = [];
    layer.dirty = false;
    layer.schemaChanges = undefined;
    layer.dbCommitUncertain = undefined;
    const rows = [1, 2].map((value) => ({
      id: `readonly-${value}`,
      geometry: null,
      properties: { name: `记录-${value}` },
      dbKey: {},
      baseline: engine === "mysql" ? {} : { name: `记录-${value}` },
    }));
    layer.features = rows;
    layer.dbBaseline = rows;
    const file = makeLayer(
      "local",
      [{ id: "local-1", geometry: null, properties: { name: "本地工作稿" } }],
      "geojson",
      { dirty: true },
    );
    const snapshot = snapshotWorkspace(
      [layer, file],
      [layer, file].map(({ id }) => ({ kind: "layer", id })),
    );
    const workspace = restoreWorkspace(snapshot);
    const restored = workspace.layers[0];
    expect(workspace.layers[1].features).toEqual(file.features);
    expect(workspace.layers[1].dirty).toBe(true);
    expect(restored.features.map((feature) => feature.properties)).toEqual(
      rows.map((feature) => feature.properties),
    );
    expect(restored.db).toMatchObject({
      engine,
      keyColumns: [],
      connectionId: "",
    });
    expect(restored.dbBaseline).toEqual([]);
    expect(restored.dbNeedsVerification).toBe(true);
    expect(restored.dirty).toBe(false);
    expect(() => snapshotLayers([restored])).not.toThrow();

    // 兼容旧版写入的只读基线，同时保留来源和读取范围。
    const legacy = JSON.parse(snapshot);
    legacy.layers[0].dbBaseline = rows;
    const oldRestored = restoreWorkspace(JSON.stringify(legacy)).layers[0];
    expect(oldRestored.dbBaseline).toEqual([]);
    expect(oldRestored.db?.sourceId).toBe(layer.db!.sourceId);
    expect(oldRestored.dbReadLimit).toBe(layer.dbReadLimit);
    expect(oldRestored.dbBounds).toEqual(layer.dbBounds);
  }
});

it("数据库基线及读取条件损坏明确拒绝，空只读基线允许恢复", () => {
  const layer = databaseRecoveryFixture();
  const duplicate = { ...layer.dbBaseline![0], id: "duplicate-key" };
  expect(() =>
    snapshotLayers([
      { ...layer, dbBaseline: [...layer.dbBaseline!, duplicate] },
    ]),
  ).toThrow("重复键");
  const original = JSON.parse(snapshotLayers([layer]));
  const corruptions = [
    (raw: typeof original) => {
      delete raw[0].dbBaseline[0].baseline;
    },
    (raw: typeof original) => {
      raw[0].dbBaseline.push({ ...raw[0].dbBaseline[0], id: "duplicate-key" });
    },
    (raw: typeof original) => {
      raw[0].dbBaseline[0].dbKey = null;
    },
    (raw: typeof original) => {
      raw[0].dbBaseline[0].baseline = JSON.parse('{"__proto__":{}}');
    },
    (raw: typeof original) => {
      raw[0].dbReadLimit = 0;
    },
    (raw: typeof original) => {
      raw[0].dbBounds = [1, 2, 3];
    },
    (raw: typeof original) => {
      raw[0].dbCommitUncertain = "true";
    },
    (raw: typeof original) => {
      raw[0].db.engine = "unknown";
    },
    (raw: typeof original) => {
      raw[0].schemaChanges = [{ kind: "rename", name: "name" }];
    },
  ];
  for (const corrupt of corruptions) {
    const raw = structuredClone(original);
    corrupt(raw);
    expect(() => restoreLayers(JSON.stringify(raw))).toThrow();
  }
  original[0].dbBaseline = [];
  original[0].db.keyColumns = [];
  expect(restoreLayers(JSON.stringify(original))[0].dbBaseline).toEqual([]);
});
