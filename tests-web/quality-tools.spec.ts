import { test, expect } from "@playwright/test";

test("清理工具通过真实导入剔除空几何并保留原图层", async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", route => route.abort());
  await page.goto("./");
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles({
    name: "quality.geojson", mimeType: "application/geo+json",
    buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [
      { type: "Feature", properties: { name: "valid" }, geometry: { type: "Point", coordinates: [114, 30, 8] } },
      { type: "Feature", properties: { name: "empty" }, geometry: null },
    ] })),
  });
  const dialog = page.getByRole("dialog", { name: "导入文件", exact: true });
  await dialog.getByRole("button", { name: "导入", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("搜索分析工具").fill("剔除");
  await box.getByRole("button", { name: "剔除空或无效几何", exact: true }).click();
  await box.getByLabel("结果图层名称").fill("cleaned");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  const result = box.getByLabel("分析结果", { exact: true });
  await expect(result).toContainText("1");
  await result.getByText("结果说明", { exact: true }).click();
  await expect(result).toContainText("移除要素");
  await expect(result).toContainText("第 2 个");
  await expect(box.getByLabel("输入图层", { exact: true }).locator('option:not([value=""])')).toHaveCount(2);
  await box.getByLabel("搜索分析工具").fill("图层摘要");
  await box.getByRole("button", { name: "图层摘要", exact: true }).click();
  await box.getByLabel("输入图层", { exact: true }).selectOption({ label: "cleaned" });
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(box.getByLabel("分析结果", { exact: true })).toContainText("点 1");
});


