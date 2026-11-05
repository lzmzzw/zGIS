import { chromium, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Run only against a separately built, isolated-identifier application. Never
// point this at the user's running installation or production recovery data.
const appPid = Number(process.argv[2]);
const port = Number(process.env.ZGIS_SMOKE_CDP_PORT);
if (!appPid || !port) throw new Error("Pass the isolated application PID and ZGIS_SMOKE_CDP_PORT");
const root = path.resolve("output/gdb-desktop-smoke");
fs.mkdirSync(root, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];
await page.waitForSelector(".app");
const title = spawnSync("pwsh", ["-NoProfile", "-Command", "& { param($processId) (Get-Process -Id $processId).MainWindowTitle }", String(appPid)], { encoding: "utf8", windowsHide: true });
if (title.status !== 0 || title.stdout.trim() !== "zGIS GDB Smoke")
  throw new Error("GDB smoke requires the isolated configuration and window title zGIS GDB Smoke");
expect(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__) && !window.__ZG_TEST__)).toBe(true);
const row = page.locator('.tree-row[data-source-kind="gdb"]');
const toolbar = page.getByRole("toolbar", { name: "地图工具", exact: true });
function nativeDialog(filename) {
  return new Promise((resolve, reject) => {
    const child = spawn("pwsh", ["-NoProfile", "-File", "scripts/native-dialog.ps1", "-AppPid", String(appPid), "-FilePath", filename], { windowsHide: true });
    let output = "";
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { output += value; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(output)));
  });
}
if (!process.argv.includes("--recovery-only")) {
  while (await row.count()) {
    const previousCount = await row.count();
    await row.first().locator(".layer-text").click({ button: "right" });
    await page.getByRole("menuitem", { name: "移除", exact: true }).click();
    await expect(row).toHaveCount(previousCount - 1);
  }
  await page.locator(".header-menu summary").filter({ hasText: /^文件$/ }).click();
  await page.getByRole("button", { name: "打开 GDB…", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "GDB 只读导入", exact: true });
  const chosen = nativeDialog(path.resolve("output/gdb-fixtures/兼容性样本.gdb.zip"));
  await panel.getByRole("button", { name: "选择 GDB ZIP", exact: true }).click();
  await chosen;
  await expect(panel.getByLabel("GDB 图层", { exact: true })).toBeVisible({ timeout: 60000 });
  await panel.getByLabel("GDB 图层", { exact: true }).selectOption("points");
  await panel.getByLabel("GDB 读取上限", { exact: true }).fill("2");
  await panel.getByRole("button", { name: "添加只读图层", exact: true }).click();
  await expect(row).toHaveCount(1, { timeout: 30000 }).catch(async error => { await page.screenshot({ path: path.join(root, "failure.png") }); console.error(await page.locator("body").innerText()); throw error; });
  await expect(toolbar.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
  await page.keyboard.press("Control+s");
  const exporting = page.getByRole("dialog", { name: "导出为", exact: true });
  await expect(exporting).toBeVisible();
  const filename = path.join(root, "native-export.geojson");
  fs.rmSync(filename, { force: true });
  const saved = nativeDialog(filename);
  await exporting.getByRole("button", { name: "导出", exact: true }).click();
  await saved;
  await expect(exporting).toHaveCount(0);
  const output = JSON.parse(fs.readFileSync(filename, "utf8"));
  expect(output.features).toHaveLength(2);
  expect(output.features[0].properties.big).toBe("9007199254740993");
  expect(output.features[0].properties.nullable).toBeNull();
  expect(output.features[1].properties.nullable).toBe("");
} else {
  await expect(row).toHaveCount(1, { timeout: 30000 });
  await expect(toolbar.getByRole("button", { name: "编辑", exact: true })).toBeDisabled();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("dialog", { name: "导出为", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}
await expect(row.getByLabel("只读图层", { exact: true })).toBeVisible();
await page.screenshot({ path: path.join(root, process.argv.includes("--recovery-only") ? "recovered.png" : "imported-exported.png") });
const closed = page.waitForEvent("close");
await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
const keep = page.getByRole("button", { name: "退出并保留工作区", exact: true });
const needsConfirmation = await Promise.race([closed.then(() => false), keep.waitFor({ state: "visible" }).then(() => true)]);
if (needsConfirmation) await keep.click();
await closed;
await browser.close();
console.log("PASS: real isolated Tauri GDB read-only import/export or restart recovery");
