import { expect, it, vi } from "vitest";
import { LosslessNumber, parse } from "lossless-json";
import { parseJsonLosslessly } from "./losslessJson";

it.each([
  "null", "true", "false", "0", "-0", "123456789012345678901234567890", "1.12345678901234567890123456789", "-12.50e+002", "1e400", "1e-9999",
  '""', '"汉字 🙂 \\uD83D\\uDE42 \\uD800"', '"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u0000"',
  "[]", "{}", ' \r\n\t {"a":[1,null,true,false,{"nested":"value"}],"b":-1.20e-30} \r\n\t',
  '{"key":1,"key":1}', '{"key":null,"key":null}', '{"key":{"a":[1,2],"b":true},"key":{"b":true,"a":[1,2]}}',
  '{"a":[1],"a":{"0":1}}', '{"a":1,"a":{"isLosslessNumber":true,"value":"1"}}',
])("与既有解析器保持合法输入及相同重复键语义：%s", text => {
  expect(parseJsonLosslessly(text)).toEqual(parse(text));
});

it.each([
  "", " ", "undefined", "NaN", "Infinity", "-Infinity", "+1", ".5", "-.5", "01", "-01", "1.", "1e", "1e+", "--1", "0x10", "1 2", "truefalse", "nullx",
  "[", "[1", "[1,]", "[,1]", "[1,,2]", "[1 2]", "{", "{\"a\":}", "{\"a\":1", "{\"a\":1,}", "{a:1}", "{\"a\" 1}",
  '"unterminated', '"\\q"', '"\\u12"', '"\\uZZZZ"', '"\\u12x4"', '"raw\nnewline"', '"raw\u0000control"', '"ending\\',
  "\uFEFF{}", "\u00A0{}", "\v{}", "{}tail", "[true]//comment", "/*comment*/{}",
  '{"key":1,"key":1.0}', '{"key":true,"key":false}', '{"key":[],"key":[null]}', '{"key":{"a":1},"key":{"a":2}}', '{"a":1,"\\u0061":2}',
])("拒绝非法或冲突输入且错误不回显原文：%s", text => {
  expect(() => parse(text)).toThrow();
  expect(() => parseJsonLosslessly(text)).toThrow(SyntaxError);
});

it("数字返回既有 LosslessNumber，保留符号、精度与指数原文", () => {
  const texts = ["-0", "9007199254740993", "1.123456789012345678901", "1E+0400", "1e-9999"];
  const result = parseJsonLosslessly(`[${texts.join(",")}]`) as LosslessNumber[];
  expect(result.every(item => item instanceof LosslessNumber)).toBe(true);
  expect(result.map(item => item.value)).toEqual(texts);
});

it("__proto__、constructor 和 prototype 均为自有数据属性，不改变对象原型", () => {
  const result = parseJsonLosslessly('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":"data"}') as Record<string, unknown>;
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.keys(result)).toEqual(["__proto__", "constructor", "prototype"]);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(Object.hasOwn(result, "constructor")).toBe(true);
  expect(result.__proto__).toEqual({ polluted: true });
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(() => parseJsonLosslessly('{"__proto__":{"a":1},"__proto__":{"a":2}}')).toThrow("Conflicting duplicate");
  expect(() => parseJsonLosslessly('{"constructor":1,"constructor":2}')).toThrow("Conflicting duplicate");
});

it("容器深度有界，边界内有效，超限统一报错而非堆栈溢出", () => {
  expect(() => parseJsonLosslessly("[".repeat(256) + "0" + "]".repeat(256))).not.toThrow();
  expect(() => parseJsonLosslessly("[".repeat(257) + "0" + "]".repeat(257))).toThrow("depth exceeds 256");
  expect(() => parseJsonLosslessly('{"a":'.repeat(257) + "0" + "}".repeat(257))).toThrow("depth exceeds 256");
});

it("大字符串整体交给原生 JSON.parse 解码，不逐字符拼接，数字仍精确", () => {
  const payload = "x".repeat(12 * 1024 * 1024) + "汉字🙂";
  const nativeParse = vi.spyOn(JSON, "parse");
  try {
    const result = parseJsonLosslessly('{"payload":"' + payload + '","number":9007199254740993}') as { payload: string; number: LosslessNumber };
    expect(result.payload.length).toBe(payload.length);
    expect(result.payload === payload).toBe(true);
    expect(result.number.value).toBe("9007199254740993");
    const largeTokens = nativeParse.mock.calls.filter(([token]) => typeof token === "string" && token.length > 10 * 1024 * 1024);
    expect(largeTokens).toHaveLength(1);
    expect(largeTokens[0][0].length).toBe(payload.length + 2);
    expect(largeTokens[0][0][0]).toBe('"');
    expect(largeTokens[0][0].at(-1)).toBe('"');
  } finally {
    nativeParse.mockRestore();
  }
});

it("错误消息只含简短原因与位置，不暴露大字符串或重复键名称", () => {
  const secret = "sensitive-marker-" + "x".repeat(100_000);
  for (const text of ['{"' + secret + '":1,"' + secret + '":2}', '"' + secret + '\\q"']) {
    try {
      parseJsonLosslessly(text);
      throw new Error("Expected invalid input");
    } catch (error) {
      expect(error).toBeInstanceOf(SyntaxError);
      expect((error as Error).message.length).toBeLessThan(100);
      expect((error as Error).message).not.toContain("sensitive-marker");
    }
  }
});

it("确定性生成嵌套文档并与既有解析器逐项对照", () => {
  let seed = 0x43534947;
  const next = (range: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % range;
  };
  const strings = ["", "中文🙂", 'quote"slash\\', "\n\r\t\b\f\u0000", "\ud800", "\udfff", "\u2028\u2029", "constructor", "toString"];
  const generate = (depth: number): unknown => {
    const type = next(depth < 4 ? 6 : 4);
    if (type === 0) return null;
    if (type === 1) return Boolean(next(2));
    if (type === 2) return (next(2_000_000) - 1_000_000) / 1000;
    if (type === 3) return strings[next(strings.length)];
    if (type === 4) return Array.from({ length: next(5) }, () => generate(depth + 1));
    return Object.fromEntries(Array.from({ length: next(5) }, (_, index) => [strings[next(strings.length)] + index, generate(depth + 1)]));
  };
  for (let index = 0; index < 1000; index++) {
    const text = JSON.stringify(generate(0));
    expect(parseJsonLosslessly(text)).toEqual(parse(text));
  }
});

it("全部未转义控制字符拒绝，转义后的同一字符可正常往返", () => {
  for (let code = 0; code < 32; code++) {
    const character = String.fromCharCode(code);
    expect(() => parseJsonLosslessly('"' + character + '"')).toThrow(SyntaxError);
    expect(parseJsonLosslessly(JSON.stringify(character))).toBe(character);
  }
});
