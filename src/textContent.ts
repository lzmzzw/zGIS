/** 可重放的文本源；仅保留文档引用，不缓存完整输出。文档遵守不可变更新约定。 */
export interface TextContent {
  chunks(): Iterable<string>;
}
export type TextInput = string | TextContent;
export const TEXT_CHUNK_CHARS = 256 * 1024;

/** 合并小片段并拆分大记录；代理对跨输入片段时也保持在同一输出片。 */
export function* textChunks(input: TextInput, limit = TEXT_CHUNK_CHARS): Generator<string> {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("Invalid text chunk limit");
  const source = typeof input === "string" ? [input] : input.chunks();
  let pieces: string[] = [], length = 0, high = "";
  for (const value of source) {
    const part = high + value;
    high = "";
    let end = part.length;
    const tail = part.charCodeAt(end - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) { high = part.slice(-1); end--; }
    for (let start = 0; start < end;) {
      let next = Math.min(start + limit - length, end);
      const last = part.charCodeAt(next - 1), after = part.charCodeAt(next);
      if (next < end && last >= 0xd800 && last <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) next--;
      if (next > start) {
        pieces.push(part.slice(start, next));
        length += next - start;
        start = next;
      }
      if (length >= limit - 1) {
        yield pieces.join(""); pieces = []; length = 0;
      }
    }
  }
  if (high) { pieces.push(high); length++; }
  if (length) yield pieces.join("");
}

/** 超出小日志预算立即停止遍历，不先物化整个大工作区。 */
export function smallText(input: TextInput, maxCharacters: number): string | undefined {
  if (typeof input === "string") return input.length <= maxCharacters ? input : undefined;
  const pieces: string[] = [];
  let length = 0;
  for (const part of textChunks(input)) {
    length += part.length;
    if (length > maxCharacters) return undefined;
    pieces.push(part);
  }
  return pieces.join("");
}

export function collectText(input: TextInput): string {
  return typeof input === "string" ? input : [...input.chunks()].join("");
}
