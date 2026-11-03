import { expect, it } from "vitest";
import { importCsv } from "../domain";
import { csvPreviewInput, MAX_CSV_PREVIEW_BYTES } from "./csvPreview";

const encoder = new TextEncoder();
const decode = (bytes: number[] | Uint8Array) => new TextDecoder().decode(new Uint8Array(bytes));

it("只传输表头及五条完整记录，保留引号、多行、空行与 UTF-8", () => {
  const head = 'x,y,note\r\n\r\n1,2,"中文\r\n多行"\r\n1,2,"a""b"\r\n1,2,3\r\n1,2,4\r\n1,2,5\r\n';
  const bytes = encoder.encode(head + "broken,row\n".repeat(100_000));
  const sample = csvPreviewInput({ name: "large.csv", bytes });
  expect(decode(sample.file.bytes)).toBe(head);
  expect(sample.file.bytes.length).toBeLessThan(200);
  expect(importCsv(decode(sample.file.bytes))).toHaveLength(5);
  expect(sample.limited).toBe(false);
  expect(() => importCsv(decode(bytes))).toThrow("CSV 第");
  expect(bytes.byteLength).toBeGreaterThan(1_000_000);
});

it("采样预算不会把截断的多行记录伪装成完整预览，也不改变完整导入", () => {
  const head = "x,y,note\n1,2,ok\n";
  const text = head + '1,2,"' + "a".repeat(MAX_CSV_PREVIEW_BYTES) + '"\n';
  const sample = csvPreviewInput({ name: "large.csv", bytes: encoder.encode(text) });
  expect(decode(sample.file.bytes)).toBe(head);
  expect(sample.limited).toBe(true);
  expect(importCsv(decode(sample.file.bytes))).toHaveLength(1);
  const complete = importCsv(text);
  expect(complete).toHaveLength(2);
  expect(complete[1].properties.note).toHaveLength(MAX_CSV_PREVIEW_BYTES);
});

it("小文件的结尾记录及错误保持原样，不静默删除", () => {
  for (const text of ['x,y\n1,2', 'x,y\n"1,2']) {
    const bytes = encoder.encode(text);
    expect(csvPreviewInput({ name: "small.csv", bytes }).file.bytes).toBe(bytes);
  }
  expect(() => importCsv('x,y\n"1,2')).toThrow("CSV 第");
});

it("GB18030 中文字节不会被当成 CSV 结构字符", () => {
  const header = encoder.encode("x,y,note\n");
  const row = new Uint8Array([...encoder.encode("1,2,"), 0xd6, 0xd0, 0xce, 0xc4, 10]);
  const bytes = new Uint8Array(header.length + row.length * 8);
  bytes.set(header);
  for (let i = 0; i < 8; i++) bytes.set(row, header.length + row.length * i);
  const sample = csvPreviewInput({ name: "gbk.csv", bytes });
  expect(new TextDecoder("gb18030").decode(new Uint8Array(sample.file.bytes))).toBe("x,y,note\n" + "1,2,中文\n".repeat(5));
});
