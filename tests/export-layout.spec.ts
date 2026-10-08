import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import { importCityFixture } from "./data-fixtures";

for (const theme of ["dark", "light"]) {
  test(`compact export keeps labels and controls aligned (${theme})`, async ({
    page,
  }) => {
    await installDesktopMock(page);
    await page.goto("/");
    await importCityFixture(page);
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    await page
      .locator(".app-header summary")
      .filter({ hasText: /^文件$/ })
      .click();
    await page.getByRole("button", { name: "导出为", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(".export-source")).toContainText(
      "城市.geojson",
    );
    await expect(dialog).not.toContainText("4 个要素 · Point");
    await expect(dialog).not.toContainText("导出时选择保存位置");
    await expect(dialog).not.toContainText("导出摘要");
    const width = (await dialog.boundingBox())!.width;
    expect(width).toBeLessThanOrEqual(562);
    const controls = await dialog
      .locator(".export-fields select, .export-fields input")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        }),
      );
    for (let i = 1; i < controls.length; i++) {
      expect(controls[i].x).toBeCloseTo(controls[0].x, 0);
      expect(controls[i].y).toBeGreaterThan(
        controls[i - 1].y + controls[i - 1].height,
      );
    }
    await page.getByLabel("目标坐标系").selectOption("EPSG:3857");
    await expect(dialog.getByText(/传统 GeoJSON/)).toBeVisible();
    await page.getByLabel("输出格式").selectOption("shp");
    await expect(dialog.locator(".export-limits")).not.toHaveAttribute(
      "open",
      "",
    );
    await dialog.getByText("Shapefile 格式限制", { exact: true }).click();
    await expect(dialog.getByText(/15 位有效数字/)).toBeVisible();
    await page.getByLabel("输出格式").selectOption("postgis");
    await expect(page.getByLabel("Schema")).toBeVisible();
    await expect(page.getByLabel("新表名")).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText("请先连接数据库");
    await expect(
      dialog.getByRole("button", { name: "导出", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("输出格式").selectOption("geojson");
    await page.getByLabel("文件名").fill("");
    await expect(dialog.getByRole("alert")).toContainText("请填写文件名");
    await page.getByLabel("文件名").fill("紧凑单栏导出.geojson");
    await page.screenshot({ path: `output/export-layout-${theme}.png` });
    await page.setViewportSize({ width: 400, height: 900 });
    await expect(dialog.locator(".file-export")).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}
