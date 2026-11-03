import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function load(page: Page, count: number) {
  await page.route("https://tile.openstreetmap.org/**", route => route.abort());
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "large-points.geojson", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: Array.from({ length: count }, (_, i) => ({
      type: "Feature", id: String(i), geometry: { type: "Point", coordinates: [100 + i % 1000 / 1000, 30 + Math.floor(i / 1000) / 1000, i] },
      properties: { name: `feature-${i}`, group: "all", value: i },
    })) })),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-row")).toHaveCount(1);
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
}

test("100000点完整显示，快速搜索只显示最新查询并可定位末段要素", async ({ page }) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await load(page, 100000);
  const search = page.getByRole("textbox", { name: "搜索属性", exact: true });
  await search.fill("feature-1");
  await search.fill("feature-99999");
  await expect(search).toHaveAttribute("aria-busy", "false");
  const rows = page.locator(".attribute-panel tbody tr");
  await expect(rows).toHaveCount(1, { timeout: 45000 });
  await expect(rows.first()).toContainText("feature-99999");
  await rows.first().dblclick();
  await expect(page.locator(".map-surface")).toHaveAttribute("aria-busy", "false", { timeout: 45000 });
  await search.fill("");
  await expect(rows).toHaveCount(100);
  await expect(page.locator(".pagination")).toContainText("1000");
  await page.locator(".map-surface").click({ position: { x: 300, y: 180 } });
  expect(errors).toEqual([]);
  await page.screenshot({ path: "output/performance-20261103/100k-points.png" });
});

test("大图层搜索结果的后续分页编辑和Tab提交保留记录与焦点", async ({ page }) => {
  await installDesktopMock(page);
  await load(page, 10000);
  const search = page.getByRole("textbox", { name: "搜索属性", exact: true });
  await search.fill("all");
  await expect(search).toHaveAttribute("aria-busy", "false");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator(".pagination")).toContainText("2 / 100");
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  const cell = page.locator('tbody tr').first().locator('td[data-field="value"]');
  await cell.dblclick();
  const input = page.getByLabel("属性 value", { exact: true });
  await input.fill("12345");
  await input.press("Tab");
  await expect(search).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".pagination")).toContainText("2 / 100");
  await expect(page.locator('tbody tr.selected td[data-field="value"]')).toHaveText("12345");
  await expect(page.locator('tbody tr.selected td[data-field="value"]')).toBeFocused();
});
