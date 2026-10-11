import type { DocumentLayer, GeoFeature } from "./domain";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);

// 接口中的数据库键/基线为 unknown；只接受有限的普通 JSON，按对象键排序比较。
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 100) throw new Error("数据库键或基线嵌套过深");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index)) ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new Error("数据库键或基线不能包含稀疏数组或额外属性");
    return `[${keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new Error("数据库键或基线不能包含访问器");
        return canonicalJson(descriptor.value, depth + 1);
      })
      .join(",")}]`;
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("数据库键或基线必须为普通 JSON");
    if (Object.getOwnPropertySymbols(value).length)
      throw new Error("数据库键或基线不能包含 Symbol");
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (unsafeKeys.has(key)) throw new Error("数据库键或基线包含不安全键");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor))
          throw new Error("数据库键或基线不能包含访问器");
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1)}`;
      })
      .join(",")}}`;
  }
  throw new Error("数据库键或基线必须为有限普通 JSON");
}

export function validatedDatabaseIdentities(
  values: unknown,
): { dbKey: unknown; baseline: unknown }[] {
  if (!Array.isArray(values) || values.length > 100_000)
    throw new Error("恢复数据库基线列表无效或超过 100000 条");
  const keys = new Set<string>();
  return values.map((value) => {
    if (!isRecord(value) || value.dbKey == null || value.baseline == null)
      throw new Error("数据库记录缺少键或原始基线");
    const key = canonicalJson(value.dbKey);
    const baseline = canonicalJson(value.baseline);
    if (keys.has(key)) throw new Error("数据库记录存在重复键，无法核对来源");
    keys.add(key);
    return { dbKey: JSON.parse(key), baseline: JSON.parse(baseline) };
  });
}

export function assertDatabaseUnchanged(
  before: GeoFeature[],
  current: GeoFeature[],
): void {
  const previous = validatedDatabaseIdentities(before);
  const latest = validatedDatabaseIdentities(current);
  const byKey = new Map(
    latest.map((feature) => [
      canonicalJson(feature.dbKey),
      canonicalJson(feature.baseline),
    ]),
  );
  for (const feature of previous) {
    const baseline = byKey.get(canonicalJson(feature.dbKey));
    if (baseline === undefined || baseline !== canonicalJson(feature.baseline))
      throw new Error(
        "数据库来源记录已被修改或删除，恢复工作稿存在冲突，请核对后重新打开",
      );
  }
}

export interface DatabaseConflictRecord {
  key: string;
  before: GeoFeature;
  local?: GeoFeature;
  remote?: GeoFeature;
}
export interface DatabaseSynchronization {
  features: GeoFeature[];
  baseline: GeoFeature[];
  conflicts: boolean;
  conflictRecords: DatabaseConflictRecord[];
}

function workingDatabaseFeature(
  doc: DocumentLayer,
  feature: GeoFeature,
): GeoFeature {
  if (!doc.schemaChanges?.length) return feature;
  const properties = { ...feature.properties };
  for (const change of doc.schemaChanges) {
    if (change.kind === "delete") delete properties[change.name];
    else if (change.kind === "add") properties[change.name] = null;
    else if (change.newName !== undefined) {
      properties[change.newName] = properties[change.name] ?? null;
      delete properties[change.name];
    }
  }
  return { ...feature, properties };
}

// 基线中的内部 ID 连接恢复后的工作稿；数据库主键连接重新读取的原表。
export function synchronizeDatabaseLayer(
  doc: DocumentLayer,
  current: GeoFeature[],
): DatabaseSynchronization {
  if (doc.dbBaseline === undefined)
    throw new Error(
      "缺少原始数据库基线，无法自动合并恢复工作稿，请重新打开来源",
    );
  const before = doc.dbBaseline;
  const originalIdentities = validatedDatabaseIdentities(before);
  const currentIdentities = validatedDatabaseIdentities(current);
  const oldIds = new Set(before.map((feature) => feature.id));
  const localById = new Map(
    doc.features.map((feature) => [feature.id, feature]),
  );
  if (oldIds.size !== before.length || localById.size !== doc.features.length)
    throw new Error("数据库工作稿存在重复要素 ID");
  const currentByKey = new Map(
    current.map((feature, index) => [
      canonicalJson(currentIdentities[index].dbKey),
      feature,
    ]),
  );
  const knownKeys = new Set(
    originalIdentities.map((identity) => canonicalJson(identity.dbKey)),
  );
  const features: GeoFeature[] = [];
  const baseline: GeoFeature[] = [];
  const conflictRecords: DatabaseConflictRecord[] = [];
  let conflicts = false;
  const sameDocument = (left: GeoFeature, right: GeoFeature) =>
    canonicalJson(left.geometry) === canonicalJson(right.geometry) &&
    canonicalJson(left.properties) === canonicalJson(right.properties);
  for (let index = 0; index < before.length; index++) {
    const old = before[index];
    const remote = currentByKey.get(
      canonicalJson(originalIdentities[index].dbKey),
    );
    const local = localById.get(old.id);
    const localChanged = local === undefined || !sameDocument(old, local);
    if (!localChanged) {
      if (remote) {
        const synchronized = { ...remote, id: old.id };
        baseline.push(synchronized);
        features.push(workingDatabaseFeature(doc, synchronized));
      }
      continue;
    }
    // 双方都已删除，接受原表结果，后续提交不再次发送删除。
    if (!local && !remote) continue;
    const remoteChanged =
      !remote ||
      canonicalJson(remote.baseline) !==
        canonicalJson(originalIdentities[index].baseline);
    if (remoteChanged) {
      conflicts = true;
      conflictRecords.push({
        key: canonicalJson(originalIdentities[index].dbKey),
        before: old,
        local,
        remote,
      });
    }
    baseline.push(old);
    if (local) features.push(local);
  }
  const usedIds = new Set([
    ...oldIds,
    ...doc.features.map((feature) => feature.id),
  ]);
  let sequence = 0;
  for (let index = 0; index < current.length; index++) {
    const remote = current[index];
    if (knownKeys.has(canonicalJson(currentIdentities[index].dbKey))) continue;
    let id = remote.id;
    while (!id || usedIds.has(id))
      id = `${remote.id || "database"}-remote-${++sequence}`;
    usedIds.add(id);
    const synchronized = { ...remote, id };
    features.push(workingDatabaseFeature(doc, synchronized));
    baseline.push(synchronized);
  }
  // 本地新建记录没有原表身份，保留工作稿，提交时仍按新增处理。
  features.push(...doc.features.filter((feature) => !oldIds.has(feature.id)));
  return { features, baseline, conflicts, conflictRecords };
}

export function resolveDatabaseConflicts(
  doc: DocumentLayer,
  current: GeoFeature[],
  choices: Record<string, "local" | "remote">,
): {
  features: GeoFeature[];
  baseline: GeoFeature[];
  conflicts: false;
  conflictRecords: [];
} {
  const synchronized = synchronizeDatabaseLayer(doc, current);
  const required = new Set(
    synchronized.conflictRecords.map((record) => record.key),
  );
  if (Object.keys(choices).some((key) => !required.has(key)))
    throw new Error("数据库冲突选择不对应当前记录，请重新核对");
  for (const record of synchronized.conflictRecords) {
    if (
      !Object.hasOwn(choices, record.key) ||
      (choices[record.key] !== "local" && choices[record.key] !== "remote")
    )
      throw new Error("每条数据库冲突都必须明确选择保留本地或原表版本");
  }
  const featuresById = new Map(
    synchronized.features.map((feature) => [feature.id, feature]),
  );
  const baselineById = new Map(
    synchronized.baseline.map((feature) => [feature.id, feature]),
  );
  for (const record of synchronized.conflictRecords) {
    const id = record.before.id;
    featuresById.delete(id);
    baselineById.delete(id);
    // 两种选择都以用户实际看到的原表版本重新建立提交基线。
    if (record.remote) baselineById.set(id, { ...record.remote, id });
    if (choices[record.key] === "remote") {
      if (record.remote)
        featuresById.set(
          id,
          workingDatabaseFeature(doc, { ...record.remote, id }),
        );
    } else if (record.local) {
      // 原表已删除时没有基线，该工作稿后续提交自然成为新增记录。
      featuresById.set(id, record.local);
    }
  }
  return {
    features: [...featuresById.values()],
    baseline: [...baselineById.values()],
    conflicts: false,
    conflictRecords: [],
  };
}

type DatabaseIdentity = Omit<NonNullable<DocumentLayer["db"]>, "connectionId">;

export function databaseEngine(
  value: unknown,
): "postgis" | "mysql" | undefined {
  return value === "postgis" || value === "mysql" ? value : undefined;
}

function identifier(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    value.length > 1024 ||
    value.includes("\0")
  )
    throw new Error(`恢复数据库${label}无效`);
  return value;
}

// 仅保存源配置 ID 和表结构，明确排除连接句柄、主机、账号及密码。
export function safeDatabaseIdentity(
  input: unknown,
  fallback: "postgis" | "mysql",
): DatabaseIdentity {
  if (!isRecord(input)) throw new Error("恢复数据库来源结构无效");
  const engine =
    input.engine === undefined ? fallback : databaseEngine(input.engine);
  if (!engine) throw new Error("恢复数据库引擎无效");
  if (!Array.isArray(input.keyColumns) || input.keyColumns.length > 10_000)
    throw new Error("恢复数据库主键结构无效");
  const keyColumns = input.keyColumns.map((key) => identifier(key, "主键列"));
  if (new Set(keyColumns).size !== keyColumns.length)
    throw new Error("恢复数据库主键列重复");
  if (!Array.isArray(input.columns) || input.columns.length > 10_000)
    throw new Error("恢复数据库字段结构无效");
  const columns = input.columns.map((column) => {
    if (
      !isRecord(column) ||
      typeof column.nullable !== "boolean" ||
      (column.generated !== undefined &&
        typeof column.generated !== "boolean") ||
      (column.hasDefault !== undefined &&
        typeof column.hasDefault !== "boolean")
    )
      throw new Error("恢复数据库字段定义无效");
    return {
      name: identifier(column.name, "字段名称"),
      type: identifier(column.type, "字段类型"),
      nullable: column.nullable,
      ...(column.generated !== undefined
        ? { generated: column.generated }
        : {}),
      ...(column.hasDefault !== undefined
        ? { hasDefault: column.hasDefault }
        : {}),
    };
  });
  if (new Set(columns.map((column) => column.name)).size !== columns.length)
    throw new Error("恢复数据库字段名称重复");
  if (input.geometryKind !== "geometry" && input.geometryKind !== "wkt")
    throw new Error("恢复数据库几何存储类型无效");
  if (!Number.isSafeInteger(input.srid) || Number(input.srid) < 0)
    throw new Error("恢复数据库 SRID 无效");
  return {
    engine,
    ...(input.sourceId !== undefined
      ? { sourceId: identifier(input.sourceId, "源配置 ID") }
      : {}),
    schema: identifier(input.schema, "库/模式", true),
    table: identifier(input.table, "表名", true),
    geometryColumn: identifier(input.geometryColumn, "几何列", true),
    geometryKind: input.geometryKind,
    srid: Number(input.srid),
    keyColumns,
    columns,
  };
}

export function legacyDatabaseIdentity(
  engine: "postgis" | "mysql",
): DatabaseIdentity {
  return {
    engine,
    schema: "",
    table: "",
    geometryColumn: "",
    geometryKind: "geometry",
    srid: 0,
    keyColumns: [],
    columns: [],
  };
}
