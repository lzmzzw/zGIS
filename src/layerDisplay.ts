import type {
  CategorizedStyle,
  DocumentLayer,
  LayerLabels,
  GraduatedStyle,
} from "./domain/types";

export const MAX_DISPLAY_CATEGORIES = 32;
export const isDisplayNumber = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= Number.MAX_SAFE_INTEGER;

export function parseManualBreaks(text: string): number[] {
  if (!text.trim()) return [];
  const segments = text.trim().split(/[,，;；]/);
  if (segments.some(segment => !segment.trim()))
    throw new Error("断点须为最多31个严格递增的安全数值。");
  const tokens = segments.flatMap(segment => segment.trim().split(/\s+/));
  const values = tokens.map(Number);
  if (tokens.some(token => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) || values.length > 31 || values.some((value, index) => !isDisplayNumber(value) || (index > 0 && value <= values[index - 1])))
    throw new Error("断点须为最多31个严格递增的安全数值。");
  return values;
}

function graduatedColors(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? 0.65 : index / (count - 1);
    return (
      "#" +
      [
        [194, 37],
        [219, 91],
        [237, 145],
      ]
        .map(([start, end]) =>
          Math.round(start + (end - start) * ratio)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  });
}
export function createGraduatedStyle(
  layer: DocumentLayer,
  field: string,
  method: GraduatedStyle["method"] = "equal_interval",
  classes = 5,
  manualBreaks: number[] = [],
): GraduatedStyle {
  if (!field || field.length > 1024) throw new Error("请选择有效的分级字段。");
  if (!Number.isInteger(classes) || classes < 1 || classes > 32)
    throw new Error("分级数量须为1至32。");
  let breaks: number[];
  if (method === "manual") {
    if (
      manualBreaks.length > 31 ||
      manualBreaks.some(
        (value, index) =>
          !isDisplayNumber(value) ||
          (index > 0 && value <= manualBreaks[index - 1]),
      )
    )
      throw new Error("断点须为最多31个严格递增的安全数值。");
    breaks = [...manualBreaks];
  } else {
    const values = layer.features
      .flatMap((feature) =>
        Object.hasOwn(feature.properties, field) &&
        isDisplayNumber(feature.properties[field])
          ? [feature.properties[field] as number]
          : [],
      )
      .sort((a, b) => a - b);
    if (!values.length) throw new Error("该字段没有可分级的安全数值。");
    const min = values[0],
      max = values[values.length - 1];
    breaks = [
      ...new Set(
        Array.from({ length: classes - 1 }, (_, index) =>
          method === "quantile"
            ? values[Math.ceil((values.length * (index + 1)) / classes) - 1]
            : min + (max - min) * ((index + 1) / classes),
        ),
      ),
    ].filter((value) => value < max && value >= min);
  }
  return {
    field,
    method,
    breaks,
    colors: graduatedColors(breaks.length + 1),
    otherColor: "#7c8794",
    nullColor: "#b8b8b8",
    missingColor: "#565e68",
  };
}
export function normalizeGraduatedStyle(
  value: unknown,
): GraduatedStyle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const style = value as Record<string, unknown>;
  if (
    typeof style.field !== "string" ||
    !style.field ||
    style.field.length > 1024 ||
    !["equal_interval", "quantile", "manual"].includes(String(style.method)) ||
    !Array.isArray(style.breaks) ||
    style.breaks.length > 31 ||
    style.breaks.some(
      (value, index) =>
        !isDisplayNumber(value) ||
        (index > 0 && value <= (style.breaks as number[])[index - 1]),
    ) ||
    !Array.isArray(style.colors) ||
    style.colors.length !== style.breaks.length + 1 ||
    !style.colors.every(isColor) ||
    !isColor(style.otherColor) ||
    !isColor(style.nullColor) ||
    !isColor(style.missingColor)
  )
    return;
  return {
    field: style.field,
    method: style.method as GraduatedStyle["method"],
    breaks: [...style.breaks],
    colors: [...style.colors],
    otherColor: style.otherColor,
    nullColor: style.nullColor,
    missingColor: style.missingColor,
  };
}
export function graduatedIndex(
  properties: Record<string, unknown>,
  style: GraduatedStyle,
): number | "missing" | "null" | "other" {
  if (!Object.hasOwn(properties, style.field)) return "missing";
  const value = properties[style.field];
  if (value === null) return "null";
  if (!isDisplayNumber(value)) return "other";
  const index = style.breaks.findIndex((bound) => value <= bound);
  return index < 0 ? style.breaks.length : index;
}
export function graduatedColor(
  properties: Record<string, unknown>,
  style: GraduatedStyle,
): string {
  const index = graduatedIndex(properties, style);
  return typeof index === "number"
    ? style.colors[index]
    : style[`${index}Color`];
}
export function graduatedRangeLabel(
  style: GraduatedStyle,
  index: number,
): string {
  if (!style.breaks.length) return "全部数值";
  if (index === 0) return `≤ ${style.breaks[0]}`;
  if (index === style.breaks.length) return `> ${style.breaks[index - 1]}`;
  return `(${style.breaks[index - 1]}, ${style.breaks[index]}]`;
}
export interface LayerLegendItem {
  key: string;
  label: string;
  color: string;
  count: number;
  translate?: boolean;
}
export function layerLegendItems(layer: DocumentLayer): LayerLegendItem[] {
  const graduated = layer.graduatedStyle,
    categorized = layer.categorizedStyle;
  if (!graduated && !categorized)
    return [
      {
        key: "single",
        label: "全部要素",
        translate: true,
        color: layer.color,
        count: layer.features.length,
      },
    ];
  const style = (graduated ?? categorized)!;
  const items: LayerLegendItem[] = graduated
    ? graduated.colors.map((color, index) => ({
        key: String(index),
        label: graduatedRangeLabel(graduated, index),
        translate: graduated.breaks.length === 0,
        color,
        count: 0,
      }))
    : categorized!.categories.map((category, index) => ({
        key: String(index),
        label: JSON.stringify(category.value),
        color: category.color,
        count: 0,
      }));
  items.push(
    ...(
      [
        [
          "other",
          graduated ? "非数值或超出安全范围" : "其他",
          style.otherColor,
        ],
        ["null", "空值（null）", style.nullColor],
        ["missing", "字段缺失", style.missingColor],
      ] as const
    ).map(([key, label, color]) => ({
      key,
      label,
      color,
      count: 0,
      translate: true,
    })),
  );
  const counts = new Map(items.map((item) => [item.key, item]));
  for (const feature of layer.features) {
    let key: string;
    if (graduated) key = String(graduatedIndex(feature.properties, graduated));
    else if (!Object.hasOwn(feature.properties, style.field)) key = "missing";
    else if (feature.properties[style.field] === null) key = "null";
    else {
      const index = categorized!.categories.findIndex(
        (category) =>
          categoryKey(category.value) ===
          categoryKey(feature.properties[style.field]),
      );
      key = index < 0 ? "other" : String(index);
    }
    counts.get(key)!.count++;
  }
  return items;
}
export const MAX_LAYER_LABELS = 1000;
export const MAX_LABEL_CHARACTERS = 80;

export function createLayerLabels(field: string): LayerLabels {
  return {
    field,
    fontSize: 13,
    color: "#202733",
    haloColor: "#ffffff",
    haloWidth: 3,
  };
}
export function normalizeLayerLabels(value: unknown): LayerLabels | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const labels = value as Record<string, unknown>;
  if (
    typeof labels.field !== "string" ||
    !labels.field ||
    labels.field.length > 1024 ||
    typeof labels.fontSize !== "number" ||
    !Number.isInteger(labels.fontSize) ||
    labels.fontSize < 8 ||
    labels.fontSize > 32 ||
    typeof labels.haloWidth !== "number" ||
    !Number.isFinite(labels.haloWidth) ||
    labels.haloWidth < 0 ||
    labels.haloWidth > 6 ||
    !isColor(labels.color) ||
    !isColor(labels.haloColor)
  )
    return;
  return {
    field: labels.field,
    fontSize: labels.fontSize,
    color: labels.color,
    haloColor: labels.haloColor,
    haloWidth: labels.haloWidth,
  };
}
export function labelText(value: unknown): string {
  if (
    typeof value !== "string" &&
    typeof value !== "boolean" &&
    !(typeof value === "number" && Number.isFinite(value))
  )
    return "";
  // 先约束输入长度，再按码点截断；不拆开代理对，也不复制超长属性全文。
  const text = String(value)
    .slice(0, MAX_LABEL_CHARACTERS * 2 + 2)
    .replace(/[\r\n\t]/g, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length > MAX_LABEL_CHARACTERS
    ? characters.slice(0, MAX_LABEL_CHARACTERS - 1).join("") + "…"
    : text;
}
export function layerLabelTexts(layer: DocumentLayer): Map<string, string> {
  const labels = new Map<string, string>();
  if (!layer.labels) return labels;
  for (const feature of layer.features) {
    if (
      !feature.geometry ||
      !Object.hasOwn(feature.properties, layer.labels.field)
    )
      continue;
    const text = labelText(feature.properties[layer.labels.field]);
    if (text) labels.set(feature.id, text);
    if (labels.size === MAX_LAYER_LABELS) break;
  }
  return labels;
}
const palette = [
  "#3978b8",
  "#e38d3d",
  "#5b9c66",
  "#bd607a",
  "#8e74b4",
  "#5b9eaa",
  "#b5a33f",
  "#ad7860",
  "#185a91",
  "#bf5d28",
  "#337345",
  "#973b60",
  "#654899",
  "#287d8b",
  "#8d7d1e",
  "#83533c",
  "#69a3d5",
  "#f3b469",
  "#8cc68a",
  "#df90a2",
  "#b49bd0",
  "#8ac8cf",
  "#d6c76f",
  "#cda38c",
  "#426fa0",
  "#d39b60",
  "#6f8c49",
  "#ba6870",
  "#9273a2",
  "#4d9491",
  "#a8a15d",
  "#987f70",
];
const isColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
export function categoryKey(value: unknown): string | undefined {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return `${typeof value}:${JSON.stringify(value)}`;
}
export function displayFields(layer: DocumentLayer): string[] {
  return [
    ...new Set([
      ...(layer.fieldNames ?? []),
      ...layer.features.flatMap((feature) => Object.keys(feature.properties)),
    ]),
  ];
}
export function createCategorizedStyle(
  layer: DocumentLayer,
  field: string,
): CategorizedStyle {
  const categories: CategorizedStyle["categories"] = [];
  const seen = new Set<string>();
  for (const feature of layer.features) {
    const value = feature.properties[field];
    const key = Object.hasOwn(feature.properties, field)
      ? categoryKey(value)
      : undefined;
    if (key === undefined || seen.has(key)) continue;
    if (categories.length === MAX_DISPLAY_CATEGORIES) break;
    seen.add(key);
    categories.push({
      value: value as string | number | boolean,
      color: palette[categories.length % palette.length],
    });
  }
  return {
    field,
    categories,
    otherColor: "#7c8794",
    nullColor: "#b8b8b8",
    missingColor: "#565e68",
  };
}
export function normalizeCategorizedStyle(
  value: unknown,
): CategorizedStyle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const style = value as Record<string, unknown>;
  if (
    typeof style.field !== "string" ||
    !style.field ||
    style.field.length > 1024 ||
    !Array.isArray(style.categories) ||
    style.categories.length > MAX_DISPLAY_CATEGORIES ||
    !isColor(style.otherColor) ||
    !isColor(style.nullColor) ||
    !isColor(style.missingColor)
  )
    return;
  const categories: CategorizedStyle["categories"] = [];
  const keys = new Set<string>();
  for (const item of style.categories) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const key = categoryKey(item.value);
    if (key === undefined || keys.has(key) || !isColor(item.color)) return;
    keys.add(key);
    categories.push({ value: item.value, color: item.color });
  }
  return {
    field: style.field,
    categories,
    otherColor: style.otherColor,
    nullColor: style.nullColor,
    missingColor: style.missingColor,
  };
}
export function categoryColor(
  properties: Record<string, unknown>,
  style: CategorizedStyle,
): string {
  if (!Object.hasOwn(properties, style.field)) return style.missingColor;
  if (properties[style.field] === null) return style.nullColor;
  const key = categoryKey(properties[style.field]);
  return (
    style.categories.find((category) => categoryKey(category.value) === key)
      ?.color ?? style.otherColor
  );
}
export function reconcileDisplayFieldChange(
  layer: DocumentLayer,
  oldName: string,
  newName?: string,
): DocumentLayer {
  if (layer.categorizedStyle?.field !== oldName) return layer;
  return {
    ...layer,
    categorizedStyle: newName
      ? { ...layer.categorizedStyle, field: newName }
      : undefined,
  };
}
