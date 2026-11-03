import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
import { invoke } from "@tauri-apps/api/core";
import { api, readNativeFiles } from "./bridge";
import { MAX_DESKTOP_FILE_BYTES } from "./fileLimits";

beforeEach(() => vi.mocked(invoke).mockReset());
it("元数据入口逐个读取原生二进制缓冲区并保留来源", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(new Uint8Array([1, 2]).buffer).mockResolvedValueOnce(new Uint8Array([3]).buffer);
  const files = await readNativeFiles([{ name: "a.csv", size: 2, sourceId: "a", sourceHash: "hash" }, { name: "b.csv", size: 1, sourceId: "b" }]);
  expect(invoke).toHaveBeenNthCalledWith(1, "read_open_file", { sourceId: "a" });
  expect(invoke).toHaveBeenNthCalledWith(2, "read_open_file", { sourceId: "b" });
  expect(files[0].bytes).toBeInstanceOf(Uint8Array);
  expect(files[0].sourceHash).toBe("hash");
  expect([...files[1].bytes]).toEqual([3]);
});
it("读取前拒绝超批次预算，读取后拒绝变化文件", async () => {
  await expect(readNativeFiles([{ name: "a", size: MAX_DESKTOP_FILE_BYTES }, { name: "b", size: 1 }])).rejects.toThrow("256 MiB");
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(new Uint8Array([1]).buffer);
  await expect(readNativeFiles([{ name: "a", size: 2, sourceId: "a" }])).rejects.toThrow("发生变化");
});
it("恢复备份使用UTF-8二进制IPC并保留中文及转义内容", async () => {
  const content = JSON.stringify({ note: '中文\\"', value: 9007199254740991 });
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await api.backup(content);
  expect(invoke).toHaveBeenCalledWith("save_recovery", new TextEncoder().encode(content));
  vi.mocked(invoke).mockResolvedValueOnce(new TextEncoder().encode(content).buffer);
  expect(await api.recover()).toBe(content);
  vi.mocked(invoke).mockResolvedValueOnce(new ArrayBuffer(0));
  expect(await api.recover()).toBeNull();
  vi.mocked(invoke).mockResolvedValueOnce(new Uint8Array([0xff]).buffer);
  await expect(api.recover()).rejects.toThrow();
  vi.mocked(invoke).mockResolvedValueOnce([...new TextEncoder().encode(content)]);
  expect(await api.recover()).toBe(content);
  vi.mocked(invoke).mockResolvedValueOnce([256]);
  await expect(api.recover()).rejects.toThrow("结构无效");
  vi.mocked(invoke).mockResolvedValueOnce({});
  await expect(api.recover()).rejects.toThrow("结构无效");
});
it("大恢复快照顺序分片，UTF-16边界的emoji保持完整且只有末片提交", async () => {
  const content = JSON.stringify({ note: "x".repeat(256 * 1024 - 10) + "😀结束" });
  vi.mocked(invoke).mockResolvedValue(undefined);
  await api.backup(content);
  const calls = vi.mocked(invoke).mock.calls;
  expect(calls).toHaveLength(2);
  const decoded = calls.map(([, bytes]) => {
    expect((bytes as Uint8Array).length).toBeLessThanOrEqual(1024 * 1024);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes as Uint8Array);
  }).join("");
  expect(decoded).toBe(content);
  const first = calls[0][2]?.headers as Record<string, string>;
  const last = calls[1][2]?.headers as Record<string, string>;
  expect(first["x-zgis-recovery-id"]).toBe(last["x-zgis-recovery-id"]);
  expect(first["x-zgis-recovery-part"]).toBe("0");
  expect(first["x-zgis-recovery-final"]).toBe("false");
  expect(last["x-zgis-recovery-part"]).toBe("1");
  expect(last["x-zgis-recovery-final"]).toBe("true");
});
it("恢复传输失败后停止发送后续片段", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("transport"));
  await expect(api.backup("x".repeat(3 * 256 * 1024))).rejects.toThrow("transport");
  expect(invoke).toHaveBeenCalledTimes(2);
});
it("大文件保存先传完整正文，再以小请求提交来源指纹和保存选项", async () => {
  const content = "字段,值\n" + "记录,中文😀\n".repeat(40_000);
  vi.mocked(invoke).mockResolvedValue(null);
  await api.save(content, "output.csv", "source", undefined, "hash", true);
  const calls = vi.mocked(invoke).mock.calls;
  const chunks = calls.slice(0, -1);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(([command]) => command === "stage_file_content")).toBe(true);
  expect(chunks.map(([, bytes]) => new TextDecoder("utf-8", { fatal: true }).decode(bytes as Uint8Array)).join("")).toBe(content);
  expect(calls.at(-1)).toEqual(["save_file", expect.objectContaining({ content: null, transferId: expect.any(String), sourceId: "source", sourceHash: "hash", overwrite: true })]);
});
it("文本源按有界批次生成，等待原生确认且失败时关闭生成器", async () => {
  let generated = 0, closed = false;
  const source = { *chunks() { try { for (let i = 0; i < 20; i++) { generated++; yield "x".repeat(256 * 1024); } } finally { closed = true; } } };
  let release!: () => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  const pending = api.backup(source);
  expect(generated).toBe(2);
  expect(invoke).toHaveBeenCalledTimes(1);
  release();
  await expect(pending).rejects.toThrow("disk full");
  expect(generated).toBeLessThanOrEqual(3);
  expect(closed).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
});
