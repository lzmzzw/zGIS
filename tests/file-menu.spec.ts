import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

async function dropFile(page: Page, name: string, buffer: Buffer) {
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeEnabled();
  await page.evaluate(
    async ({ name, bytes }) => {
      await window.__ZG_TEST__.dropFiles([
        {
          name,
          bytes,
          sourceId: `source-${name}`,
          sourcePath: `F:/test/${name}`,
          sourceHash: `hash-${name}`,
        },
      ]);
    },
    { name, bytes: Array.from(buffer) },
  );
  await expect(
    page.locator(".layer-text").filter({ hasText: name.replace(/\.zip$/, "") }),
  ).toBeVisible();
}

async function menu(page: Page) {
  const menu = page
    .locator(".app-header .header-menu")
    .filter({ has: page.locator("summary", { hasText: /^文件$/ }) });
  await menu.locator("summary").click();
  return menu;
}

test("file menu includes GDB import and projected GeoJSON save-as preserves format", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  const empty = await menu(page);
  await expect(empty.locator("button")).toHaveText([
    "新建",
    "打开",
    "打开 GDB…",
    "另存为",
    "导出为",
  ]);
  await expect(empty.locator("hr")).toHaveCount(1);
  await expect(
    empty.getByRole("button", { name: "另存为", exact: true }),
  ).toBeDisabled();
  await empty.locator("summary").click();
  await dropFile(
    page,
    "projected.json",
    Buffer.from(
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
  );
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
  expect(saved.args.content).toBeNull();
  expect(typeof saved.args.transferId).toBe("string");
  const content = JSON.parse(String(saved.resolvedContent));
  expect(content.crs.properties.name).toBe("urn:ogc:def:crs:EPSG::3857");
  expect(content.features[0].geometry.coordinates[0]).toBeCloseTo(
    111319.49079327357,
  );
});

test("CSV save-as keeps WKT columns and SHP save-as uses a folder without an export dialog", async ({
  page,
}) => {
  // 独立生成夹具，避免并行运行时依赖 editor.spec.ts 的执行顺序。
  execFileSync("node", ["scripts/create-fixtures.mjs", "output/file-menu/fixtures"]);
  await installDesktopMock(page);
  await page.goto("/");
  await dropFile(
    page,
    "points.csv",
    Buffer.from('name,wkt\n甲,"POINT (116 40)"'),
  );
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
  expect(String(csv.resolvedContent)).toMatch(/POINT\s*\(116 40\)/);
  await dropFile(
    page,
    "cities.zip",
    readFileSync("output/file-menu/fixtures/cities.zip"),
  );
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
