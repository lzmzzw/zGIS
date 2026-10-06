import { describe, expect, it } from "vitest";
import { parseCellValue } from "./attributeEditing";

describe("attribute cell values", () => {
  it("preserves string codes and distinguishes empty text from NULL", () => {
    expect(parseCellValue("00123", "001")).toBe("00123");
    expect(parseCellValue("", "name")).toBe("");
    expect(parseCellValue("null", "name")).toBe("null");
    expect(parseCellValue("ignored", "name", true)).toBeNull();
  });
  it("rejects numeric coercion and precision loss", () => {
    expect(parseCellValue("2.5", 1)).toBe(2.5);
    for (const text of [
      "",
      "NaN",
      "Infinity",
      "0x10",
      '"2"',
      "true",
      "9007199254740993",
      "1.0000000000000001",
      '1,"extra":2',
    ])
      expect(() => parseCellValue(text, 1)).toThrow();
  });
  it("preserves boolean and structured field types", () => {
    expect(parseCellValue("false", true)).toBe(false);
    expect(() => parseCellValue('"false"', true)).toThrow();
    expect(parseCellValue('{"code":9007199254740993}', {})).toEqual({
      code: "9007199254740993",
    });
    expect(parseCellValue("[1,2]", [])).toEqual([1, 2]);
    expect(() => parseCellValue("[]", {})).toThrow();
    expect(() => parseCellValue("{}", [])).toThrow();
    expect(parseCellValue('"001"', null)).toBe("001");
    expect(parseCellValue("null", undefined)).toBeNull();
  });
});
