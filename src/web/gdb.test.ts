import { describe, expect, it } from "vitest";
import { prepareBrowserGdbFiles } from "./gdb";
const file = (path: string, text = "GDB bytes") => {
  const item = new File([text], path.split("/").at(-1)!);
  Object.defineProperty(item, "webkitRelativePath", { value: path });
  return item;
};
describe("browser GDB source inputs", () => {
  it("preserves a Unicode GDB folder and identifies file contents regardless of input order", async () => {
    const files = [file("调查.gdb/a.gdbtable"), file("调查.gdb/b.gdbtablx")];
    const first = await prepareBrowserGdbFiles(files, false);
    const second = await prepareBrowserGdbFiles([...files].reverse(), false);
    expect(first.path).toBe("调查.gdb");
    expect(first.files).toHaveLength(2);
    expect(first.fingerprint).toBe(second.fingerprint);
    const changed = await prepareBrowserGdbFiles(
      [files[0], file("调查.gdb/b.gdbtablx", "changed")],
      false,
    );
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
  it("accepts one GDB ZIP and ignores transient directory lock files", async () => {
    expect(
      (
        await prepareBrowserGdbFiles(
          [new File(["zip"], "sample.gdb.zip")],
          true,
        )
      ).path,
    ).toBe("sample.gdb.zip");
    const result = await prepareBrowserGdbFiles(
      [file("a.gdb/a.gdbtable"), file("a.gdb/session.lock")],
      false,
    );
    expect(result.files).toHaveLength(1);
  });
  it("rejects traversal, ambiguous roots, duplicate paths, ordinary ZIPs and total size overflow", async () => {
    for (const entries of [
      [file("a.gdb/../b")],
      [file("a.gdb/a"), file("b.gdb/b")],
      [file("a.gdb/a"), file("a.gdb/a")],
    ])
      await expect(prepareBrowserGdbFiles(entries, false)).rejects.toThrow(
        "PATH_INVALID",
      );
    await expect(
      prepareBrowserGdbFiles([new File(["x"], "shapes.zip")], true),
    ).rejects.toThrow("PATH_INVALID");
    const big = file("a.gdb/a");
    Object.defineProperty(big, "size", { value: 100 * 1024 * 1024 + 1 });
    await expect(prepareBrowserGdbFiles([big], false)).rejects.toThrow("LIMIT");
  });
});
