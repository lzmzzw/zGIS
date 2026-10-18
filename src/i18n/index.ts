import display from "./display";
import { useSyncExternalStore } from "react";
import app from "./app";
import shared from "./shared";
import web from "./web";
import errors from "./errors";
import { analysisTools } from "../analysisTools";

export type Locale = "zh-CN" | "en";
export const languageStorageKey = "zgis.locale";
export const messages: Record<string, string> = { ...errors, ...shared, ...app, ...web, ...display };
const listeners = new Set<() => void>();
function readLocale(): Locale {
  try { return localStorage.getItem(languageStorageKey) === "en" ? "en" : "zh-CN"; }
  catch { return "zh-CN"; }
}
let locale: Locale = readLocale();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Pattern = { regex: RegExp; source: string; target: string; names: string[]; specificity: number };
function pattern(source: string, target: string): Pattern | undefined {
  const names: string[] = [];
  const expression = source.split(/(\{(?:\d+|[a-zA-Z_]\w*)\})/g).map((part) => {
    if (/^\{(?:\d+|[a-zA-Z_]\w*)\}$/.test(part)) {
      names.push(part.slice(1, -1));
      return "([\\s\\S]*?)";
    }
    return escape(part);
  }).join("");
  const specificity = source.replace(/\{(?:\d+|[a-zA-Z_]\w*)\}/g, "").length;
  return names.length ? { regex: new RegExp(`^${expression}$`), source, target, names, specificity } : undefined;
}
const reverse = new Map(Object.entries(messages).map(([zh, en]) => [en, zh]));
const toolNames = new Set(analysisTools.flatMap((tool) => [tool.label, messages[tool.label]]));
const englishPatterns = Object.entries(messages).map(([zh, en]) => pattern(zh, en)).filter((p): p is Pattern => !!p);
const chinesePatterns = Object.entries(messages).map(([zh, en]) => pattern(en, zh)).filter((p): p is Pattern => !!p);
// Prefer specific templates over broad diagnostic prefixes.
const bySpecificity = (a: Pattern, b: Pattern) => b.specificity - a.specificity ||
  b.names.filter((name) => /^(error|message|reason|detail|tool)$/.test(name)).length -
  a.names.filter((name) => /^(error|message|reason|detail|tool)$/.test(name)).length;
englishPatterns.sort(bySpecificity);
chinesePatterns.sort(bySpecificity);

export function translate(source: string, targetLocale: Locale, depth = 0): string {
  if (!source || depth > 8) return source;
  if (targetLocale === "zh-CN" && messages[source] !== undefined) return source;
  const exact = targetLocale === "en" ? messages[source] : reverse.get(source);
  if (exact !== undefined) return exact;
  const canonical = targetLocale === "zh-CN" && /\p{Script=Han}/u.test(source)
    ? englishPatterns.find(entry => entry.regex.test(source)) : undefined;
  const patterns = canonical ? [canonical] : targetLocale === "en" ? englishPatterns : chinesePatterns;
  for (const entry of patterns) {
    const match = entry.regex.exec(source);
    if (!match) continue;
    if (entry.names.some((name, index) => name === "tool" && !toolNames.has(match[index + 1]))) continue;
    const values = new Map(entry.names.map((name, index) => [name, match[index + 1]]));
    return (canonical ? entry.source : entry.target).replace(/\{(\d+|[a-zA-Z_]\w*)\}/g, (_, name: string) => {
      const value = values.get(name) ?? `{${name}}`;
      // User names, paths and values are opaque. Only explicit diagnostics recurse.
      return /^(error|message|reason|detail|tool)$/.test(name) ? translate(value, targetLocale, depth + 1) : value;
    });
  }
  return source;
}
export function t(source: string, ...args: (string | number)[]): string;
export function t<T extends string | null | undefined>(source: T, ...args: (string | number)[]): string | Extract<T, null | undefined>;
export function t(source: string | null | undefined, ...args: (string | number)[]): string | null | undefined {
  if (typeof source !== "string") return source;
  const translated = translate(source, locale);
  return args.length ? translated.replace(/\{(\d+)\}/g, (placeholder, index: string) => String(args[Number(index)] ?? placeholder)) : translated;
}
function updateDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (description) description.content = locale === "en" ? "zGIS: local spatial layers and browser-based spatial analysis" : "zGIS：本地空间图层与浏览器空间分析";
}
export function setLocale(value: Locale) {
  if (value !== "en" && value !== "zh-CN") return;
  try { localStorage.setItem(languageStorageKey, value); } catch { /* Session-only preference when storage is unavailable. */ }
  if (locale === value) { updateDocument(); return; }
  locale = value;
  updateDocument();
  listeners.forEach((listener) => listener());
}
export const getLocale = () => locale;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useLocale() {
  const current = useSyncExternalStore(subscribe, getLocale, () => "zh-CN" as Locale);
  return { locale: current, setLocale, t };
}
updateDocument();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === languageStorageKey || event.key === null) setLocale(readLocale());
});
