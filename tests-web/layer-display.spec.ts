import { test, expect } from "@playwright/test";

test("分类着色保留独立颜色并支持恢复单色与语言切换", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("https://tile.openstreetmap.org/**", route => route.abort());
  await page.goto("./");
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles({
    name: "classes.geojson", mimeType: "application/geo+json",
    buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [1, "1", null].map((kind, i) => ({
      type: "Feature", properties: { kind }, geometry: { type: "Point", coordinates: [114 + i * 0.01, 30] },
    })) })),
  });
  const importing = page.getByRole("dialog", { name: "导入文件", exact: true });
  await importing.getByRole("button", { name: "导入", exact: true }).click();
  // 使用可见控件核对分类，不依赖内部 React 或 OpenLayers 对象。
  await page.getByText("图层样式", { exact: true }).click();
  await page.getByLabel("着色方式", { exact: true }).selectOption("unique");
  await expect(page.getByLabel("分类字段", { exact: true })).toHaveValue("kind");
  const colors = page.getByRole("group", { name: "分类颜色" });
  await expect(colors.locator('input[type="color"]')).toHaveCount(5);
  const values = await colors.locator('input[type="color"]').evaluateAll(nodes => nodes.map(n => (n as HTMLInputElement).value));
  expect(values[0]).not.toBe(values[1]);
  await page.getByRole("button", { name: "classes.geojson 定位", exact: true }).click();
  await page.waitForTimeout(300); // 等待 OpenLayers 的 200ms fit 动画完成。
  await page.screenshot({ path: "output/feature-expansion-2026-10-18/classified-zh.png", fullPage: true });
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await expect(page.getByLabel("Color mode", { exact: true })).toBeVisible();
  await page.getByLabel("Color mode", { exact: true }).selectOption("single");
  await expect(page.getByLabel("Category field", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
