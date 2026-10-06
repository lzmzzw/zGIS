import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test("native drop auto imports multiple layers with CRS and elevation", async ({page}) => {
 await installDesktopMock(page); await page.goto("/");
 await expect(page.locator(".app")).toBeVisible();
 await page.waitForFunction(() => (window as any).__ZG_TEST__.calls.some((c:any) => c.command === "plugin:event|listen" && c.args.event === "gis-files-dropped"));
 await page.evaluate(async () => {
  await (window as any).__ZG_TEST__.dropFiles([
   {name:"height.geojson",sourceId:"drop-source",bytes:Array.from(new TextEncoder().encode(JSON.stringify({type:"Feature",geometry:{type:"Point",coordinates:[116,40,123.5]},properties:{}})))},
   {name:"projected.geojson",sourceId:"projected-source",bytes:Array.from(new TextEncoder().encode(JSON.stringify({type:"Feature",crs:{type:"name",properties:{name:"EPSG:3857"}},geometry:{type:"Point",coordinates:[111319.49079327357,0,7]},properties:{}})))},
  ]);
 });
 await expect(page.locator(".layer-row")).toHaveCount(2);
 await expect(page.getByRole("dialog")).toHaveCount(0);
 await expect(page.locator(".operation-status")).toContainText("已载入 2 个要素");
});
test("failed dropped CSV remains in import panel for correction", async ({page}) => {
 await installDesktopMock(page); await page.goto("/");
 await page.waitForFunction(() => (window as any).__ZG_TEST__.calls.some((c:any) => c.args.event === "gis-files-dropped"));
 await page.evaluate(async () => (window as any).__ZG_TEST__.dropFiles([{name:"custom.csv",bytes:Array.from(new TextEncoder().encode("east,north\n116,40"))}]));
 await expect(page.getByRole("dialog")).toBeVisible();
 await expect(page.getByRole("dialog")).toContainText("custom.csv");
 await expect(page.locator(".layer-row")).toHaveCount(0);
});
test("native drop errors do not add layers", async ({page}) => {
 await installDesktopMock(page); await page.goto("/");
 await page.waitForFunction(() => (window as any).__ZG_TEST__.calls.some((c:any) => c.args.event === "gis-files-dropped"));
 await page.evaluate(async () => (window as any).__ZG_TEST__.dropFiles([], "请拖入矢量文件，不支持目录"));
 await expect(page.getByRole("alert")).toContainText("不支持目录");
 await expect(page.locator(".layer-row")).toHaveCount(0);
});
