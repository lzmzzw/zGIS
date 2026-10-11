import { expect, it } from "vitest";
import { makeLayer, type GeoFeature } from "./domain";
import {
  assertDatabaseUnchanged,
  resolveDatabaseConflicts,
  synchronizeDatabaseLayer,
  validatedDatabaseIdentities,
} from "./databaseRecovery";
import { databaseChanges } from "./dbChanges";

const row = (key: number, name = "原值", id = `row-${key}`): GeoFeature => ({
  id,
  geometry: { type: "Point", coordinates: [key, 2] },
  properties: { name },
  dbKey: { id: key },
  baseline: { id: key, name, geometry: `original-${key}` },
});

it("人工选择本地编辑会重基原表版本，选择原表编辑会清除本地差异", () => {
  const before = [row(1)];
  const local = [{ ...row(1), properties: { name: "本地修改" } }];
  const remote = [row(1, "原表修改", "fresh-id")];
  const doc = layer(before, local);
  const conflict = synchronizeDatabaseLayer(doc, remote).conflictRecords[0];
  expect(conflict).toMatchObject({
    key: '{"id":1}',
    before: before[0],
    local: local[0],
    remote: remote[0],
  });
  const keepLocal = resolveDatabaseConflicts(doc, remote, {
    [conflict.key]: "local",
  });
  expect(keepLocal.conflicts).toBe(false);
  expect(keepLocal.conflictRecords).toEqual([]);
  expect(keepLocal.features).toEqual(local);
  expect(keepLocal.baseline).toEqual([{ ...remote[0], id: before[0].id }]);
  expect(databaseChanges(keepLocal.baseline, keepLocal.features)).toMatchObject(
    [
      {
        kind: "update",
        baseline: remote[0].baseline,
        properties: local[0].properties,
      },
    ],
  );
  expect(() =>
    assertDatabaseUnchanged(keepLocal.baseline, remote),
  ).not.toThrow();
  const keepRemote = resolveDatabaseConflicts(doc, remote, {
    [conflict.key]: "remote",
  });
  expect(keepRemote.features).toEqual(keepRemote.baseline);
  expect(keepRemote.features[0].id).toBe(before[0].id);
  expect(databaseChanges(keepRemote.baseline, keepRemote.features)).toEqual([]);
  expect(doc.features).toEqual(local);
  expect(doc.dbBaseline).toEqual(before);
});

it("人工选择本地删除或原表编辑分别生成基于最新版本的删除或恢复", () => {
  const doc = layer([row(1)], []);
  const remote = [row(1, "原表修改")];
  const key = synchronizeDatabaseLayer(doc, remote).conflictRecords[0].key;
  const keepLocal = resolveDatabaseConflicts(doc, remote, { [key]: "local" });
  expect(keepLocal.features).toEqual([]);
  expect(databaseChanges(keepLocal.baseline, keepLocal.features)).toMatchObject(
    [{ kind: "delete", baseline: remote[0].baseline }],
  );
  const keepRemote = resolveDatabaseConflicts(doc, remote, { [key]: "remote" });
  expect(keepRemote.features).toEqual(remote);
  expect(keepRemote.baseline).toEqual(remote);
});

it("原表删除后保留本地编辑转为新增，接受原表删除移除工作稿和旧基线", () => {
  const local = [{ ...row(1), properties: { name: "本地修改" } }];
  const doc = layer([row(1)], local);
  const key = synchronizeDatabaseLayer(doc, []).conflictRecords[0].key;
  const keepLocal = resolveDatabaseConflicts(doc, [], { [key]: "local" });
  expect(keepLocal.features).toEqual(local);
  expect(keepLocal.baseline).toEqual([]);
  expect(databaseChanges(keepLocal.baseline, keepLocal.features)).toMatchObject(
    [{ kind: "insert", properties: local[0].properties }],
  );
  const keepRemote = resolveDatabaseConflicts(doc, [], { [key]: "remote" });
  expect(keepRemote.features).toEqual([]);
  expect(keepRemote.baseline).toEqual([]);
});

it("每条冲突需明确选择，缺项和不属于当前冲突的旧选择被拒绝", () => {
  const doc = layer(
    [row(1), row(2)],
    [
      { ...row(1), properties: { name: "本地1" } },
      { ...row(2), properties: { name: "本地2" } },
    ],
  );
  const remote = [row(1, "原表1"), row(2, "原表2")];
  expect(() => resolveDatabaseConflicts(doc, remote, {})).toThrow("每条");
  expect(() =>
    resolveDatabaseConflicts(doc, remote, { '{"id":1}': "local" }),
  ).toThrow("每条");
  expect(() =>
    resolveDatabaseConflicts(doc, remote, {
      '{"id":1}': "local",
      '{"id":2}': "remote",
      '{"id":3}': "local",
    }),
  ).toThrow("当前记录");
  const resolved = resolveDatabaseConflicts(doc, remote, {
    '{"id":1}': "local",
    '{"id":2}': "remote",
  });
  expect(() =>
    assertDatabaseUnchanged(resolved.baseline, [
      row(1, "原表又更新"),
      remote[1],
    ]),
  ).toThrow("冲突");
});

it("接收原表新增记录按待提交字段操作投射工作稿，原表基线不改名或删列", () => {
  const doc = layer([]);
  doc.schemaChanges = [
    { kind: "rename", name: "name", newName: "label" },
    { kind: "delete", name: "obsolete" },
    { kind: "add", name: "extra" },
  ];
  const remote = [
    {
      ...row(1, "远程新增"),
      properties: { name: "远程新增", obsolete: "待删", retained: 4 },
    },
  ];
  const result = synchronizeDatabaseLayer(doc, remote);
  expect(result.features[0].properties).toEqual({
    label: "远程新增",
    retained: 4,
    extra: null,
  });
  expect(result.baseline).toEqual(remote);
  expect(remote[0].properties).toEqual({
    name: "远程新增",
    obsolete: "待删",
    retained: 4,
  });
});

it("冲突选择原表版本同样应用字段投射，本地版本保持工作稿及最新原表基线", () => {
  const before = [row(1)];
  const local = [{ ...row(1), properties: { label: "本地", extra: null } }];
  const doc = layer(before, local);
  doc.schemaChanges = [
    { kind: "rename", name: "name", newName: "label" },
    { kind: "add", name: "extra" },
  ];
  const remote = [row(1, "原表更新")];
  const key = synchronizeDatabaseLayer(doc, remote).conflictRecords[0].key;
  const keepRemote = resolveDatabaseConflicts(doc, remote, { [key]: "remote" });
  expect(keepRemote.features[0].properties).toEqual({
    label: "原表更新",
    extra: null,
  });
  expect(keepRemote.baseline).toEqual(remote);
  const keepLocal = resolveDatabaseConflicts(doc, remote, { [key]: "local" });
  expect(keepLocal.features).toEqual(local);
  expect(keepLocal.baseline).toEqual(remote);
});
const layer = (before: GeoFeature[], features = before) =>
  makeLayer("table", features, "postgis", { dbBaseline: before });

it("重连核对忽略 JSON 对象键顺序，允许新增记录", () => {
  const before = {
    ...row(1),
    dbKey: { tenant: 2, id: 1 },
    baseline: { a: { x: 1, y: 2 }, b: [true, null] },
  };
  const current = {
    ...before,
    dbKey: { id: 1, tenant: 2 },
    baseline: { b: [true, null], a: { y: 2, x: 1 } },
  };
  expect(() =>
    assertDatabaseUnchanged([before], [current, row(2)]),
  ).not.toThrow();
  expect(() => assertDatabaseUnchanged([], [row(2)])).not.toThrow();
});

it("原始记录修改或删除会阻止提交，重复键与缺基线不能核对", () => {
  expect(() => assertDatabaseUnchanged([row(1)], [row(1, "外部修改")])).toThrow(
    "冲突",
  );
  expect(() => assertDatabaseUnchanged([row(1)], [])).toThrow("冲突");
  expect(() => assertDatabaseUnchanged([row(1)], [row(1), row(1)])).toThrow(
    "重复键",
  );
  expect(() => assertDatabaseUnchanged([row(1), row(1)], [row(1)])).toThrow(
    "重复键",
  );
  expect(() =>
    assertDatabaseUnchanged([row(1)], [{ ...row(1), baseline: undefined }]),
  ).toThrow("基线");
});

it("兼容普通 JSON 数组键与 opaque 基线，不接受无穷值、污染键或非 JSON 对象", () => {
  const opaque = { ...row(1), dbKey: [1], baseline: "baseline-1" };
  expect(() => assertDatabaseUnchanged([opaque], [opaque])).not.toThrow();
  for (const baseline of [
    undefined,
    null,
    Number.NaN,
    Infinity,
    new Date(),
    { a: undefined },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    expect(() =>
      validatedDatabaseIdentities([{ ...row(1), baseline }]),
    ).toThrow();
  }
  const sparse = Array(1);
  Object.assign(sparse, { extra: 1 });
  expect(() =>
    validatedDatabaseIdentities([{ ...row(1), dbKey: sparse }]),
  ).toThrow();
});

it("原表单独变化同步更新、删除及新增，按主键保留原内部 ID", () => {
  const before = [row(1), row(2)];
  const remote = [row(1, "外部修改", "fresh-1"), row(3, "新增", "fresh-3")];
  const result = synchronizeDatabaseLayer(layer(before), remote);
  expect(result.conflicts).toBe(false);
  expect(result.features).toEqual([{ ...remote[0], id: "row-1" }, remote[1]]);
  expect(result.baseline).toEqual(result.features);
  expect(databaseChanges(result.baseline, result.features)).toEqual([]);
  expect(() => assertDatabaseUnchanged(result.baseline, remote)).not.toThrow();
});

it("双方同时修改保留本地工作稿和旧基线，未修改记录接收外部更新", () => {
  const before = [row(1), row(2)];
  const local = [{ ...row(1), properties: { name: "本地修改" } }, row(2)];
  const remote = [row(1, "外部修改"), row(2, "外部更新")];
  const result = synchronizeDatabaseLayer(layer(before, local), remote);
  expect(result.conflicts).toBe(true);
  expect(result.features).toEqual([local[0], remote[1]]);
  expect(result.baseline).toEqual([before[0], remote[1]]);
  expect(() => assertDatabaseUnchanged(result.baseline, remote)).toThrow(
    "冲突",
  );
  const remoteUnchanged = synchronizeDatabaseLayer(
    layer([before[0]], [local[0]]),
    [before[0]],
  );
  expect(remoteUnchanged.conflicts).toBe(false);
  expect(remoteUnchanged.features).toEqual([local[0]]);
});

it("本地删除与新增保留，双方删除免重复提交，新远程记录避免内部 ID 冲突", () => {
  const before = [row(1), row(2), row(3)];
  const inserted: GeoFeature = {
    id: "new",
    geometry: null,
    properties: { name: "本地新增" },
  };
  const local = [row(3), inserted];
  const remote = [row(1), row(3), row(4, "远程新增", "new")];
  const result = synchronizeDatabaseLayer(layer(before, local), remote);
  expect(result.conflicts).toBe(false);
  expect(result.features.at(-1)).toEqual(inserted);
  expect(new Set(result.features.map((feature) => feature.id)).size).toBe(
    result.features.length,
  );
  expect(result.baseline.map((feature) => feature.dbKey)).toEqual([
    { id: 1 },
    { id: 3 },
    { id: 4 },
  ]);
  expect(
    databaseChanges(result.baseline, result.features).map(
      (change) => change.kind,
    ),
  ).toEqual(["insert", "delete"]);
  expect(
    databaseChanges(result.baseline, result.features).find(
      (change) => change.kind === "delete",
    )?.dbKey,
  ).toEqual({ id: 1 });
  const conflict = synchronizeDatabaseLayer(layer([row(1)], []), [
    row(1, "外部修改"),
  ]);
  expect(conflict.conflicts).toBe(true);
  expect(conflict.features).toEqual([]);
  expect(conflict.baseline).toEqual([row(1)]);
});
