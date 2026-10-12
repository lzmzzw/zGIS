import { afterEach, describe, expect, it } from "vitest";
import { messages, setLocale, getLocale, t, translate } from "./index";

afterEach(() => setLocale("zh-CN"));
describe("locale rendering", () => {
  it("has English messages and preserves interpolation placeholders", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\d+|[a-zA-Z_]\w*)\}/g)].map(m => m[1]).sort();
    for (const [source, target] of Object.entries(messages)) {
      expect(target, source).not.toMatch(/\p{Script=Han}/u);
      expect(placeholders(target), source).toEqual(placeholders(source));
    }
  });
  it("switches stored messages without changing opaque names", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("上移 中文业务图层")).toBe("Move 中文业务图层 up");
    expect(t("属性 数值")).toBe("Attributes 数值");
    expect(t("正在运行缓冲区…")).toBe("Running Buffer…");
    const original = "已导入 2 个图层，7 个要素";
    expect(t(original)).toBe("Imported 2 layers with 7 features");
    setLocale("zh-CN");
    expect(t(original)).toBe(original);
    expect(t("snapshot write failed")).toBe("snapshot write failed");
    expect(t("导入文件")).toBe("导入文件");
  });
  it("translates nested diagnostics and preserves unrecognized external messages", () => {
    expect(translate("恢复副本保存失败：要素 3: 无效几何", "en")).toBe("Failed to save recovery copy: Feature 3: Invalid geometry");
    expect(translate("external write failed", "zh-CN")).toBe("external write failed");
    expect(translate("恢复副本保存失败：Invalid geometry", "zh-CN")).toBe("恢复副本保存失败：无效几何");
    expect(translate("XYZ 地址须为 HTTP(S)，并包含 {z}、{x}、{y}。", "en")).toContain("{z}, {x} and {y}");
  });
});
