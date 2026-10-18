import type { DocumentLayer, GeoFeature } from "./domain/types";

export const FIELD_PROFILE_LIMITS = {
  features: 10_000,
  fields: 512,
  fieldVisits: 100_000,
  fieldNameLength: 512,
  valueLength: 4096,
  textBytes: 4 * 1024 * 1024,
  topValues: 8,
  histogramBins: 10,
} as const;

export type ProfileValueType =
  "number" | "string" | "boolean" | "array" | "object" | "other";
export type ProfileBlocked = { status: "blocked"; reason: string };
export interface NumericFieldProfile {
  min: number;
  max: number;
  mean: number;
  median: number;
  histogram: { min: number; max: number; count: number }[];
}
export interface CompleteFieldProfile {
  status: "complete";
  field: string;
  totalCount: number;
  validCount: number;
  nullCount: number;
  missingCount: number;
  types: Record<ProfileValueType, number>;
  unsafeNumberCount: number;
  numeric?: NumericFieldProfile;
  commonValues: {
    type: "number" | "string" | "boolean";
    value: string | number | boolean;
    count: number;
  }[];
  distinctScalarCount: number;
}

const blocked = (reason: string): ProfileBlocked => ({
  status: "blocked",
  reason,
});
const has = (value: unknown, field: string) =>
  value !== null &&
  typeof value === "object" &&
  Object.prototype.hasOwnProperty.call(value, field);

/** 完整发现已加载图层的字段；预算不足时不返回部分字段列表。 */
export function profileFields(
  layer: Pick<DocumentLayer, "features" | "fieldNames">,
): { status: "complete"; fields: string[] } | ProfileBlocked {
  if (layer.features.length > FIELD_PROFILE_LIMITS.features)
    return blocked("字段概览最多统计10000个已加载要素，请先缩小图层");
  const fields = new Set<string>();
  let visits = 0;
  const add = (field: string) => {
    visits++;
    if (
      field.length > FIELD_PROFILE_LIMITS.fieldNameLength ||
      visits > FIELD_PROFILE_LIMITS.fieldVisits
    )
      return false;
    fields.add(field);
    return fields.size <= FIELD_PROFILE_LIMITS.fields;
  };
  for (const field of layer.fieldNames ?? [])
    if (!add(field)) return blocked("字段目录超过概览预算，请缩小字段范围");
  for (const feature of layer.features) {
    for (const field in feature.properties) {
      if (has(feature.properties, field) && !add(field))
        return blocked("字段目录超过概览预算，请缩小字段范围");
    }
  }
  return { status: "complete", fields: [...fields] };
}

/** 每次只扫描所选字段，不采样，不序列化嵌套对象，也不转换数字文本。 */
export function profileField(
  features: readonly GeoFeature[],
  field: string,
): CompleteFieldProfile | ProfileBlocked {
  if (features.length > FIELD_PROFILE_LIMITS.features)
    return blocked("字段概览最多统计10000个已加载要素，请先缩小图层");
  if (!field || field.length > FIELD_PROFILE_LIMITS.fieldNameLength)
    return blocked("字段名称不适用于概览");
  const result: CompleteFieldProfile = {
    status: "complete",
    field,
    totalCount: features.length,
    validCount: 0,
    nullCount: 0,
    missingCount: 0,
    types: { number: 0, string: 0, boolean: 0, array: 0, object: 0, other: 0 },
    unsafeNumberCount: 0,
    commonValues: [],
    distinctScalarCount: 0,
  };
  const counts = new Map<
    string,
    CompleteFieldProfile["commonValues"][number]
  >();
  const numbers: number[] = [];
  let textBytes = 0;
  for (const feature of features) {
    if (!has(feature.properties, field)) {
      result.missingCount++;
      continue;
    }
    const value = feature.properties[field];
    if (value === null) {
      result.nullCount++;
      continue;
    }
    result.validCount++;
    const type: ProfileValueType = Array.isArray(value)
      ? "array"
      : typeof value === "number"
        ? "number"
        : typeof value === "string"
          ? "string"
          : typeof value === "boolean"
            ? "boolean"
            : typeof value === "object"
              ? "object"
              : "other";
    result.types[type]++;
    if (typeof value === "string") {
      textBytes += value.length * 2;
      if (
        value.length > FIELD_PROFILE_LIMITS.valueLength ||
        textBytes > FIELD_PROFILE_LIMITS.textBytes
      ) {
        return blocked("所选字段文本超过概览预算，未返回部分统计");
      }
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        result.unsafeNumberCount++;
      else numbers.push(value);
    }
    if (
      (typeof value === "number" && Number.isFinite(value)) ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      const scalar = value as number | string | boolean;
      const scalarType = typeof scalar as "number" | "string" | "boolean";
      const key = `${scalarType}:${String(scalar)}`;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { type: scalarType, value: scalar, count: 1 });
    }
  }
  result.distinctScalarCount = counts.size;
  result.commonValues = [...counts.entries()]
    .sort(
      ([a, av], [b, bv]) => bv.count - av.count || (a < b ? -1 : a > b ? 1 : 0),
    )
    .slice(0, FIELD_PROFILE_LIMITS.topValues)
    .map(([, value]) => value);
  // 混型字段保留类型与频次概览，不用子集均值冒充全字段统计。
  if (numbers.length > 0 && numbers.length === result.validCount) {
    numbers.sort((a, b) => a - b);
    const min = numbers[0],
      max = numbers[numbers.length - 1];
    // 缩放后求和，避免大样本累计越过安全整数范围；结果明确是近似值。
    const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
    let mean = 0,
      correction = 0;
    for (const number of numbers) {
      const term = number / scale / numbers.length;
      const next = mean + term;
      correction +=
        Math.abs(mean) >= Math.abs(term)
          ? mean - next + term
          : term - next + mean;
      mean = next;
    }
    const mid = Math.floor(numbers.length / 2);
    const median =
      numbers.length % 2
        ? numbers[mid]
        : numbers[mid - 1] + (numbers[mid] - numbers[mid - 1]) / 2;
    const boundaries = [min];
    if (min !== max) {
      for (let index = 1; index < FIELD_PROFILE_LIMITS.histogramBins; index++) {
        const boundary =
          min + (max - min) * (index / FIELD_PROFILE_LIMITS.histogramBins);
        if (boundary > boundaries[boundaries.length - 1] && boundary < max)
          boundaries.push(boundary);
      }
      boundaries.push(max);
    }
    const histogram =
      min === max
        ? [{ min, max, count: 0 }]
        : boundaries
            .slice(0, -1)
            .map((lower, index) => ({
              min: lower,
              max: boundaries[index + 1],
              count: 0,
            }));
    for (const number of numbers) {
      const index = histogram.findIndex(
        (bin, i) => number < bin.max || i === histogram.length - 1,
      );
      histogram[index].count++;
    }
    result.numeric = {
      min,
      max,
      mean: Math.max(min, Math.min(max, (mean + correction) * scale)),
      median,
      histogram,
    };
  }
  return result;
}
