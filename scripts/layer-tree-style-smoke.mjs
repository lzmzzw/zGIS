import { expect } from "@playwright/test";

export async function layerTreeStyleSmoke(page, restoring = false) {
  const alias = "图层树恢复测试";
  const width = page.getByRole("separator", { name: "调整图层栏宽度", exact: true });
  if (restoring) {
    await expect(page.locator('[data-node-kind="layer"] .layer-text')).toContainText(alias);
    await expect(width).toHaveAttribute("aria-valuenow", "360");
    await expect(page.getByRole("button", { name: `${alias}样式`, exact: true })).toBeVisible();
    console.log("PASS: native restart preserves display alias and layer panel width");
    return;
  }
  const layer = page.locator('[data-node-kind="layer"]');
  const sourceName = await layer.locator(".layer-text strong").getAttribute("title");
  const checkbox = layer.getByRole("checkbox");
  await checkbox.uncheck(); await expect(checkbox).not.toBeChecked();
  await checkbox.check(); await expect(checkbox).toBeChecked();
  await expect(layer.locator(".layer-swatch-point")).toBeVisible();
  await page.getByRole("button", { name: `${sourceName}样式`, exact: true }).click();
  await page.getByLabel(`${sourceName}颜色`, { exact: true }).fill("#cc7733");
  await page.getByRole("button", { name: "应用样式", exact: true }).click();
  await layer.click({ button: "right" });
  await page.getByRole("menuitem", { name: "设置别名", exact: true }).click();
  await page.getByLabel("图层别名", { exact: true }).fill(alias);
  await page.getByRole("button", { name: "确定", exact: true }).click();
  await expect(layer.locator(".layer-text")).toContainText(alias);
  await page.locator(".app-header summary").filter({ hasText: /^文件$/ }).click();
  await page.getByRole("button", { name: "导出为", exact: true }).click();
  await page.getByLabel("输出格式", { exact: true }).selectOption("geojson");
  await expect(page.getByLabel("文件名", { exact: true })).toHaveValue(alias + ".geojson");
  await page.keyboard.press("Escape");
  const handle = await width.boundingBox();
  await page.mouse.move(handle.x + 2, handle.y + 160);
  await page.mouse.down(); await page.mouse.move(360, handle.y + 160, { steps: 10 }); await page.mouse.up();
  await expect(width).toHaveAttribute("aria-valuenow", "360");
  await width.focus(); await page.keyboard.press("ArrowRight");
  await expect(width).toHaveAttribute("aria-valuenow", "380");
  await page.keyboard.press("ArrowLeft");
  await page.screenshot({ path: "output/desktop/layer-tree-style.png" });
  console.log("PASS: native layer checkboxes, sole style symbol entry, display-only rename and pointer/keyboard width resize");
}
