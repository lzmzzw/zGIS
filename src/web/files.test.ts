import { expect, it, vi } from "vitest";
import { MAX_IMPORT_BYTES, readBrowserFiles } from "./files";

function file(name: string, size: number, read: () => Promise<ArrayBuffer>): File {
  return { name, size, arrayBuffer: vi.fn(read) } as unknown as File;
}

it("读取前拒绝超限文件且不分配文件缓冲区", async () => {
  const input = file("large.geojson", MAX_IMPORT_BYTES + 1, async () => new ArrayBuffer(0));
  await expect(readBrowserFiles([input])).rejects.toThrow("100 MB");
  expect(input.arrayBuffer).not.toHaveBeenCalled();
});

it("多文件顺序读取，不同时请求多个浏览器大缓冲区", async () => {
  let release: (buffer: ArrayBuffer) => void = () => {};
  const first = file("first.csv", 1, () => new Promise(resolve => { release = resolve; }));
  const second = file("second.csv", 1, async () => new Uint8Array([2]).buffer);
  const read = readBrowserFiles([first, second]);
  expect(first.arrayBuffer).toHaveBeenCalledOnce();
  expect(second.arrayBuffer).not.toHaveBeenCalled();
  release(new Uint8Array([1]).buffer);
  const result = await read;
  expect(second.arrayBuffer).toHaveBeenCalledOnce();
  expect(result.map(item => Array.from(item.bytes))).toEqual([[1], [2]]);
});

it("实际读取超过声明的文件大小时拒绝继续加载", async () => {
  const input = file("changed.csv", 0, async () => new Uint8Array([1]).buffer);
  await expect(readBrowserFiles([input])).rejects.toThrow("100 MB");
});
