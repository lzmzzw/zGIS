import { test, expect } from "@playwright/test";
test("configured services stay single-select, toggle preserves selection and vector layers remain above tiles", async ({
  page,
}) => {
  await page.goto("/");
  const tile = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const context = c.getContext("2d")!;
    context.fillStyle = "#527286";
    context.fillRect(0, 0, 256, 256);
    return c.toDataURL().split(",")[1];
  });
  const requests: string[] = [];
  await page.route("**/t0.tianditu.gov.cn/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(tile, "base64"),
    });
  });
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.locator(".layers-panel select")).toHaveCount(0);
  await expect(page.locator(".ol-attribution")).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page.getByLabel("天地图 tk").fill("ui-test-placeholder");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(3);
  await page
    .locator(".basemap-card")
    .filter({
      has: page.getByRole("radio", { name: "天地图 · 影像", exact: true }),
    })
    .click();
  await expect(
    page.getByRole("radio", { name: "天地图 · 影像", exact: true }),
  ).toBeChecked();
  await expect
    .poll(() => requests.some((url) => url.includes("LAYER=img")))
    .toBe(true);
  await expect
    .poll(() => requests.some((url) => url.includes("LAYER=cia")))
    .toBe(true);
  await page.getByLabel("显示底图", { exact: true }).uncheck();
  await page
    .locator(".basemap-card")
    .filter({
      has: page.getByRole("radio", { name: "天地图 · 矢量", exact: true }),
    })
    .click();
  await expect(page.getByLabel("显示底图", { exact: true })).not.toBeChecked();
  await expect(
    page.getByRole("radio", { name: "天地图 · 矢量", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: "天地图 · 影像", exact: true }),
  ).not.toBeChecked();
  await page.getByLabel("显示底图", { exact: true }).check();
  await expect
    .poll(() => requests.some((url) => url.includes("LAYER=vec")))
    .toBe(true);
  await expect
    .poll(() => requests.some((url) => url.includes("LAYER=cva")))
    .toBe(true);
  await page.screenshot({ path: "output/smoke/basemap-configured.png" });
  await page.keyboard.press("Escape");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^数据$/ })
    .click();
  await page.getByRole("button", { name: "城市示例", exact: true }).click();
  const color = await page
    .locator(".layer-swatch")
    .evaluate((el) =>
      getComputedStyle(el)
        .backgroundColor.match(/\d+/g)!
        .slice(0, 3)
        .map(Number),
    );
  const hasBusinessPixels = async () => {
    const png = await page.locator(".map-surface").screenshot();
    return page.evaluate(
      async ({ data, color }) => {
        const image = new Image();
        image.src = data;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] === color[0] &&
            pixels[i + 1] === color[1] &&
            pixels[i + 2] === color[2]
          )
            return true;
        return false;
      },
      { data: "data:image/png;base64," + png.toString("base64"), color },
    );
  };
  await expect.poll(hasBusinessPixels).toBe(true);
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await page.getByLabel("显示底图", { exact: true }).uncheck();
  await expect.poll(hasBusinessPixels).toBe(true);
  await expect(page.locator(".layer-text")).toContainText("中国城市");
  await page.getByLabel("显示底图", { exact: true }).check();
  await expect.poll(hasBusinessPixels).toBe(true);
  await page.setViewportSize({ width: 960, height: 640 });
  await page
    .locator(".header-actions")
    .getByRole("button", { name: "属性表", exact: true })
    .click();
  await page.locator(".layer-row").click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  const mapBounds = await page.locator(".map-container").boundingBox();
  const panelBounds = await page
    .getByRole("region", { name: "底图服务" })
    .boundingBox();
  expect(panelBounds!.x).toBeGreaterThanOrEqual(mapBounds!.x);
  expect(panelBounds!.y).toBeGreaterThanOrEqual(mapBounds!.y);
  expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(
    mapBounds!.x + mapBounds!.width,
  );
  expect(panelBounds!.y + panelBounds!.height).toBeLessThanOrEqual(
    mapBounds!.y + mapBounds!.height,
  );
  await page.screenshot({
    path: "output/smoke/basemap-minimum-with-panels.png",
  });
  await page.getByRole("button", { name: "关闭底图面板" }).click();
  await expect(
    page.getByRole("button", { name: "底图", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page.getByLabel("天地图 tk").fill("");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(1);
  await expect(
    page.getByRole("radio", { name: "OpenStreetMap", exact: true }),
  ).toBeChecked();
});
