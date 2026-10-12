// Runs only an isolated test executable/profile; no installed application is touched.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const executable = resolve(process.argv[2] ?? "src-tauri/target/release/zgis.exe");
const output = resolve(process.argv[3] ?? "output/i18n/native");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "report.json"), JSON.stringify({ success: false, executable }));
const profile = resolve(output, `profile-${Date.now()}`);
const launch = () => spawn(executable, [], { windowsHide: true, env: {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9228",
  WEBVIEW2_USER_DATA_FOLDER: profile,
} });
let child = launch();
let browser;
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9228"); break; }
    catch (error) { if (attempt === 59) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".app");
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|identifier")), "com.personal.zgis.processing-smoke", "Refuse production identity");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluate(async () => {
    localStorage.clear();
    await window.__TAURI_INTERNALS__.invoke("save_recovery", { content: JSON.stringify({ version: 3, layers: [], tree: [] }) });
  });
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeVisible();
  await expect(page.getByLabel("Theme", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("set_locale", { locale: "en" }));
  const invalidLocale = await page.evaluate(async () => {
    try { await window.__TAURI_INTERNALS__.invoke("set_locale", { locale: "invalid" }); return "accepted"; }
    catch (error) { return String(error); }
  });
  assert.match(invalidLocale, /Unsupported language/);
  await page.getByRole("button", { name: "Return to map", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await page.locator("input[type=file]").setInputFiles({ name: "中文业务.geojson", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [
    { type: "Feature", properties: { 城市: "武汉", mixed: 1 }, geometry: { type: "Point", coordinates: [114, 30] } },
    { type: "Feature", properties: { 城市: "北京", mixed: "文本业务值" }, geometry: { type: "Point", coordinates: [116, 40] } },
  ] })) });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator(".layer-text").filter({ hasText: "中文业务.geojson" })).toBeVisible();
  await page.getByRole("button", { name: "Expand attribute table", exact: true }).click();
  await expect(page.locator(".table-scroll")).toContainText("文本业务值");
  await expect(page.locator(".operation-status")).toContainText("Loaded 2 features");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface language", { exact: true }).selectOption("zh-CN");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await expect(page.locator(".operation-status")).toContainText("已载入 2 个要素");
  await expect(page.locator(".table-scroll")).toContainText("文本业务值");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await page.screenshot({ path: resolve(output, "settings-en.png") });
  await page.getByLabel("Interface language", { exact: true }).selectOption("zh-CN");
  await page.screenshot({ path: resolve(output, "settings-zh.png") });
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "Return to map", exact: true }).click();
  const closed = page.waitForEvent("close");
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Native app did not exit")), 10000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  await page.getByRole("button", { name: "Close window", exact: true }).click();
  await closed;
  await exited;
  await browser.close().catch(() => {});
  child = launch();
  for (let attempt = 0; attempt < 60; attempt++) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:9228"); break; }
    catch (error) { if (attempt === 59) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  const restarted = browser.contexts()[0].pages()[0];
  restarted.on("pageerror", error => errors.push(error.message));
  await expect(restarted.locator("html")).toHaveAttribute("lang", "en");
  await restarted.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(restarted.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  assert.deepEqual(errors, []);
  writeFileSync(resolve(output, "report.json"), JSON.stringify({ success: true, executable, sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"), identifier: "com.personal.zgis.processing-smoke", checks: ["real WebView2 settings language controls", "native locale command and validation", "bidirectional labels/status", "Chinese user data preservation", "persisted language after reload and process restart"], errors }, null, 2));
  console.log("PASS: native bilingual settings, IPC, persistence and user data preservation");
} finally {
  if (child.exitCode === null) await new Promise(resolve => {
    const cleanup = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    cleanup.on("exit", resolve); cleanup.on("error", resolve);
  });
  await browser?.close().catch(() => {});
}
