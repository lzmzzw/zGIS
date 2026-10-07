// Build with the isolated identifier below; never attach to the user's instance.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const executable = resolve(
  process.argv[2] ?? "src-tauri/target/release/zgis.exe",
);
const output = resolve("output/vector-native");
const runName = String(Date.now());
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, "report.json"),
  JSON.stringify({ success: false, runName, executable, status: "running" }),
);
const profile = resolve(output, `webview-${Date.now()}`);
let child, browser, page;
const errors = [];
const button = (name) => page.getByRole("button", { name, exact: true });
const run = (file, args) =>
  new Promise((res, rej) => {
    const process = spawn(file, args, { windowsHide: true });
    let log = "";
    process.stdout?.on("data", (data) => {
      log += data;
    });
    process.stderr?.on("data", (data) => {
      log += data;
    });
    process.on("error", rej);
    process.on("exit", (code) => (code === 0 ? res(log) : rej(new Error(log))));
  });
async function launch() {
  child = spawn(executable, [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9227",
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9227");
      break;
    } catch (reason) {
      if (attempt === 59) throw reason;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".app");
  const identifier = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"),
  );
  assert.equal(
    identifier,
    "com.personal.zgis.vector-smoke",
    "Refuse to test the production application identity",
  );
  page.on("pageerror", (error) => errors.push(error.message));
}
async function crash() {
  const exited = new Promise((r) => child.once("exit", r));
  await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
  await exited;
  await browser.close();
  browser = null;
}
const readRecovery = () =>
  page.evaluate(async () =>
    JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_recovery")),
  );
async function waitRecovery(predicate) {
  await expect.poll(async () => predicate(await readRecovery())).toBe(true);
  return readRecovery();
}
async function newLayer(kind) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await button("新建矢量图层…").click();
  await page.getByLabel("矢量图层名称", { exact: true }).fill(`native-${kind}`);
  await page.getByLabel("矢量几何类型", { exact: true }).selectOption(kind);
  await page.getByLabel("矢量属性字段", { exact: true }).fill("name");
  await button("创建并编辑").click();
  await expect(page.getByLabel("矢量编辑提示")).toContainText("编辑中");
}
async function nativeSave(name, cancel = false) {
  const dialog = run("pwsh", [
    "-NoProfile",
    "-File",
    "scripts/native-dialog.ps1",
    "-AppPid",
    String(child.pid),
    ...(cancel
      ? ["-Cancel"]
      : ["-FilePath", resolve(output, `${runName}-${name}`)]),
  ]);
  await button("保存并退出编辑").click();
  await dialog;
}
try {
  await launch();
  // Only this dedicated test identity is reset; production recovery is never read.
  await page.evaluate(async () => {
    localStorage.removeItem("zgis.editRecovery");
    await window.__TAURI_INTERNALS__.invoke("save_recovery", {
      content: JSON.stringify({ version: 3, layers: [], tree: [] }),
    });
  });
  await page.reload();
  await newLayer("Point");
  const box = await page
    .getByLabel("地理数据地图", { exact: true })
    .boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height * 0.6);
  await waitRecovery(
    (data) =>
      data.layers[0]?.features.length === 2 && data.session?.tool === "Point",
  );
  await nativeSave("cancelled.geojson", true);
  await expect(page.getByRole("alert")).toContainText("已取消保存");
  await expect(page.getByLabel("矢量编辑提示")).toBeVisible();
  await button("关闭错误").click();
  await nativeSave("points.geojson");
  await expect(button("编辑")).toBeVisible();
  assert.equal(
    JSON.parse(
      readFileSync(resolve(output, `${runName}-points.geojson`), "utf8"),
    ).features.length,
    2,
  );
  await newLayer("LineString");
  const map = await page
    .getByLabel("地理数据地图", { exact: true })
    .boundingBox();
  await page.mouse.click(map.x + map.width * 0.4, map.y + map.height * 0.5);
  await page.mouse.click(map.x + map.width * 0.6, map.y + map.height * 0.6);
  const before = await waitRecovery(
    (data) => data.session?.drawDraft?.coordinates.length === 2,
  );
  await page.screenshot({ path: resolve(output, "before-force-exit.png") });
  await crash();
  await launch();
  await expect(page.getByLabel("矢量编辑提示")).toContainText("编辑中");
  const after = await waitRecovery(
    (data) => data.session?.drawDraft?.coordinates.length === 2,
  );
  assert.deepEqual(after.session.drawDraft, before.session.drawDraft);
  await button("完成绘制").click();
  await waitRecovery(
    (data) =>
      data.layers.find((l) => l.name === "native-LineString.geojson")?.features
        .length === 1 && !data.session.drawDraft,
  );
  await nativeSave("lines.geojson");
  await expect(button("编辑")).toBeVisible();
  await button("编辑").click();
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
  await page.locator("tbody tr").click();
  await page.locator('td[data-field="name"]').dblclick();
  await page
    .getByLabel("属性 name", { exact: true })
    .fill("unfinished native draft");
  await waitRecovery(
    (data) => data.session?.cellDraft?.text === "unfinished native draft",
  );
  await page.screenshot({
    path: resolve(output, "native-attribute-draft.png"),
  });
  await crash();
  await launch();
  await expect(page.getByLabel("属性 name", { exact: true })).toHaveValue(
    "unfinished native draft",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "应用", exact: true })
    .click();
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await button("退出").click();
  await expect(
    page.getByRole("heading", { name: "退出 zGIS", exact: true }),
  ).toBeVisible();
  await button("返回编辑").click();
  await expect(page.getByLabel("矢量编辑提示")).toBeVisible();
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await button("退出").click();
  const closed = page.waitForEvent("close");
  await button("退出并保留工作区").click();
  await closed;
  await browser.close();
  browser = null;
  assert.deepEqual(errors, []);
  writeFileSync(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        success: true,
        runName,
        identifier: "com.personal.zgis.vector-smoke",
        executable,
        checks: [
          "native save cancellation",
          "native GeoJSON save",
          "forced process termination and fixed-node recovery",
          "forced termination and attribute draft recovery",
          "edit-mode close prompt and return",
          "native snapshot flush on normal exit",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: isolated release WebView2 vector editing, native save and cross-process draft recovery",
  );
} finally {
  if (child && child.exitCode === null)
    await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]).catch(
      () => {},
    );
  await browser?.close().catch(() => {});
}
