import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function load(page: Page, groupCount?: number) {
  await page.route("https://tile.openstreetmap.org/**", route => route.abort());
  await page.goto("./");
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles({ name: "attributes.geojson", mimeType: "application/geo+json", buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: groupCount ? Array.from({ length: groupCount }, (_, i) => ({ type: "Feature", properties: { kind: `group-${i}`, amount: i }, geometry: { type: "Point", coordinates: [114, 30] } })) : [
    { type: "Feature", id: 42, properties: { kind: "A", amount: 12 }, geometry: { type: "Point", coordinates: [114, 30, 8] } },
    { type: "Feature", id: "code", properties: { kind: "A", amount: 8 }, geometry: { type: "Point", coordinates: [114.01, 30, 9] } },
    { type: "Feature", properties: { kind: "B", amount: 20 }, geometry: { type: "Point", coordinates: [114.02, 30, 10] } },
  ] })) });
  await page.getByRole("dialog", { name: "导入文件", exact: true }).getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
}
async function download(page: Page) {
  await page.getByRole("button", { name: "下载图层", exact: true }).click();
  await page.getByLabel("输出格式").selectOption("geojson");
  const pending = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name: "下载", exact: true }).click();
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}
test("属性条件通过真实WASM筛选，保留原来源ID和XYZ", async ({ page }) => {
  await load(page);
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("搜索分析工具").fill("按属性条件提取");
  await box.getByRole("button", { name: "按属性条件提取", exact: true }).click();
  await box.getByLabel("条件字段", { exact: true }).selectOption("amount");
  await box.getByLabel("比较方式", { exact: true }).selectOption("gt");
  await box.getByLabel("比较值", { exact: true }).fill("10");
  await box.getByLabel("结果图层名称").fill("filtered");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(page.getByRole("button", { name: "filtered", exact: true })).toBeVisible();
  const data = await download(page);
  expect(data.features).toHaveLength(2);
  expect(data.features[0].id).toBe(42);
  expect(data.features[1]).not.toHaveProperty("id");
  expect(data.features[0].geometry.coordinates).toEqual([114, 30, 8]);
  await box.getByLabel("比较值", { exact: true }).fill("0");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(box.getByLabel("分析结果", { exact: true })).toBeVisible();
  expect((await download(page)).features.map((feature: { id?: unknown }) => feature.id)).toEqual([42, "code", undefined]);
  await box.getByLabel("比较值", { exact: true }).fill("100");
  await box.getByLabel("结果图层名称").fill("empty_result");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(page.getByRole("button", { name: "empty_result", exact: true })).toBeVisible();
  expect((await download(page)).features).toEqual([]);
});

test("字段分组统计输出只读表格，核对聚合及每页100行", async ({ page }) => {
  await load(page, 101);
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("搜索分析工具").fill("字段分组统计");
  await box.getByRole("button", { name: "字段分组统计", exact: true }).click();
  await box.getByLabel("分组字段", { exact: true }).selectOption({ label: "kind" });
  await box.getByLabel("指标名称", { exact: true }).fill("total");
  await box.getByLabel("统计方式", { exact: true }).selectOption("sum");
  await box.getByLabel("统计字段", { exact: true }).selectOption("amount");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  const table = box.getByRole("table", { name: "字段统计结果", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await box.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(box.getByLabel("输入图层", { exact: true }).locator('option:not([value=""])')).toHaveCount(1);
  await box.getByLabel("分组字段", { exact: true }).selectOption("all");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("5050");
  await expect(box.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
  await table.scrollIntoViewIfNeeded();
  await expect(table).toBeInViewport();
  await page.screenshot({ path: "output/feature-expansion-2026-10-18/statistics-zh.png", fullPage: true });
});
