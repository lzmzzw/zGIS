import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";

const han = (value) => /\p{Script=Han}/u.test(value);
const normalize = (value) => value.replace(/\{(?:\d+|[a-zA-Z_]\w*)\}/g, "{}");
const normalizeText = (value) => value.split(/\r?\n/).map((line, index, lines) => {
  let result = line.replace(/\t/g, " ");
  if (index) result = result.trimStart();
  if (index < lines.length - 1) result = result.trimEnd();
  return result;
}).filter(Boolean).join(" ");
function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "tokens", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, [...ancestors, node]));
    else if (value?.type) walk(value, visit, [...ancestors, node]);
  }
}
const dictionary = new Map();
const errors = [];
for (const file of ["app", "shared", "web", "errors", "display"]) {
  walk(parse(fs.readFileSync(`src/i18n/${file}.ts`, "utf8"), { sourceType: "module", plugins: ["typescript"] }), (node) => {
    if (node.type === "TemplateLiteral" && node.quasis.length === 1 && node.quasis[0].value.raw.includes("|")) {
      for (const row of node.quasis[0].value.raw.trim().split(/\r?\n/)) {
        const separator = row.indexOf("|");
        if (separator < 0) continue;
        const source = row.slice(0, separator);
        const target = row.slice(separator + 1);
        if (!target || han(target)) errors.push(`${file}: invalid English translation for ${source}`);
        dictionary.set(normalize(source), target);
      }
    }
    if (node.type !== "ObjectProperty" || !["StringLiteral", "Identifier"].includes(node.key.type) || node.value.type !== "StringLiteral") return;
    const source = node.key.type === "Identifier" ? node.key.name : node.key.value;
    const target = node.value.value;
    if (!target || han(target)) errors.push(`${file}: invalid English translation for ${source}`);
    const placeholders = (value) => [...value.matchAll(/\{(?:\d+|[a-zA-Z_]\w*)\}/g)].map((m) => m[0]).sort().join(",");
    if (placeholders(source) !== placeholders(target)) errors.push(`${file}: interpolation mismatch for ${source}`);
    dictionary.set(normalize(source), target);
  });
}
const intentional = new Set(["中文"]); // Native language names stay recognizable in either locale.
const dataLiterals = new Map([
  ["src/domain/index.ts", new Set(["经度", "纬度", "-二维副本.geojson"])],
  ["src/workers/parser.worker.ts", new Set(["经度", "纬度"])],
]); // CSV column detection and generated data filenames are not interface messages.
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" || entry.name === "wasm" ? [] : files(file);
    return /\.tsx?$/.test(file) && !/\.test\.|\.d\.ts$/.test(file) ? [file] : [];
  });
}
for (const file of files("src")) {
  const tree = parse(fs.readFileSync(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"] });
  walk(tree, (node, ancestors) => {
    if (node.type === "JSXAttribute" && node.name.name === "key" && node.value?.type === "JSXExpressionContainer") {
      walk(node.value.expression, (part) => {
        if (part.type === "CallExpression" && ["t", "translate"].includes(part.callee?.name)) errors.push(`${file}:${part.loc.start.line}: translated React key`);
      });
    }
    if (node.type === "JSXExpressionContainer" && ancestors.at(-1)?.type !== "JSXAttribute") {
      const expression = node.expression;
      const name = expression.type === "Identifier" ? expression.name : expression.type === "MemberExpression" && !expression.computed ? expression.property.name : "";
      if (/^(error|status|warning|previewError|testStatus|draftError|description|help)$/.test(name)) errors.push(`${file}:${node.loc.start.line}: dynamic UI message must be localized (${name})`);
    }
    let source;
    if (node.type === "StringLiteral") source = node.value;
    if (node.type === "JSXText") source = normalizeText(node.value);
    if (node.type === "TemplateLiteral") source = node.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) + (i < node.expressions.length ? `{${i}}` : "")).join("");
    if (!source || !han(source) || intentional.has(source) || dataLiterals.get(file.replaceAll("\\", "/"))?.has(source)) return;
    const location = `${file}:${node.loc.start.line}`;
    if (!dictionary.has(normalize(source))) errors.push(`${location}: missing translation ${JSON.stringify(source)}`);
    if (node.type === "JSXText") errors.push(`${location}: untranslated JSX text`);
    if (ancestors.at(-1)?.type === "JSXAttribute") errors.push(`${location}: untranslated JSX attribute`);
  });
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`i18n coverage passed: ${dictionary.size} canonical messages, both clients`);
