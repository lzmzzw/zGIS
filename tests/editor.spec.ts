import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import { importCityFixture } from "./data-fixtures";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("GeoJSON XYZ import automatically preserves elevation", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "height.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"Feature","id":"height-1","geometry":{"type":"Point","coordinates":[116.4,39.9,0]},"properties":{}}',
    ),
  });
  const copy = page.getByLabel("height.geojson 按二维副本导入", {
    exact: true,
  });
  await expect(copy).not.toBeChecked();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-text")).toContainText("height.geojson");
  await fileAction(page, "导出 / 转换");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const saved = await download;
  const result = JSON.parse(readFileSync((await saved.path())!, "utf-8"));
  expect(result.features[0].geometry.coordinates).toEqual([116.4, 39.9, 0]);
  expect(result.features[0].id).toBe("height-1");
});

test("GeoJSON metadata import, default 4326 export and explicit projected export", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "mercator.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"EPSG:3857"}},"features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[111319.49079327357,0]},"properties":{}}]}',
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-text")).toContainText("mercator.geojson");
  await fileAction(page, "导出 / 转换");
  await expect(page.getByLabel("目标坐标系")).toHaveValue("EPSG:4326");
  await page.getByLabel("目标坐标系").selectOption("EPSG:3857");
  await expect(page.getByRole("dialog")).toContainText("传统 GeoJSON");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const file = await downloaded;
  const data = JSON.parse(readFileSync((await file.path())!, "utf-8"));
  expect(data.crs.properties.name).toBe("urn:ogc:def:crs:EPSG::3857");
  expect(data.features[0].geometry.coordinates[0]).toBeCloseTo(
    111319.49079327357,
    5,
  );
});

async function fileAction(page: Page, name: string) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function showTable(page: Page) {
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
}
async function cities(page: Page) {
  await page.goto("/");
  await importCityFixture(page);
  await showTable(page);
  await expect(page.locator("tbody tr")).toHaveCount(4);
}
async function wktEditor(page: Page) {
  const enter = page.getByRole("button", { name: "编辑", exact: true });
  if (await enter.count() && await enter.isEnabled()) await enter.click();
  await page
    .locator(".attribute-panel summary")
    .filter({ hasText: /^更多$/ })
    .click();
  await page.getByRole("button", { name: "WKT 几何…", exact: true }).click();
}

async function editCell(page: Page, field: string) {
  await page
    .locator(`.attribute-panel tbody tr.selected td[data-field="${field}"]`)
    .dblclick();
}

test("city attributes use explicit apply, independent geometry editor, undo and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await cities(page);
  await page.locator("tbody tr").first().click();
  const city = page.getByRole("textbox", { name: "属性 城市", exact: true });
  await expect(city).toHaveCount(0);
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await editCell(page, "城市");
  await city.fill("取消测试");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(city).toHaveCount(0);
  await expect(page.locator("tbody tr").first()).toContainText("北京");
  await editCell(page, "城市");
  await city.fill("北京测试");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator("tbody tr").first()).toContainText("北京测试");
  await wktEditor(page);
  await page
    .getByRole("textbox", { name: "WKT 几何", exact: true })
    .fill("POINT (117 40)");
  await page.getByRole("button", { name: "应用几何", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).toHaveValue("POINT(117 40)");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await wktEditor(page);
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).not.toHaveValue("POINT(117 40)");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await fileAction(page, "导出 / 转换");
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await (await promise).saveAs("output/smoke/export.geojson");
  await page.screenshot({ path: "output/smoke/editor-desktop.png" });
  expect(errors).toEqual([]);
});

test("CSV worker import, text codes, invalid geometry retained inside editor", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "坐标.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'code,wkt,name\r\n001,"POINT (116 40)",甲\r\n002,"POINT (117 41)",乙',
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await showTable(page);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody tr").first()).toContainText("001");
  await page.locator("tbody tr").first().click();
  await wktEditor(page);
  await page
    .getByRole("textbox", { name: "WKT 几何", exact: true })
    .fill("POINT ZM (116 40 10 5)");
  await expect(
    page.getByRole("button", { name: "应用几何", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "M/ZM",
  );
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).toHaveValue("POINT ZM (116 40 10 5)");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await fileAction(page, "导出 / 转换");
  await page.getByLabel("输出格式").selectOption("wkt");
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await (await promise).saveAs("output/smoke/export.csv");
});

test("CSV preview correction and explicit XY mode preserve rows", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "双几何.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'name,longitude,latitude,wkt\r\n甲,116,40,"POINT (117 41)"',
    ),
  });
  await expect(page.locator(".preview-table tbody tr")).toHaveCount(1);
  await page.getByLabel("几何来源", { exact: true }).selectOption("xy");
  await page.getByLabel("X / 经度列", { exact: true }).selectOption("name");
  await expect(
    page.getByRole("button", { name: "导入", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("X / 经度列", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.screenshot({ path: "output/smoke/csv-inline-error.png" });
  await page
    .getByLabel("X / 经度列", { exact: true })
    .selectOption("longitude");
  await expect(
    page.getByRole("button", { name: "导入", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: "output/smoke/csv-preview.png" });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await showTable(page);
  await page.locator(".attribute-panel tbody tr").first().click();
  await wktEditor(page);
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).toHaveValue("POINT(116 40)");
});

test("file parse errors remain in original window and export rejects non-point XY", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "三维.geojson",
    mimeType: "application/json",
    buffer: Buffer.from('{"type":"Point","coordinates":[116,40,10,5]}'),
  });
  await expect(page.getByRole("dialog")).toContainText("三维.geojson");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "XYZ",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.locator("input[type=file]").setInputFiles({
    name: "道路.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"LineString","coordinates":[[116,40],[117,41]]},"properties":{"name":"道路"}}]}',
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-text")).toContainText("道路.geojson");
  await fileAction(page, "导出 / 转换");
  await page.getByLabel("输出格式").selectOption("xy");
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "仅支持点",
  );
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: "output/smoke/export-summary.png" });
});

test("SHP ZIP is editable and save routes to conversion", async ({ page }) => {
  execFileSync("node", ["scripts/create-fixtures.mjs"]);
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles("output/smoke/fixtures/cities.zip");
  await showTable(page);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await editCell(page, "name");
  await expect(
    page.getByRole("textbox", { name: "属性 name", exact: true }),
  ).toHaveValue("北京");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑属性", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "新增点", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toBeEnabled();
  await wktEditor(page);
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).not.toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("button", { name: "应用几何", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await fileAction(page, "保存");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "output/smoke/shp-conversion.png" });
});

test("field menu protects duplicates and adds to every feature", async ({
  page,
}) => {
  await cities(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .locator("th summary")
    .filter({ hasText: /^城市$/ })
    .click();
  await page
    .locator("th .menu-items")
    .getByRole("button", { name: "添加字段", exact: true })
    .click();
  await page.getByRole("textbox", { name: "新字段名" }).fill("城市");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加字段", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("字段已存在");
  await page.getByRole("textbox", { name: "新字段名" }).fill("备注");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加字段", exact: true })
    .click();
  await expect(page.locator("th").filter({ hasText: "备注" })).toHaveCount(1);
  await expect(page.locator("tbody tr")).toHaveCount(4);
});

test("drawing completion, cancellation, vertices, deletion and undo", async ({
  page,
}) => {
  await cities(page);
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await page.getByLabel("显示底图", { exact: true }).uncheck();
  await page.getByRole("button", { name: "关闭底图面板" }).click();
  const box = await page.getByLabel("地理数据地图").boundingBox();
  if (!box) throw new Error("Map not rendered");
  const point = (x: number, y: number) => ({
    x: box.x + x * box.width,
    y: box.y + y * box.height,
  });
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "新增点", exact: true }).click();
  await page.mouse.click(point(0.4, 0.5).x, point(0.4, 0.5).y);
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await page.locator("tbody tr").last().click();
  await wktEditor(page);
  const before = await page
    .getByRole("textbox", { name: "WKT 几何", exact: true })
    .inputValue();
  expect(before).toMatch(/^POINT Z\s*\(.* 0\)$/);
  const elevated = before.replace(/ 0\)$/, " 77.5)");
  await page
    .getByRole("textbox", { name: "WKT 几何", exact: true })
    .fill(elevated);
  await page.getByRole("button", { name: "应用几何", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "编辑顶点", exact: true }).click();
  await page.mouse.move(point(0.4, 0.5).x, point(0.4, 0.5).y);
  await page.mouse.down();
  await page.mouse.move(point(0.45, 0.55).x, point(0.45, 0.55).y, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "结束顶点编辑", exact: true }).click();
  await wktEditor(page);
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).not.toHaveValue(before);
  await expect(
    page.getByRole("textbox", { name: "WKT 几何", exact: true }),
  ).toHaveValue(/ 77\.5\)$/);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "新增线", exact: true }).click();
  await page.mouse.click(point(0.3, 0.3).x, point(0.3, 0.3).y);
  await page.mouse.dblclick(point(0.6, 0.4).x, point(0.6, 0.4).y);
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "新增面", exact: true }).click();
  await page.mouse.click(point(0.3, 0.6).x, point(0.3, 0.6).y);
  await page.mouse.click(point(0.5, 0.7).x, point(0.5, 0.7).y);
  await page.mouse.click(point(0.6, 0.5).x, point(0.6, 0.5).y);
  await page.getByRole("button", { name: "完成绘制", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await expect(page.locator("tbody tr").last()).toContainText("Polygon");
  await page.getByRole("button", { name: "新增线", exact: true }).click();
  await page.mouse.click(point(0.2, 0.3).x, point(0.2, 0.3).y);
  await page.getByRole("button", { name: "取消绘制", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.getByRole("button", { name: "删除选中要素", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
});

test("single header, panels, theme persistence, resizing and canvas rendering", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".attribute-panel")).toBeVisible();
  await expect(page.locator(".table-scroll")).toHaveCount(0);
  await expect(page.locator(".inspector")).toHaveCount(0);
  await expect(page.locator(".map-empty")).toHaveCount(0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page.getByLabel("底图类型", { exact: true }).selectOption("tdt-vec");
  await expect(page.getByRole("main", { name: "后台设置" })).toContainText(
    "填写 tk 后可载入天地图",
  );
  await page.getByLabel("显示注记", { exact: true }).uncheck();
  await page.getByLabel("底图类型", { exact: true }).selectOption("osm");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
  await importCityFixture(page);
  await showTable(page);
  await page.locator("tbody tr").first().click();
  const resizer = page.getByRole("separator", { name: "调整属性表高度" });
  await resizer.focus();
  await page.keyboard.press("ArrowUp");
  await expect(resizer).toHaveAttribute("aria-valuenow", "270");
  await page.screenshot({ path: "output/smoke/redesign-light.png" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.screenshot({ path: "output/smoke/redesign-dark.png" });
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await page.getByLabel("显示底图", { exact: true }).uncheck();
  await page.getByRole("button", { name: "关闭底图面板" }).click();
  await page.waitForTimeout(250);
  const painted = await page
    .locator(".ol-layer canvas")
    .evaluateAll((canvases) =>
      canvases.some((element) => {
        const canvas = element as HTMLCanvasElement;
        try {
          const data = canvas
            .getContext("2d")
            ?.getImageData(0, 0, canvas.width, canvas.height).data;
          return data?.some((value, index) => index % 4 === 3 && value > 0);
        } catch {
          return false;
        }
      }),
    );
  expect(painted).toBeTruthy();
  for (const width of [1440, 960, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({ path: `output/smoke/redesign-${width}.png` });
  }
});

test("desktop SHP export preserves edits on cancellation, error and success", async ({
  page,
}) => {
  execFileSync("node", ["scripts/create-fixtures.mjs"]);
  await installDesktopMock(page);
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles("output/smoke/fixtures/cities.zip");
  await showTable(page);
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await editCell(page, "name");
  await page
    .getByRole("textbox", { name: "属性 name", exact: true })
    .fill("新北京");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await fileAction(page, "保存");
  await expect(page.getByRole("combobox", { name: "输出格式" })).toHaveValue(
    "shp",
  );
  await expect(page.getByRole("textbox", { name: "文件名" })).toHaveValue(
    "cities.zip",
  );
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = true;
  });
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = false;
    window.__ZG_TEST__.saveError = "字段名称不合法";
  });
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("字段名称不合法");
  await page.evaluate(() => {
    window.__ZG_TEST__.saveError = "";
  });
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const calls = await page.evaluate(() =>
    window.__ZG_TEST__.calls.filter(
      (call) => call.command === "export_shapefile",
    ),
  );
  expect(calls).toHaveLength(3);
  expect(calls[2].args.suggestedName).toBe("cities.zip");
  expect((calls[2].args.features as { type: string }[])[0].type).toBe(
    "Feature",
  );
  expect((calls[2].args.features as object[])[0]).not.toHaveProperty("id");
  expect(
    (calls[2].args.features as { properties: { name: string } }[])[0].properties
      .name,
  ).toBe("新北京");
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
