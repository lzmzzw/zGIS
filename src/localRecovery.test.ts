import { expect, it, vi } from "vitest";
import { MAX_LOCAL_RECOVERY_CHARS, writeRecoveryJournal } from "./recoveryWriter";

it("大恢复快照在触发DOMStorage前跳过，保留已有日志", () => {
  const storage = { setItem: vi.fn() };
  expect(writeRecoveryJournal("x".repeat(MAX_LOCAL_RECOVERY_CHARS + 1), storage)).toBe(false);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(writeRecoveryJournal('{"layers":[]}', storage)).toBe(true);
  expect(storage.setItem).toHaveBeenCalledWith("zgis.editRecovery", '{"layers":[]}');
});

it("浏览器存储满时仍允许调用方继续原生备份", () => {
  expect(writeRecoveryJournal("{}", { setItem: () => { throw new Error("quota"); } })).toBe(false);
});
