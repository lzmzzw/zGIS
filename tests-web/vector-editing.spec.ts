import { test, expect } from "@playwright/test";

test("Web 端可以编辑矢量几何并下载保存副本", async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.goto("./");
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles({
    name: "editable.geojson",
    mimeType: "application/geo+json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "original" },
            geometry: { type: "Point", coordinates: [114, 30] },
          },
        ],
      }),
    ),
  });
  await page
    .getByRole("dialog", { name: "导入文件", exact: true })
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const toolbar = page.locator(".web-map-controls");
  await expect(toolbar.getByRole("button", { name: "新增点", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "编辑顶点", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "移动要素", exact: true })).toBeVisible();

  await toolbar.getByRole("button", { name: "新增点", exact: true }).click();
  const map = page.locator(".web-map .map-surface");
  const box = await map.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.55, box!.y + box!.height * 0.45);
  await expect(page.getByRole("table", { name: "图层属性", exact: true }).getByRole("row")).toHaveCount(3);

  await toolbar.getByRole("button", { name: "保存编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "下载图层", exact: true });
  await expect(dialog).toBeVisible();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载", exact: true }).click();
  await expect(await download).toBeTruthy();
});
