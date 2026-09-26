import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
test("city attributes, geometry, undo, export and viewport", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "城市示例", exact: true })
    .first()
    .click();
  await expect(page.locator("tbody tr")).toHaveCount(4);
  await page.locator("tbody tr").first().click();
  await page
    .getByRole("textbox", { name: "属性 城市", exact: true })
    .fill("北京测试");
  await expect(page.locator("tbody tr").first()).toContainText("北京测试");
  await page.getByRole("textbox", { name: "WKT 几何" }).fill("POINT (117 40)");
  await page.getByRole("button", { name: "应用几何" }).click();
  await expect(page.getByRole("textbox", { name: "WKT 几何" })).toHaveValue(
    "POINT(117 40)",
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "WKT 几何" })).not.toHaveValue(
    "POINT(117 40)",
  );
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.getByRole("button", { name: "导出 / 转换", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs("output/smoke/export.geojson");
  await page.screenshot({ path: "output/smoke/editor-desktop.png" });
  await page.setViewportSize({ width: 960, height: 640 });
  await page.screenshot({ path: "output/smoke/editor-compact.png" });
  expect(errors).toEqual([]);
});
test("CSV worker import, projection and invalid geometry", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "坐标.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'code,wkt,name\r\n001,"POINT (116 40)",甲\r\n002,"POINT (117 41)",乙',
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody tr").first()).toContainText("001");
  await page.locator("tbody tr").first().click();
  await page
    .getByRole("textbox", { name: "WKT 几何" })
    .fill("POINT Z (116 40 10)");
  await page.getByRole("button", { name: "应用几何" }).click();
  await expect(page.getByRole("alert")).toContainText("二维");
  await page.getByRole("button", { name: "关闭错误" }).click();
  await page.getByRole("button", { name: "导出 / 转换", exact: true }).click();
  await page.getByLabel("输出格式").selectOption("wkt");
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await (await promise).saveAs("output/smoke/export.csv");
});
test("SHP ZIP, source ID and duplicate field protection", async ({ page }) => {
  execFileSync("node", ["scripts/create-fixtures.mjs"]);
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .setInputFiles("output/smoke/fixtures/cities.zip");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("tbody tr").first()).toContainText("北京");
  await page.locator("tbody tr").first().click();
  await page.getByRole("textbox", { name: "新字段名" }).fill("name");
  await page.getByRole("button", { name: "添加字段", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("字段已存在");
  await expect(
    page.getByRole("textbox", { name: "属性 name", exact: true }),
  ).toHaveValue("北京");
  await page.getByRole("button", { name: "关闭错误" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: "output/smoke/shp-conversion.png" });
});
test("map point, line and polygon drawing with deletion and undo", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "城市示例", exact: true })
    .first()
    .click();
  await page.getByLabel("底图", { exact: true }).selectOption("none");
  const map = page.getByLabel("地理数据地图");
  const box = await map.boundingBox();
  if (!box) throw new Error("Map not rendered");
  const point = (x: number, y: number) => ({
    x: box.x + x * box.width,
    y: box.y + y * box.height,
  });
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "新增点", exact: true }).click();
  await page.mouse.click(point(0.4, 0.5).x, point(0.4, 0.5).y);
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await page.locator("tbody tr").last().click();
  const before = await page
    .getByRole("textbox", { name: "WKT 几何" })
    .inputValue();
  await page.getByRole("button", { name: "编辑顶点", exact: true }).click();
  await page.mouse.move(point(0.4, 0.5).x, point(0.4, 0.5).y);
  await page.mouse.down();
  await page.mouse.move(point(0.45, 0.55).x, point(0.45, 0.55).y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole("textbox", { name: "WKT 几何" })).not.toHaveValue(
    before,
  );
  await page.getByRole("button", { name: "新增线", exact: true }).click();
  await page.mouse.click(point(0.3, 0.3).x, point(0.3, 0.3).y);
  await page.mouse.dblclick(point(0.6, 0.4).x, point(0.6, 0.4).y);
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await expect(page.locator("tbody tr").last()).toContainText("LineString");
  await page.getByRole("button", { name: "新增面", exact: true }).click();
  await page.mouse.click(point(0.3, 0.6).x, point(0.3, 0.6).y);
  await page.mouse.click(point(0.5, 0.7).x, point(0.5, 0.7).y);
  await page.mouse.dblclick(point(0.6, 0.5).x, point(0.6, 0.5).y);
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await expect(page.locator("tbody tr").last()).toContainText("Polygon");
  await page.getByRole("button", { name: "删除选中要素", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(6);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
});
