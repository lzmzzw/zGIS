import type { CategorizedStyle, DocumentLayer } from "./domain/types";

export const MAX_DISPLAY_CATEGORIES = 32;
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
