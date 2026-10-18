import { test, expect, type Locator } from "@playwright/test";

test("真实 WASM 缓冲结果说明与图层提示支持中英切换", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // 地图回归使用单色瓦片，不向公共 OSM 服务发送批量请求。
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
    name: "source.geojson",
    mimeType: "application/geo+json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "one" },
            geometry: { type: "Point", coordinates: [114, 30] },
          },
          {
            type: "Feature",
            properties: { name: "two" },
            geometry: { type: "Point", coordinates: [114.01, 30.01] },
          },
        ],
      }),
    ),
  });
  const importing = page.getByRole("dialog", { name: "导入文件", exact: true });
  await importing.getByRole("button", { name: "导入", exact: true }).click();
  await expect(importing).toBeHidden();
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("搜索分析工具").fill("缓冲区");
  await box.getByRole("button", { name: "缓冲区", exact: true }).click();
  await box
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "source.geojson" });
  await box.getByLabel("缓冲距离（米）").fill("100");
  await box.getByLabel("结果图层名称").fill("buffer_result");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(box.getByLabel("分析结果", { exact: true })).toBeVisible();

  const details = box.locator(".processing-explanation");
  const row = (label: string): Locator =>
    details
      .locator(".processing-detail-row")
      .filter({
        has: page.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }),
      })
      .locator("dd");
  await expect(row("输入范围")).toHaveText("当前已加载要素");
  await expect(row("输入要素")).toHaveText("2");
  await expect(row("输出要素")).toHaveText("2");
  await expect(row("计算模型")).toHaveText("局部等距圆柱近似");
  await expect(row("距离单位")).toHaveText("米");
  await expect(row("缓冲距离（米）")).toHaveText("100");
  await expect(details).toContainText("不用于高精度测量");

  const resultLayer = page.locator(".web-layer").filter({
    has: page.getByRole("button", { name: "buffer_result", exact: true }),
  });
  await resultLayer.locator("summary").filter({ hasText: "图层提示" }).click();
  const notes = resultLayer.locator("details:not(.web-layer-display)");
  await expect(notes).toContainText("计算模型：局部等距圆柱近似");
  await expect(notes).toContainText("距离单位：米");
  await expect(notes).toContainText("不用于高精度测量");
  await details.locator("p").last().scrollIntoViewIfNeeded();
  await expect(details.locator("p").last()).toBeInViewport();
  await row("计算模型").scrollIntoViewIfNeeded();
  await expect(row("计算模型")).toBeInViewport();
  await page.screenshot({
    path: "output/rustgis-optimization-2026-10-18/analysis-explanation-zh.png",
    fullPage: true,
  });

  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await expect(row("Input features")).toHaveText("2");
  await expect(row("Output features")).toHaveText("2");
  await expect(row("Calculation model")).toHaveText(
    "Local equirectangular approximation",
  );
  await expect(row("Distance unit")).toHaveText("metres");
  // 参数标签含括号，直接按已知行的文字匹配，避免把文案当成正则表达式。
  await expect(
    details
      .locator(".processing-detail-row")
      .filter({ hasText: "Buffer distance (metres)" })
      .locator("dd"),
  ).toHaveText("100");
  await expect(notes).toContainText(
    "Calculation model: Local equirectangular approximation",
  );
  await expect(notes).toContainText("Distance unit: metres");
  expect(await details.innerText()).not.toMatch(/[\u3400-\u9fff]/);
  expect(await notes.innerText()).not.toMatch(/[\u3400-\u9fff]/);
  await details.locator("p").last().scrollIntoViewIfNeeded();
  await expect(details.locator("p").last()).toBeInViewport();
  await row("Calculation model").scrollIntoViewIfNeeded();
  await expect(row("Calculation model")).toBeInViewport();
  await page.screenshot({
    path: "output/rustgis-optimization-2026-10-18/analysis-explanation-en.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
