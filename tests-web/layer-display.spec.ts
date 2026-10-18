import { test, expect } from "@playwright/test";

test("分类着色保留独立颜色并支持恢复单色与语言切换", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("https://tile.openstreetmap.org/**", route => route.abort());
  await page.goto("./");
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles({
    name: "classes.geojson", mimeType: "application/geo+json",
    buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [1, "1", null].map((kind, i) => ({
      type: "Feature", properties: { kind, label: ["武汉站点", "设施 Alpha", "空值类别"][i] }, geometry: { type: "Point", coordinates: [114 + i * 0.01, 30] },
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
  await page.getByLabel("显示标注", { exact: true }).check();
  await page.getByLabel("标注字段", { exact: true }).selectOption("label");
  await page.getByLabel("标注字号", { exact: true }).fill("18");
  await page.getByLabel("标注颜色", { exact: true }).fill("#273c75");
  await page.getByLabel("标注描边颜色", { exact: true }).fill("#ffffff");
  await page.getByLabel("标注描边宽度", { exact: true }).fill("4");
  await expect(page.getByLabel("标注字号", { exact: true })).toHaveValue("18");
  await expect(page.getByLabel("标注描边宽度", { exact: true })).toHaveValue("4");
  await page.waitForTimeout(200); // 等待显示配置触发一次地图重绘。
  await page.screenshot({ path: "output/feature-expansion-2026-10-18/labeled-zh.png", fullPage: true });
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await expect(page.getByLabel("Color mode", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Show labels", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Label field", { exact: true })).toHaveValue("label");
  await expect(page.getByLabel("Label font size", { exact: true })).toHaveValue("18");
  const labelControls = page.getByRole("group", { name: "Field labels", exact: true });
  expect(await labelControls.innerText()).not.toMatch(/[\u3400-\u9fff]/);
  await page.screenshot({ path: "output/feature-expansion-2026-10-18/labeled-en.png", fullPage: true });
  await page.getByLabel("Show labels", { exact: true }).uncheck();
  await expect(page.getByLabel("Label field", { exact: true })).toHaveCount(0);
  await page.getByLabel("Color mode", { exact: true }).selectOption("single");
  await expect(page.getByLabel("Category field", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
