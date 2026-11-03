import { LosslessNumber } from "lossless-json";

const MAX_CONTAINER_DEPTH = 256;

/** 精确保留数值字面量；字符串由原生解析器一次解码，避免逐字符拼接形成 rope。 */
export function parseJsonLosslessly(text: string): unknown {
  if (typeof text !== "string") throw new TypeError("JSON input must be a string");
  let position = 0;
  const length = text.length;

  function fail(reason: string, at = position): never {
    // 不回显 token、键名或原始片段，原生 JSON.parse 的错误也统一转换。
    throw new SyntaxError(`${reason} at position ${at}`);
  }

  function whitespace(): void {
    while (position < length) {
      const code = text.charCodeAt(position);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      position++;
    }
  }

  function string(): string {
    const start = position++;
    while (position < length) {
      const code = text.charCodeAt(position);
      if (code === 34) {
        position++;
        try {
          return JSON.parse(text.slice(start, position)) as string;
        } catch {
          fail("Invalid JSON string", start);
        }
      }
      if (code < 32) fail("Unescaped control character in JSON string");
      if (code !== 92) {
        position++;
        continue;
      }
      position++;
      const escaped = text.charCodeAt(position);
      if (escaped === 117) {
        for (let offset = 1; offset <= 4; offset++) {
          const hex = text.charCodeAt(position + offset);
          if (!(hex >= 48 && hex <= 57) && !(hex >= 65 && hex <= 70) && !(hex >= 97 && hex <= 102))
            fail("Invalid Unicode escape in JSON string");
        }
        position += 5;
      } else if (escaped === 34 || escaped === 92 || escaped === 47 || escaped === 98 || escaped === 102 || escaped === 110 || escaped === 114 || escaped === 116) {
        position++;
      } else {
        fail("Invalid escape in JSON string");
      }
    }
    fail("Unterminated JSON string", start);
  }

  function digit(): boolean {
    const code = text.charCodeAt(position);
    return code >= 48 && code <= 57;
  }

  function number(): LosslessNumber {
    const start = position;
    if (text.charCodeAt(position) === 45) position++;
    if (text.charCodeAt(position) === 48) {
      position++;
      if (digit()) fail("Leading zero in JSON number");
    } else {
      if (!digit()) fail("Digit expected in JSON number");
      while (digit()) position++;
    }
    if (text.charCodeAt(position) === 46) {
      position++;
      if (!digit()) fail("Digit expected after JSON decimal point");
      while (digit()) position++;
    }
    const exponent = text.charCodeAt(position);
    if (exponent === 101 || exponent === 69) {
      position++;
      const sign = text.charCodeAt(position);
      if (sign === 43 || sign === 45) position++;
      if (!digit()) fail("Digit expected in JSON exponent");
      while (digit()) position++;
    }
    try {
      return new LosslessNumber(text.slice(start, position));
    } catch {
      fail("Invalid JSON number", start);
    }
  }

  function object(depth: number): Record<string, unknown> {
    position++;
    whitespace();
    const result: Record<string, unknown> = {};
    if (text.charCodeAt(position) === 125) {
      position++;
      return result;
    }
    while (position < length) {
      if (text.charCodeAt(position) !== 34) fail("Quoted JSON object key expected");
      const keyPosition = position;
      const key = string();
      whitespace();
      if (text.charCodeAt(position) !== 58) fail("Colon expected after JSON object key");
      position++;
      const item = value(depth);
      if (Object.hasOwn(result, key) && !sameValue(result[key], item))
        fail("Conflicting duplicate JSON key", keyPosition);
      if (key === "__proto__") {
        Object.defineProperty(result, key, { value: item, enumerable: true, writable: true, configurable: true });
      } else {
        result[key] = item;
      }
      whitespace();
      const separator = text.charCodeAt(position++);
      if (separator === 125) return result;
      if (separator !== 44) fail("Comma or closing brace expected in JSON object", position - 1);
      whitespace();
    }
    fail("Unterminated JSON object");
  }

  function array(depth: number): unknown[] {
    position++;
    whitespace();
    const result: unknown[] = [];
    if (text.charCodeAt(position) === 93) {
      position++;
      return result;
    }
    while (position < length) {
      result.push(value(depth));
      whitespace();
      const separator = text.charCodeAt(position++);
      if (separator === 93) return result;
      if (separator !== 44) fail("Comma or closing bracket expected in JSON array", position - 1);
      whitespace();
    }
    fail("Unterminated JSON array");
  }

  function value(depth: number): unknown {
    whitespace();
    const code = text.charCodeAt(position);
    if (code === 34) return string();
    if (code === 45 || (code >= 48 && code <= 57)) return number();
    if (code === 123 || code === 91) {
      if (depth >= MAX_CONTAINER_DEPTH) fail("JSON nesting depth exceeds 256");
      return code === 123 ? object(depth + 1) : array(depth + 1);
    }
    if (code === 116 && text.startsWith("true", position)) {
      position += 4;
      return true;
    }
    if (code === 102 && text.startsWith("false", position)) {
      position += 5;
      return false;
    }
    if (code === 110 && text.startsWith("null", position)) {
      position += 4;
      return null;
    }
    fail("JSON value expected");
  }

  const result = value(0);
  whitespace();
  if (position !== length) fail("Unexpected content after JSON value");
  return result;
}

/** 沿用 lossless-json 的重复键结构比较，LosslessNumber 的原始字面量也参与比较。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const keys = Object.keys(leftObject);
    return keys.length === Object.keys(rightObject).length
      && keys.every(key => Object.hasOwn(rightObject, key) && sameValue(leftObject[key], rightObject[key]));
  }
  return false;
}
