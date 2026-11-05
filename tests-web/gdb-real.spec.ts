import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

// Explicit opt-in: CI must build the GDAL WASM runtime and generate the Rust fixture first.
test.skip(
  process.env.ZGIS_GDB_REAL !== "1",
  "Set ZGIS_GDB_REAL=1 after building the real GDAL runtime and GDB fixture",
);
const root = path.resolve("output/gdb-fixtures/兼容性样本.gdb");
function fixtureZip(): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    if (fs.statSync(file).isFile() && !name.endsWith(".lock"))
      entries[`兼容性样本.gdb/${name}`] = fs.readFileSync(file);
  }
  return Buffer.from(zipSync(entries));
}
async function open(page: Page, directory = false) {
  await page.getByRole("button", { name: "导入 GDB", exact: true }).click();
  const picker = page.waitForEvent("filechooser");
  await page
    .getByRole("button", {
      name: directory ? "选择 GDB 目录" : "选择 GDB ZIP",
      exact: true,
    })
    .click();
  await (
    await picker
  ).setFiles(
    directory
      ? root
      : {
          name: "兼容性样本.gdb.zip",
          mimeType: "application/zip",
          buffer: fixtureZip(),
        },
  );
  await expect(
    page.getByRole("combobox", { name: "GDB 图层", exact: true }),
  ).toBeVisible({ timeout: 120000 });
}
async function download(page: Page) {
  await page.getByRole("button", { name: "下载图层", exact: true }).click();
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  const stream = await (await saved).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
test.beforeEach(async ({ page }) => {
  test.setTimeout(180000);
  expect(
    fs.existsSync("dist-web/gdb-runtime/manifest.json"),
    "Built GDAL runtime manifest",
  ).toBe(true);
  expect(fs.existsSync(root), "Generated real GDB fixture").toBe(true);
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("./");
});
test("real OpenFileGDB ZIP: selected fields/limit, immutable source, cached offline XYZ import and download", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("combobox", { name: "GDB 图层", exact: true })
    .selectOption("points");
  await page
    .getByRole("spinbutton", { name: "GDB 读取上限", exact: true })
    .fill("2");
  await page.getByRole("button", { name: "添加只读图层", exact: true }).click();
  await expect(page.locator(".web-layer")).toContainText("2 个要素");
  await expect(page.locator(".web-layer")).toContainText("GDB 只读");
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeDisabled();
  const data = await download(page);
  expect(data.features).toHaveLength(2);
  expect(data.features[0].properties.big).toBe("9007199254740993");
  expect(data.features[0].properties.nullable).toBeNull();
  expect(data.features[1].properties.nullable).toBe("");
  await page.route("**/gdb-runtime/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await open(page);
  await page
    .getByRole("combobox", { name: "GDB 图层", exact: true })
    .selectOption("xyz");
  await page.getByRole("button", { name: "添加只读图层", exact: true }).click();
  await expect(page.locator(".web-layer")).toHaveCount(2);
  const xyz = await download(page);
  expect(xyz.features[0].geometry.coordinates).toEqual([116, 39, 123.5]);
});
test("real directory: unsupported measured data is blocked; Web Mercator converts before download", async ({
  page,
}) => {
  await open(page, true);
  await page
    .getByRole("combobox", { name: "GDB 图层", exact: true })
    .selectOption("measured");
  await expect(
    page.getByRole("button", { name: "添加只读图层", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "GDB 图层", exact: true })
    .selectOption("projected");
  await page.getByRole("button", { name: "添加只读图层", exact: true }).click();
  const output = await download(page);
  expect(output.features[0].geometry.coordinates[0]).toBeCloseTo(116, 6);
  expect(output.features[0].geometry.coordinates[1]).toBeCloseTo(39, 6);
});
