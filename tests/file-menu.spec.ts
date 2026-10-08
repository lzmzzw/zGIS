import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function menu(page: Page) {
  const menu = page
    .locator(".app-header .header-menu")
    .filter({ has: page.locator("summary", { hasText: /^文件$/ }) });
  await menu.locator("summary").click();
  return menu;
}

test("file menu contains only four actions and projected GeoJSON save-as preserves format", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  const empty = await menu(page);
  await expect(empty.locator("button")).toHaveText([
    "新建矢量图层",
    "打开文件",
    "另存为",
    "导出为",
  ]);
  await expect(empty.locator("hr")).toHaveCount(1);
  await expect(
    empty.getByRole("button", { name: "另存为", exact: true }),
  ).toBeDisabled();
  await empty.locator("summary").click();
  await page.locator("input[type=file]").setInputFiles({
    name: "projected.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        crs: { type: "name", properties: { name: "EPSG:3857" } },
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [111319.49079327357, 0] },
            properties: { name: "甲" },
          },
        ],
      }),
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await (
    await menu(page)
  )
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  await expect(page.locator(".operation-status")).toContainText("保存完成");
  const saved = await page.evaluate(() =>
    window.__ZG_TEST__.calls.filter((c) => c.command === "save_file").at(-1)!,
  );
  expect(saved.args.suggestedName).toBe("projected.json");
  expect(saved.args.preserveExtension).toBe("json");
  expect(saved.args.overwrite).toBe(false);
  const content = JSON.parse(String(saved.args.content));
  expect(content.crs.properties.name).toBe("urn:ogc:def:crs:EPSG::3857");
  expect(content.features[0].geometry.coordinates[0]).toBeCloseTo(
    111319.49079327357,
  );
});

test("CSV save-as keeps WKT columns and SHP save-as uses a folder without an export dialog", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "points.csv",
      mimeType: "text/csv",
      buffer: Buffer.from('name,wkt\n甲,"POINT (116 40)"'),
    });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await (
    await menu(page)
  )
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  await expect(page.locator(".operation-status")).toContainText("保存完成");
  const csv = await page.evaluate(() =>
    window.__ZG_TEST__.calls.filter((c) => c.command === "save_file").at(-1)!,
  );
  expect(csv.args.suggestedName).toBe("points.csv");
  expect(csv.args.preserveExtension).toBe("csv");
  expect(String(csv.args.content)).toMatch(/POINT\s*\(116 40\)/);
  await page
    .locator("input[type=file]")
    .setInputFiles("output/smoke/fixtures/cities.zip");
  await expect(page.locator(".layer-text")).toHaveCount(2);
  await page
    .locator(".layer-text")
    .filter({ hasText: /^cities$/ })
    .click();
  await (
    await menu(page)
  )
    .getByRole("button", { name: "另存为", exact: true })
    .click();
  await expect(page.locator(".operation-status")).toContainText(
    "另存完成：SHP 文件组",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const shp = await page.evaluate(() =>
    window.__ZG_TEST__.calls
      .filter((c) => c.command === "save_shapefile_folder")
      .at(-1)!,
  );
  expect(shp.args.suggestedName).toBe("cities.shp");
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.filter((c) => c.command === "export_shapefile"),
    ),
  ).toHaveLength(0);
});
