import { describe, expect, it } from "vitest";
import { createUiCommands, executeUiCommand, matchUiCommands } from "./uiCommands";
describe("UI commands", () => {
  it("lists disabled reasons and never executes blocked actions", () => {
    let calls = 0;
    const commands = createUiCommands({ profile: () => calls++, style: () => calls++, fit: () => calls++, analysis: () => calls++, blockedReason: "busy" });
    expect(commands.every(command => !executeUiCommand(command))).toBe(true);
    expect(calls).toBe(0);
    expect(new Set(commands.map(c => c.id)).size).toBe(commands.length);
  });
  it("finds canonical labels, translated names and stable tool identifiers", () => {
    const commands = createUiCommands({ profile: () => {}, style: () => {}, fit: () => {}, analysis: () => {} });
    expect(matchUiCommands(commands, "buffer", s => s).map(c => c.id)).toEqual(["analysis.buffer"]);
    expect(matchUiCommands(commands, "FIELD overview", s => s === "字段概览" ? "Field overview" : s).map(c => c.id)).toEqual(["layer.profile"]);
    expect(matchUiCommands(commands, "不存在的工具", s => s)).toEqual([]);
    expect(commands.find(c => c.id === "layer.style")?.disabledReason).toBeTruthy();
  });
});
