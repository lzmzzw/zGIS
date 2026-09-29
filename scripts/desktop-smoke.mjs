import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
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
  assert.equal(await page.locator(".layer-row").count(), 1);
  await page.screenshot({ path: "output/desktop/installed-recovered.png" });
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.locator(".exit-layers select").selectOption("discard");
  const closed = page.waitForEvent("close");
  await page.getByRole("button", { name: "处理并退出", exact: true }).click();
  await closed;
  console.log(
    "PASS: automatic recovery after process restart and explicit discard exit",
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
assert.deepEqual(errors, []);
console.log(
  "PASS: desktop WebView2, native open/save/export/cancel, source ID preservation, external-file conflict protection and immediate discarded-recovery clearing",
);
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
await fileAction("退出");
const closed = page.waitForEvent("close");
await page.getByRole("button", { name: "处理并退出", exact: true }).click();
await closed;
console.log("PASS: per-layer keep action persists recovery before native exit");
await browser.close();
