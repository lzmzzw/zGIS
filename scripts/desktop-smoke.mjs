import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import shp from "shpjs";
import { layerBasemapSmoke } from "./layer-basemap-smoke.mjs";
import { mcpNativeSmoke } from "./mcp-native-smoke.mjs";
const appPid = Number(process.argv[2]);
if (!appPid) throw new Error("Pass the isolated zGIS test process ID");
mkdirSync("output/desktop", { recursive: true });
let browser;
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
    break;
  } catch (reason) {
    if (attempt === 49) throw reason;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
const page =
  browser
    .contexts()[0]
    .pages()
    .find((p) => p.url().includes("tauri")) ?? browser.contexts()[0].pages()[0];
await page.waitForSelector(".app");
if (process.argv.includes("--recovery-only")) {
  await page.waitForFunction(() =>
    document.querySelector(".statusbar")?.textContent?.includes("已恢复"),
  );
  assert.equal(await page.locator('[data-node-kind="layer"]').count(), 1);
  await layerBasemapSmoke(page, true);
  await page.screenshot({ path: "output/desktop/installed-recovered.png" });
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  const closed = page.waitForEvent("close");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await closed;
  console.log(
    "PASS: automatic recovery after process restart and automatic work-copy persistence on exit",
  );
  await browser.close();
  process.exit(0);
}
await page.reload();
await page.waitForSelector(".app");
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function nativeDialog(filePath, cancel = false) {
  return new Promise((res, rej) => {
    const child = spawn(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        "scripts/native-dialog.ps1",
        "-AppPid",
        String(appPid),
        ...(cancel ? ["-Cancel"] : ["-FilePath", resolve(filePath)]),
      ],
      { windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) =>
      code === 0 ? res(output) : rej(new Error(output)),
    );
  });
}
assert.match(await page.locator(".statusbar").innerText(), /Windows 桌面/);
async function fileAction(name) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page
    .locator(".app-header")
    .getByRole("button", { name, exact: true })
    .click();
}
async function setName(value) {
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByRole("textbox", { name: "属性 name", exact: true })
    .fill(value);
  await page.getByRole("button", { name: "应用", exact: true }).click();
}
const opening = nativeDialog("output/smoke/fixtures/native.geojson");
await fileAction("打开文件…");
await opening;
await page.getByRole("button", { name: "导入", exact: true }).click();
await page
  .locator(".header-actions")
  .getByRole("button", { name: "属性表", exact: true })
  .click();
await page.waitForSelector("tbody tr");
assert.equal(await page.locator("tbody tr").count(), 1);
await page.locator("tbody tr").click();
await setName("已原生保存");
await fileAction("保存");
await page.waitForFunction(() =>
  document.querySelector(".statusbar")?.textContent?.includes("保存完成"),
);
const source = JSON.parse(
  readFileSync("output/smoke/fixtures/native.geojson", "utf8"),
);
assert.equal(source.features[0].properties.name, "已原生保存");
assert.equal(source.features[0].id, "native-1");
await fileAction("导出 / 转换");
await page.getByLabel("输出格式").selectOption("wkt");
const cancelling = nativeDialog("", true);
await page.getByRole("button", { name: "导出", exact: true }).click();
await cancelling;
await page.waitForFunction(() =>
  document.querySelector(".statusbar")?.textContent?.includes("已取消导出"),
);
assert.equal(await page.getByRole("dialog").count(), 1);
rmSync("output/desktop/native-export.csv", { force: true });
const saving = nativeDialog("output/desktop/native-export.csv");
await page.getByRole("button", { name: "导出", exact: true }).click();
await saving;
await page.waitForFunction(() =>
  document.querySelector(".statusbar")?.textContent?.includes("导出完成"),
);
assert.match(readFileSync("output/desktop/native-export.csv", "utf8"), /POINT/);
writeFileSync(
  "output/smoke/fixtures/native.geojson",
  JSON.stringify({ ...source, externalChange: true }),
);
await setName("冲突检查");
await fileAction("保存");
await page.getByRole("alert").waitFor();
assert.match(await page.getByRole("alert").innerText(), /外部修改/);
await page.getByRole("button", { name: "关闭错误" }).click();
await page.getByRole("button", { name: "撤销", exact: true }).click();
await page.screenshot({ path: "output/desktop/installed-zgis.png" });
await fileAction("移除图层");
await page.getByRole("button", { name: "放弃并移除", exact: true }).click();
await page.waitForFunction(
  () => document.querySelectorAll("tbody tr").length === 0,
);
const recovery = await page.evaluate(() =>
  window.__TAURI_INTERNALS__.invoke("load_recovery"),
);
assert.equal(recovery, "[]");
// Edit an owned SHP fixture and verify the native ZIP through an independent reader.
const originalGroup = Object.fromEntries(
  ["shp", "shx", "dbf", "prj", "cpg"].map((ext) => [
    ext, readFileSync(`output/smoke/fixtures/cities.${ext}`),
  ]),
);
const shpOpening = nativeDialog("output/smoke/fixtures/cities.shp");
await fileAction("打开文件…");
await shpOpening;
await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
await page.locator("tbody tr").first().click();
await setName("北京编辑后");
await page.getByRole("button", { name: "WKT 几何…", exact: true }).click();
await page.getByRole("textbox", { name: "WKT 几何", exact: true }).fill("POINT (117 40)");
await page.getByRole("button", { name: "应用几何", exact: true }).click();
await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).first().click();
await fileAction("保存");
await page.getByLabel("输出格式").selectOption("shp");
const shpCancelling = nativeDialog("", true);
await page.getByRole("button", { name: "导出", exact: true }).click();
await shpCancelling;
await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("已取消导出"));
assert.equal(await page.getByRole("dialog").count(), 1);
rmSync("output/desktop/edited-shp.zip", { force: true });
const shpSaving = nativeDialog("output/desktop/edited-shp.zip");
await page.getByRole("button", { name: "导出", exact: true }).click();
await shpSaving;
await page.waitForFunction(() => document.querySelector(".statusbar")?.textContent?.includes("导出完成"));
const zip = readFileSync("output/desktop/edited-shp.zip");
const roundtrip = await shp(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
assert.equal(roundtrip.features.length, 2);
assert.equal(roundtrip.features[0].properties.name, "北京编辑后");
assert.equal(roundtrip.features[0].properties.code, "001");
assert.deepEqual(roundtrip.features[0].geometry.coordinates, [117, 40]);
for (const [ext, bytes] of Object.entries(originalGroup))
  assert.deepEqual(readFileSync(`output/smoke/fixtures/cities.${ext}`), bytes);
await page.screenshot({ path: "output/desktop/shp-edited-export.png" });
await fileAction("移除图层");
await page.getByRole("button", { name: "放弃并移除", exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 0);
console.log("PASS: native SHP attribute/geometry editing, ZIP cancellation/save, independent Chinese/coordinate roundtrip and unchanged original group");
if (!process.argv.includes("--installation-only")) {
  await mcpNativeSmoke(page, nativeDialog, fileAction);
} else console.log("Installation scope: external Codex CLI/MCP checks omitted; native file and restart checks retained.");
assert.deepEqual(errors, []);
console.log(
  "PASS: desktop WebView2, native open/save/export/cancel, source ID preservation, external-file conflict protection and immediate discarded-recovery clearing",
);
await page.locator(".app-header summary").filter({ hasText: /^数据$/ }).click();
await page
  .getByRole("button", { name: "城市示例", exact: true })
  .filter({ visible: true })
  .click();
await page.locator("tbody tr").first().click();
await page.getByRole("button", { name: "编辑", exact: true }).click();
await page
  .getByRole("textbox", { name: "属性 城市", exact: true })
  .fill("跨进程恢复测试");
await page.getByRole("button", { name: "应用", exact: true }).click();
await layerBasemapSmoke(page);
const closed = page.waitForEvent("close");
await fileAction("退出");
await closed;
console.log("PASS: normal native exit automatically persists applied edits without a confirmation");
await browser.close();
