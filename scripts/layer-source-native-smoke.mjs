// 仅启动隔离 identifier 的构建，所有读写均为本次生成的夹具。
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import shp from "shpjs";
import "./create-fixtures.mjs";

const output = resolve("output/layer-source-save/native", String(Date.now()));
mkdirSync(output, { recursive: true });
const executable = resolve("src-tauri/target/release/zgis.exe");
let child, browser, page;
const button = (name) => page.getByRole("button", { name, exact: true });
const run = (file, args) =>
  new Promise((done, fail) => {
    const process = spawn(file, args, { windowsHide: true });
    let log = "";
    process.stdout.on("data", (data) => {
      log += data;
    });
    process.stderr.on("data", (data) => {
      log += data;
    });
    process.on("error", fail);
    process.on("exit", (code) =>
      code === 0 ? done(log) : fail(new Error(log)),
    );
  });
async function dialog(path, action, cancel = false) {
  const pending = run("pwsh", [
    "-NoProfile",
    "-File",
    "scripts/native-dialog.ps1",
    "-AppPid",
    String(child.pid),
    ...(cancel ? ["-Cancel"] : ["-FilePath", path]),
  ]);
  await action();
  await pending;
}
async function openNative(path) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await dialog(path, () => button("打开").click());
}
async function editName(value) {
  await page.locator(".attribute-panel tbody tr").first().click();
  await page.locator('td[data-field="name"]').first().dblclick();
  await page.getByLabel("属性 name", { exact: true }).fill(value);
  await page.keyboard.press("Enter");
}
try {
  child = spawn(executable, [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9228",
      WEBVIEW2_USER_DATA_FOLDER: resolve(output, "webview"),
    },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
      break;
    } catch (reason) {
      if (attempt === 59) throw reason;
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".app");
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"),
    ),
    "com.personal.zgis.layer-source-smoke",
  );
  await page.evaluate(() => {
    localStorage.removeItem("zgis.editRecovery");
    return window.__TAURI_INTERNALS__.invoke("save_recovery", {
      content: JSON.stringify({ version: 3, layers: [], tree: [] }),
    });
  });
  await page.reload();
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "workspace.geojson",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          type: "Feature",
          geometry: { type: "Point", coordinates: [116, 40] },
          properties: { name: "before" },
        }),
      ),
    });
  await button("导入").click();
  await expect(page.locator('[data-source-kind="workspace"]')).toHaveCount(1);
  await button("编辑").click();
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
  await editName("first csv save");
  await button("保存编辑").click();
  await page.getByLabel("输出格式", { exact: true }).selectOption("wkt");
  await page
    .getByLabel("目标坐标系", { exact: true })
    .selectOption("EPSG:3857");
  const csv = resolve(output, "saved.csv");
  await dialog(csv, () => button("选择路径并保存").click(), true);
  await expect(
    page.getByRole("dialog", { name: "保存图层", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-source-kind="workspace"]')).toHaveCount(1);
  await dialog(csv, () => button("选择路径并保存").click());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator('[data-source-kind="file"]')).toHaveCount(1);
  assert.match(readFileSync(csv, "utf8"), /first csv save/);
  // 重新进入编辑，验证文件图层直接回写。
  await button("退出编辑").click();
  await button("编辑").click();
  await editName("direct csv save");
  await button("保存编辑").click();
  await expect.poll(() => readFileSync(csv, "utf8")).toMatch(/direct csv save/);
  await expect(button("保存编辑")).toBeDisabled();
  assert.match(readFileSync(csv, "utf8"), /direct csv save/);
  await button("退出编辑").click();
  for (const zip of [false, true]) {
    const name = zip ? "cities.zip" : "cities.shp";
    for (const ext of zip ? ["zip"] : ["shp", "shx", "dbf", "prj", "cpg"])
      copyFileSync(
        resolve("output/smoke/fixtures", `cities.${ext}`),
        resolve(output, `cities.${ext}`),
      );
    await openNative(resolve(output, name));
    await expect(page.locator(".document-title")).toContainText("cities");
    await button("编辑").click();
    await editName(zip ? "ZIP保存" : "SHP保存");
    await button("保存编辑").click();
    await expect(button("保存编辑")).toBeDisabled();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async () => {
      const collection = zip
        ? await shp(Uint8Array.from(readFileSync(resolve(output, name))).buffer)
        : await shp({
            shp: Uint8Array.from(readFileSync(resolve(output, "cities.shp"))).buffer,
            dbf: Uint8Array.from(readFileSync(resolve(output, "cities.dbf"))).buffer,
            prj: readFileSync(resolve(output, "cities.prj"), "utf8"),
            cpg: "UTF-8",
          });
      return collection.features[0].properties.name;
    }).toBe(zip ? "ZIP保存" : "SHP保存");
    await button("退出编辑").click();
  }
  await page.screenshot({ path: resolve(output, "native-layers.png") });
  writeFileSync(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        success: true,
        executable,
        identifier: "com.personal.zgis.layer-source-smoke",
        coverage: [
          "workspace CSV format/path/cancel",
          "direct CSV writeback",
          "native SHP group writeback",
          "native ZIP member writeback",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS: native source saves; report ${resolve(output, "report.json")}`,
  );
} catch (reason) {
  await page?.screenshot({ path: resolve(output, "failure.png") }).catch(() => {});
  writeFileSync(
    resolve(output, "report.json"),
    JSON.stringify({ success: false, error: String(reason) }, null, 2),
  );
  throw reason;
} finally {
  await browser?.close();
  if (child && child.exitCode === null)
    await run("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
}
