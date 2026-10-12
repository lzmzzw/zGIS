import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import { importCityFixture } from "./data-fixtures";

test("desktop language settings preserve cell drafts, names and native locale synchronization", async ({ page }) => {
  await installDesktopMock(page);
  await page.goto("/");
  await importCityFixture(page);
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await page.locator('tbody tr.selected td[data-field="城市"]').dblclick();
  await page.getByRole("textbox", { name: "属性 城市", exact: true }).fill("未应用的中文草稿");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("main", { name: "Application settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Appearance", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.calls.filter(call => call.command === "set_locale").at(-1)?.args.locale)).toBe("en");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Attributes 城市", exact: true })).toHaveValue("未应用的中文草稿");
  await expect(page.locator(".layer-text").filter({ hasText: "城市.geojson" })).toBeVisible();
  await expect(page.locator("tbody tr.selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface language", { exact: true }).selectOption("zh-CN");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "属性 城市", exact: true })).toHaveValue("未应用的中文草稿");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByLabel("Interface language", { exact: true })).toHaveValue("en");
  await page.getByLabel("Interface language", { exact: true }).selectOption("zh-CN");
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("界面语言", { exact: true })).toHaveValue("zh-CN");
});

test("desktop retained backend errors translate and unknown external errors remain intact", async ({ page }) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.evaluate(async () => window.__ZG_TEST__.dropFiles([], "要素 3: 无效几何"));
  await expect(page.getByRole("alert")).toContainText("要素 3: 无效几何");
  await page.getByLabel("界面语言", { exact: true }).selectOption("en");
  await expect(page.getByRole("alert")).toContainText("Feature 3: Invalid geometry");
  await page.getByLabel("Interface language", { exact: true }).selectOption("zh-CN");
  await expect(page.getByRole("alert")).toContainText("要素 3: 无效几何");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.evaluate(async () => window.__ZG_TEST__.dropFiles([], "external write failed"));
  await expect(page.getByRole("alert")).toContainText("external write failed");
});

test("mixed field summaries switch while field names matching UI phrases stay intact", async ({ page }) => {
  await installDesktopMock(page, JSON.stringify({ version: 3, layers: [{ id: "mixed", name: "mixed.geojson", features: [
    { id: "one", properties: { 文件: 1 }, geometry: { type: "Point", coordinates: [114, 30] } },
    { id: "two", properties: { 文件: "用户文本" }, geometry: { type: "Point", coordinates: [116, 40] } },
  ] }], tree: [{ kind: "layer", id: "mixed" }] }));
  await page.addInitScript(() => localStorage.setItem("zgis.locale", "en"));
  await page.goto("/");
  await page.getByRole("button", { name: "Expand attribute table", exact: true }).click();
  const field = page.locator(".attribute-panel th summary").filter({ hasText: /^文件$/ });
  await expect(field).toHaveCount(1);
  await field.click();
  await expect(page.locator(".field-info")).toContainText("Number / Text · 2 rows · 0 null values");
  await page.evaluate(() => {
    localStorage.setItem("zgis.locale", "zh-CN");
    window.dispatchEvent(new StorageEvent("storage", { key: "zgis.locale" }));
  });
  await expect(field).toHaveText("文件");
  await expect(page.locator(".field-info")).toContainText("数值 / 文本 · 2 条 · 0 空值");
  await expect(page.locator("tbody")).toContainText("用户文本");
});
