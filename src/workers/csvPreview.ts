import type { InputFile } from "../domain";

export const MAX_CSV_PREVIEW_BYTES = 8 * 1024 * 1024;

/** UTF-8/GB18030 的 CSV 结构字符均为单字节；只复制表头和前五个完整记录。 */
export function csvPreviewInput(file: InputFile): { file: InputFile; limited: boolean } {
  const bytes = file.bytes;
  const limit = Math.min(bytes.length, MAX_CSV_PREVIEW_BYTES);
  let quoted = false;
  let records = 0;
  let hasValue = false;
  let boundary = 0;
  const prefix = (end: number) => bytes instanceof Uint8Array ? bytes.subarray(0, end) : bytes.slice(0, end);
  for (let index = 0; index < limit; index++) {
    const byte = bytes[index];
    if (byte === 34) {
      if (quoted && bytes[index + 1] === 34) {
        hasValue = true;
        index++;
      }
      else quoted = !quoted;
    } else if (!quoted && (byte === 10 || byte === 13)) {
      if (byte === 13 && bytes[index + 1] === 10 && index + 1 < limit) index++;
      boundary = index + 1;
      if (hasValue) records++;
      hasValue = false;
      if (records === 6) return { file: { ...file, bytes: prefix(boundary) }, limited: false };
    } else if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32 && byte !== 44 && byte !== 59) {
      hasValue = true;
    }
  }
  if (bytes.length <= limit) return { file, limited: false };
  if (!boundary) throw new Error("CSV 表头或首条记录超过 8 MiB，无法生成预览");
  return { file: { ...file, bytes: prefix(boundary) }, limited: true };
}
