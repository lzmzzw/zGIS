import { parseProperties } from "./domain";

export function parseCellValue(
  text: string,
  original: unknown,
  isNull = false,
): unknown {
  if (isNull) return null;
  if (typeof original === "string") return text;
  if (!text.trim()) throw new Error("请输入值；空值请使用 NULL");
  // 先校验单个 JSON 值，再使用领域解析器保留数值精度。
  JSON.parse(text);
  const value = parseProperties(`{"value":${text}}`).value;
  if (
    typeof original === "number" &&
    (typeof value !== "number" || !Number.isFinite(value))
  )
    throw new Error(
      "请输入可保真保存的有限数值；高精度数值请使用 JSON 属性编辑",
    );
  if (typeof original === "boolean" && typeof value !== "boolean")
    throw new Error("请选择 true 或 false");
  if (
    original !== null &&
    typeof original === "object" &&
    (value === null ||
      typeof value !== "object" ||
      Array.isArray(value) !== Array.isArray(original))
  )
    throw new Error(
      Array.isArray(original) ? "请输入 JSON 数组" : "请输入 JSON 对象",
    );
  return value;
}

export function cellText(value: unknown): string {
  return typeof value === "string"
    ? value
    : value === undefined
      ? "null"
      : JSON.stringify(value);
}
