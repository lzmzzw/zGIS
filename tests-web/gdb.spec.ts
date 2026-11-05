import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

// This suite verifies the real loader/cache/Worker/UI pipeline with a small deterministic ABI fixture.
// Real OpenFileGDB parsing is covered separately by the generated GDAL runtime fixture smoke.
const fields = [{ name: "name", type: "String", nullable: true }];
const layer = {
  name: "survey",
  geometryType: "Point",
  sourceCrs: "EPSG:4326",
  sourceCrsWkt: "GEOGCS[WGS84]",
  fields,
  featureCount: 1,
  supported: true,
  warnings: [],
};
const result = {
  features: [
    {
      id: "fid-1",
      sourceFeatureId: "1",
      geometry: { type: "Point", coordinates: [116, 39] },
      properties: { name: "只读样本" },
    },
  ],
  ...layer,
  readLimit: 10000,
  loadedCount: 1,
  truncated: false,
  transformation: "WGS84 XY; Z unchanged",
  sourceFingerprint: "worker",
};
const glue = `export default async function(){let request;const files=new Map();return {FS:{mkdirTree(){},writeFile(p,b){files.set(p,b)}},cwrap(name){if(name==='zgis_gdb_free')return ()=>{};return text=>{const r=JSON.parse(text);if(!files.has('/gdal/proj/proj.db')||!files.has(r.path))throw Error('not mounted');request=r.operation==='catalog'?{ok:true,result:{layers:[${JSON.stringify(layer)}],warnings:[]}}:{ok:true,result:${JSON.stringify(result)}};return 1}},UTF8ToString(){return JSON.stringify(request)}}}`;
const assets = new Map([
  ["gdb-runtime.js", Buffer.from(glue)],
  ["gdb-runtime.wasm", Buffer.from("fixture-wasm")],
  ["proj/proj.db", Buffer.from("fixture-proj")],
]);
const manifest = {
  version: "test-r1",
  files: [...assets].map(([name, bytes]) => ({
    name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })),
};
async function setup(page: Page) {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  const requests: string[] = [];
  await page.route("**/gdb-runtime/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path.endsWith("manifest.json"))
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(manifest),
      });
    const bytes = assets.get(path.split("test-r1/")[1]);
    return route.fulfill({
      contentType: path.endsWith(".js")
        ? "text/javascript"
        : "application/octet-stream",
      body: bytes ?? Buffer.from("missing"),
      status: bytes ? 200 : 404,
    });
  });
  await page.goto("./");
  await expect(
    page.getByRole("button", { name: "导入 GDB", exact: true }),
  ).toBeVisible();
  return requests;
}
async function choose(page: Page) {
  await page.getByRole("button", { name: "导入 GDB", exact: true }).click();
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择 GDB ZIP", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: "sample.gdb.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("local-gdb-fixture"),
  });
  await expect(
    page.getByRole("button", { name: "添加只读图层", exact: true }),
  ).toBeEnabled();
}
test("Web GDB loads only on demand under /zgis/, caches verified assets, stays read-only and downloads", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.waitForTimeout(200);
  expect(requests).toEqual([]);
  await choose(page);
  expect(requests).toHaveLength(4);
  expect(requests.every((path) => path.startsWith("/zgis/gdb-runtime/"))).toBe(
    true,
  );
  await page.screenshot({ path: "output/web-gdb-panel.png" });
  await page.getByRole("button", { name: "添加只读图层", exact: true }).click();
  await expect(page.locator(".web-layer")).toContainText("GDB 只读");
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("table", { name: "图层属性", exact: true }),
  ).toContainText("只读样本");
  await page.keyboard.press("Delete");
  await expect(page.locator(".web-layer")).toContainText("1 个要素");
  await page.getByRole("button", { name: "下载图层", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.geojson$/);
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeDisabled();
  await page.unroute("**/gdb-runtime/**");
  await page.route("**/gdb-runtime/**", (route) =>
    route.abort("internetdisconnected"),
  );
  await choose(page);
  await page.getByRole("button", { name: "添加只读图层", exact: true }).click();
  await expect(page.locator(".web-layer")).toHaveCount(2);
});
test("cancelling a first-use runtime download cannot append a layer", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/gdb-runtime/manifest.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route
      .fulfill({
        contentType: "application/json",
        body: JSON.stringify(manifest),
      })
      .catch(() => {});
  });
  await page.getByRole("button", { name: "导入 GDB", exact: true }).click();
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择 GDB ZIP", exact: true }).click();
  await (
    await picker
  ).setFiles({
    name: "sample.gdb.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("local"),
  });
  await page.getByRole("button", { name: "取消读取", exact: true }).click();
  await page.waitForTimeout(400);
  await expect(page.locator(".web-layer")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "添加只读图层", exact: true }),
  ).toBeDisabled();
});
