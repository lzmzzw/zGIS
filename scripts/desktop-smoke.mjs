import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import shp from "shpjs";
import { layerBasemapSmoke } from "./layer-basemap-smoke.mjs";
import { layerTreeStyleSmoke } from "./layer-tree-style-smoke.mjs";
import { mcpNativeSmoke } from "./mcp-native-smoke.mjs";
import { mcpConnectionSmoke } from "./mcp-connection-smoke.mjs";
import { contextMenuSmoke } from "./context-menu-smoke.mjs";
import { settingsInfoSmoke } from "./settings-info-smoke.mjs";
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
await mcpConnectionSmoke(page);
if (process.argv.includes("--recovery-only")) {
  await page.waitForFunction(() =>
    document
      .querySelector(".operation-status")
      ?.textContent?.includes("已恢复"),
  );
  assert.equal(await page.locator('[data-node-kind="layer"]').count(), 1);
  await layerBasemapSmoke(page, true);
  await layerTreeStyleSmoke(page, true);
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
assert.equal(
  await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)),
  true,
);
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
  await editCell("name");
  await page
    .getByRole("textbox", { name: "属性 name", exact: true })
    .fill(value);
  await page.getByRole("button", { name: "应用", exact: true }).click();
}
async function editCell(field) {
  const edit = page.getByRole("button", { name: "编辑属性", exact: true });
  if ((await edit.getAttribute("aria-pressed")) !== "true") await edit.click();
  await page
    .locator(`.attribute-panel tbody tr.selected td[data-field="${field}"]`)
    .dblclick();
}
await page.getByRole("button", { name: "设置", exact: true }).click();
await page.getByRole("button", { name: "MCP", exact: true }).click();
const nativeTools = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("gis_mcp_tool_catalog"));
assert.equal(nativeTools.length, 14);
await page.getByRole("button", { name: /工具详情/ }).click();
await page.waitForSelector(".mcp-tool-item");
assert.deepEqual((await page.locator(".mcp-tool-item code").allTextContents()).sort(), nativeTools.map(tool => tool.name).sort());
const firstTool = page.locator(".mcp-tool-item").first();
assert.equal(await firstTool.locator("p").isVisible(), false);
await firstTool.locator("summary").click();
assert.equal(await firstTool.locator("p").innerText(), nativeTools.find(tool => tool.name === "list_layers").description);
assert.equal(await page.getByRole("button", { name: "停止 MCP", exact: true }).isVisible(), true);
await page.getByRole("button", { name: "停止 MCP", exact: true }).click();
await page.getByRole("button", { name: "启用 MCP", exact: true }).waitFor();
assert.equal(await page.getByRole("button", { name: "启用 MCP", exact: true }).isVisible(), true);
assert.deepEqual((await page.locator(".mcp-tool-item code").allTextContents()).sort(), nativeTools.map(tool => tool.name).sort());
await page.getByRole("button", { name: "启用 MCP", exact: true }).click();
await page.getByRole("button", { name: "停止 MCP", exact: true }).waitFor();
await page.screenshot({ path: "output/desktop/mcp-tool-catalog.png" });
await page.getByRole("button", { name: "返回地图", exact: true }).click();
console.log("PASS: native MCP catalog lists every registered tool while service is stopped");
await settingsInfoSmoke(page);
const opening = nativeDialog("output/smoke/fixtures/native.geojson");
await fileAction("打开文件…");
await opening;
await page.getByRole("button", { name: "导入", exact: true }).click();
assert.equal(await page.locator(".attribute-title").innerText(), "属性表");
assert.equal(await page.locator(".attribute-panel > header button").count(), 1);
assert.equal(await page.locator(".header-actions").getByRole("button", { name: "属性表", exact: true }).count(), 0);
assert.equal(await page.locator(".header-menus").getByRole("button", { name: "设置", exact: true }).isVisible(), true);
await page
  .locator(".attribute-panel")
  .getByRole("button", { name: "展开属性表", exact: true })
  .click();
await page.waitForSelector("tbody tr");
assert.equal(await page.locator("tbody tr").count(), 1);
const tableControls = page.getByRole("group", { name: "属性表显示控制" });
const maximizeTable = tableControls.getByRole("button", { name: "最大化属性表", exact: true });
const collapseTable = tableControls.getByRole("button", { name: "收起属性表", exact: true });
const maximizeBounds = await maximizeTable.boundingBox();
const collapseBounds = await collapseTable.boundingBox();
assert.ok(maximizeBounds.x + maximizeBounds.width <= collapseBounds.x);
await maximizeTable.click();
const restoreTable = tableControls.getByRole("button", { name: "还原属性表", exact: true });
assert.equal(await restoreTable.getAttribute("aria-pressed"), "true");
assert.equal(await page.locator(".map-container").isVisible(), false);
await page.locator("tbody tr").click();
await page.waitForTimeout(450);
assert.equal(await page.locator("tbody").evaluate(body => getComputedStyle(body, "::before").content), "none");
assert.equal(await page.locator("tbody").evaluate(body => getComputedStyle(body, "::after").content), "none");
await page.screenshot({ path: "output/desktop/table-maximized.png" });
await restoreTable.click();
assert.equal(await page.locator(".map-container").isVisible(), true);
console.log("PASS: native maximized table uses natural record boundaries and distinct right-side display controls");
await page.locator("tbody tr").click();
assert.equal(await page.locator("footer, .ol-scale-line").count(), 0);
assert.equal(await page.getByLabel("经纬度坐标").isVisible(), true);
assert.equal(await page.getByRole("button", { name: "新增点", exact: true }).count(), 0);
await page.getByRole("button", { name: "手形", exact: true }).click();
const handMap = await page.getByLabel("地理数据地图").boundingBox();
await page.mouse.click(handMap.x + handMap.width / 2, handMap.y + handMap.height / 2);
assert.equal(await page.locator("tbody tr.selected").count(), 1);
await page.getByRole("button", { name: "编辑", exact: true }).click();
assert.equal(await page.getByRole("button", { name: "保存并退出编辑", exact: true }).isDisabled(), true);
await setName("已原生保存");
assert.equal(await page.getByRole("button", { name: "保存并退出编辑", exact: true }).isEnabled(), true);
await page.getByRole("button", { name: "保存并退出编辑", exact: true }).click();
await page.waitForFunction(() =>
  document
    .querySelector(".operation-status")
    ?.textContent?.includes("保存完成"),
);
const source = JSON.parse(
  readFileSync("output/smoke/fixtures/native.geojson", "utf8"),
);
assert.equal(source.features[0].properties.name, "已原生保存");
assert.equal(source.features[0].id, "native-1");
assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).isVisible(), true);
assert.equal(await page.getByRole("button", { name: "新增点", exact: true }).count(), 0);
console.log("PASS: native coordinate overlay, hand mode, explicit edit and successful save exit");
await fileAction("导出 / 转换");
assert.equal(await page.locator(".file-export .export-source").count(), 1);
assert.equal(await page.locator(".file-export .dialog-summary").count(), 0);
assert.equal((await page.getByRole("dialog").boundingBox()).width <= 562, true);
await page.screenshot({ path: "output/desktop/export-compact.png" });
await page.getByLabel("输出格式").selectOption("wkt");
const cancelling = nativeDialog("", true);
await page.getByRole("button", { name: "导出", exact: true }).click();
await cancelling;
await page.waitForFunction(() =>
  document
    .querySelector(".operation-status")
    ?.textContent?.includes("已取消导出"),
);
assert.equal(await page.getByRole("dialog").count(), 1);
rmSync("output/desktop/native-export.csv", { force: true });
const saving = nativeDialog("output/desktop/native-export.csv");
await page.getByRole("button", { name: "导出", exact: true }).click();
await saving;
await page.waitForFunction(() =>
  document
    .querySelector(".operation-status")
    ?.textContent?.includes("导出完成"),
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
if (await page.getByRole("button", { name: "放弃并移除", exact: true }).count()) await page.getByRole("button", { name: "放弃并移除", exact: true }).click();
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
    ext,
    readFileSync(`output/smoke/fixtures/cities.${ext}`),
  ]),
);
const shpOpening = nativeDialog("output/smoke/fixtures/cities.shp");
await fileAction("打开文件…");
await shpOpening;
await page.waitForFunction(
  () => document.querySelectorAll("tbody tr").length === 2,
);
await page.locator("tbody tr").first().click();
await setName("北京编辑后");
await page
  .locator(".attribute-panel summary")
  .filter({ hasText: /^更多$/ })
  .click();
await page.getByRole("button", { name: "WKT 几何…", exact: true }).click();
await page
  .getByRole("textbox", { name: "WKT 几何", exact: true })
  .fill("POINT (117 40)");
await page.getByRole("button", { name: "应用几何", exact: true }).click();
await page
  .getByRole("dialog")
  .getByRole("button", { name: "关闭", exact: true })
  .first()
  .click();
await fileAction("保存");
await page.getByLabel("输出格式").selectOption("shp");
const shpCancelling = nativeDialog("", true);
await page.getByRole("button", { name: "导出", exact: true }).click();
await shpCancelling;
await page.waitForFunction(() =>
  document
    .querySelector(".operation-status")
    ?.textContent?.includes("已取消导出"),
);
assert.equal(await page.getByRole("dialog").count(), 1);
rmSync("output/desktop/edited-shp.zip", { force: true });
const shpSaving = nativeDialog("output/desktop/edited-shp.zip");
await page.getByRole("button", { name: "导出", exact: true }).click();
await shpSaving;
await page.waitForFunction(() =>
  document
    .querySelector(".operation-status")
    ?.textContent?.includes("保存完成"),
);
const zip = readFileSync("output/desktop/edited-shp.zip");
const roundtrip = await shp(
  zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
);
assert.equal(roundtrip.features.length, 2);
assert.equal(roundtrip.features[0].properties.name, "北京编辑后");
assert.equal(roundtrip.features[0].properties.code, "001");
assert.deepEqual(roundtrip.features[0].geometry.coordinates, [117, 40]);
for (const [ext, bytes] of Object.entries(originalGroup))
  assert.deepEqual(readFileSync(`output/smoke/fixtures/cities.${ext}`), bytes);
assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).isVisible(), true);
await page.screenshot({ path: "output/desktop/shp-edited-export.png" });
await fileAction("移除图层");
await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 0);
console.log(
  "PASS: native SHP attribute/geometry editing, ZIP cancellation/save, independent Chinese/coordinate roundtrip and unchanged original group",
);
if (!process.argv.includes("--installation-only")) {
  await mcpNativeSmoke(page, nativeDialog, fileAction);
} else
  console.log(
    "Installation scope: external Codex CLI/MCP checks omitted; native file and restart checks retained.",
  );
assert.deepEqual(errors, []);
console.log(
  "PASS: desktop WebView2, native open/save/export/cancel, source ID preservation, external-file conflict protection and immediate discarded-recovery clearing",
);
await page.locator(".app-header summary").filter({ hasText: /^数据$/ }).click();
assert.deepEqual(await page.locator(".app-header .header-menu[open] button").allTextContents(), ["导入数据…", "PostGIS 数据源…"]);
await page.keyboard.press("Escape");
const editingOpening = nativeDialog("output/smoke/fixtures/editing.geojson");
await fileAction("打开文件…");
await editingOpening;
await page.getByRole("button", { name: "导入", exact: true }).click();
await page.waitForFunction(() => document.querySelectorAll(".attribute-panel tbody tr").length === 4);
assert.equal(await page.locator("tbody tr").count(), 4);
await page.locator("tbody tr").first().click();
await editCell("城市");
await page
  .getByRole("textbox", { name: "属性 城市", exact: true })
  .fill("跨进程恢复测试");
await page.getByRole("button", { name: "应用", exact: true }).click();
await contextMenuSmoke(page);
await layerBasemapSmoke(page);
await layerTreeStyleSmoke(page);
const closed = page.waitForEvent("close");
await fileAction("退出");
await closed;
console.log(
  "PASS: normal native exit automatically persists applied edits without a confirmation",
);
await browser.close();
