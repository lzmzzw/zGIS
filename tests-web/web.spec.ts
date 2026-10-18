import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { analysisTools } from "../src/analysisTools";

const feature = (geometry: unknown, name: string) => ({
  type: "Feature",
  properties: { name, group: "A" },
  geometry,
});
const polygon = (x: number, z?: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [x, 30],
      [x + 0.02, 30],
      [x + 0.02, 30.02],
      [x, 30.02],
      [x, 30],
    ].map((p) => (z === undefined ? p : [...p, z])),
  ],
});
const collection = (features: unknown[]) =>
  JSON.stringify({ type: "FeatureCollection", features });
const input = (name: string, content: string) => ({
  name,
  mimeType: "application/octet-stream",
  buffer: Buffer.from(content),
});
const areas = input(
  "areas.geojson",
  collection([feature(polygon(114), "west"), feature(polygon(114.01), "east")]),
);
const mask = input(
  "mask.geojson",
  collection([feature(polygon(114.005), "mask")]),
);
const points = input(
  "points.geojson",
  collection([
    feature({ type: "Point", coordinates: [114.01, 30.01] }, "inside"),
  ]),
);

test.beforeEach(async ({ page }) => {
  // 地图回归使用单色瓦片，不向公共 OSM 服务批量发送自动化请求。
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
});

async function start(page: Page) {
  await page.goto("./");
  await expect(
    page.getByRole("button", { name: "导入文件", exact: true }),
  ).toBeVisible();
}
async function load(page: Page, files: Parameters<Page["setInputFiles"]>[1]) {
  await page.getByLabel("选择空间文件").setInputFiles(files);
  const dialog = page.getByRole("dialog", { name: "导入文件" });
  await expect(dialog).toBeVisible();
  const submit = dialog.getByRole("button", { name: "导入", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
}
async function choose(page: Page, id: string) {
  const tool = analysisTools.find((item) => item.id === id)!;
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("搜索分析工具").fill(tool.label);
  await box.getByRole("button", { name: tool.label, exact: true }).click();
  return box;
}
async function exportJson(page: Page) {
  await page.getByRole("button", { name: "下载图层", exact: true }).click();
  await page.getByLabel("输出格式").selectOption("geojson");
  await page.getByLabel("目标坐标系").selectOption("EPSG:4326");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "下载", exact: true })
    .click();
  const download = await downloading;
  const content = await readFile((await download.path())!, "utf8");
  return JSON.parse(content);
}

test("子目录静态部署：本地导入、样式、属性选择、底图与独立导出", async ({
  page,
}) => {
  const errors: string[] = [];
  const failedAssets: string[] = [];
  const uploads: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("127.0.0.1") && !response.ok())
      failedAssets.push(response.url());
  });
  page.on("request", (request) => {
    if (request.method() !== "GET") uploads.push(request.url());
  });
  await start(page);
  await expect(
    page.getByRole("button", { name: /数据库|Agent|MCP|终端/ }),
  ).toHaveCount(0);
  await expect(page.locator(".web-attribution")).toContainText("OpenStreetMap");
  await load(page, [areas, mask]);
  await expect(page.getByLabel("areas.geojson 显示")).toBeChecked();
  await page.getByLabel("areas.geojson 显示").uncheck();
  await expect(page.getByLabel("areas.geojson 显示")).not.toBeChecked();
  await page.getByLabel("areas.geojson 显示").check();
  await page.getByLabel("areas.geojson 颜色").fill("#ff0000");
  await page.getByLabel("areas.geojson 定位").click();
  await page
    .getByRole("button", { name: "areas.geojson", exact: true })
    .click();
  await expect(page.getByRole("table", { name: "图层属性" })).toContainText(
    "west",
  );
  await page.getByLabel("搜索属性").fill("east");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await page.getByRole("row").filter({ hasText: "east" }).click();
  await page.getByLabel("搜索属性").fill("");
  await page.getByLabel("底图", { exact: true }).selectOption("none");
  await page.getByLabel("底图", { exact: true }).selectOption("osm");
  const exported = await exportJson(page);
  expect(exported.features).toHaveLength(2);
  expect(exported.features[0].properties.name).toBe("west");
  await page.screenshot({
    path: "output/web-0.4.0/web-workspace.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  expect(failedAssets).toEqual([]);
  expect(uploads).toEqual([]);
});

test("真实 WASM：所有已开放工具与分析结果继续分析", async ({ page }) => {
  test.setTimeout(180000);
  await start(page);
  await load(page, [areas, mask, points]);
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
  for (const tool of analysisTools) {
    const box = await choose(page, tool.id);
    await box
      .getByLabel("输入图层", { exact: true })
      .selectOption({ label: "areas.geojson" });
    if (tool.requiresTarget)
      await box
        .getByLabel("目标图层", { exact: true })
        .selectOption({
          label: tool.id === "count_points" ? "points.geojson" : "mask.geojson",
        });
    if (tool.parameters.includes("distanceMeters"))
      await box.getByLabel("缓冲距离（米）").fill("100");
    if (tool.parameters.includes("toleranceMeters"))
      await box.getByLabel("简化容差（米）").fill("1");
    if (!tool.report)
      await box.getByLabel("结果图层名称").fill(`result_${tool.id}`);
    await expect(
      box.getByRole("button", { name: "运行分析", exact: true }),
    ).toBeEnabled();
    await box.getByRole("button", { name: "运行分析", exact: true }).click();
    await expect(box.getByLabel("分析结果", { exact: true })).toBeVisible();
    await expect(box).toContainText("分析完成");
    if (!tool.report)
      await expect(
        page.getByRole("button", { name: `result_${tool.id}`, exact: true }),
      ).toBeVisible();
  }
  // 分析输出仍可作为下一步输入，原始文件图层保留。
  const box = await choose(page, "buffer");
  await box
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "result_centroid" });
  await box.getByLabel("结果图层名称").fill("centroid_buffer");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "centroid_buffer", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "result_intersection", exact: true })
    .click();
  const result = await exportJson(page);
  expect(result.features).toHaveLength(2);
  for (const item of result.features) {
    expect(item.properties.target_name).toBe("mask");
    const coordinates = item.geometry.coordinates
      .flat(3)
      .filter((v: unknown) => typeof v === "number");
    expect(coordinates.length).toBeGreaterThan(5);
  }
  await expect(
    page.getByRole("button", { name: "areas.geojson", exact: true }),
  ).toBeVisible();
});

test("CSV WKT/XY 配置、XYZ 分析保留与无效文件恢复", async ({ page }) => {
  await start(page);
  await load(page, input("xy.csv", "name,x,y\n中文,114.01,30.01"));
  await expect(page.getByRole("table")).toContainText("中文");
  await load(
    page,
    input("wkt.csv", 'name,wkt\nheight,"POINT Z (114.01 30.01 88)"'),
  );
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
  const box = await choose(page, "geometry_attributes");
  await box
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "wkt.csv" });
  await box.getByLabel("结果图层名称").fill("xyz_result");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "xyz_result", exact: true }),
  ).toBeVisible();
  const result = await exportJson(page);
  expect(result.features[0].geometry.coordinates).toEqual([114.01, 30.01, 88]);
  await page
    .getByLabel("选择空间文件")
    .setInputFiles(input("bad.geojson", "{bad"));
  const dialog = page.getByRole("dialog", { name: "导入文件" });
  await dialog.getByRole("button", { name: "导入", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "xyz_result", exact: true }),
  ).toBeVisible();
});

test("SHP ZIP 下载与重新导入保持几何、中文属性和 CRS", async ({ page }) => {
  await start(page);
  await load(
    page,
    input(
      "中文点.geojson",
      collection([
        feature({ type: "Point", coordinates: [114.01, 30.01] }, "武汉"),
      ]),
    ),
  );
  await page.getByRole("button", { name: "下载图层", exact: true }).click();
  await page.getByLabel("输出格式").selectOption("shp");
  await page.getByLabel("文件名").fill("points");
  await page.getByLabel("目标坐标系").selectOption("EPSG:3857");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "下载", exact: true })
    .click();
  const download = await downloading;
  const archive = await readFile((await download.path())!);
  expect(archive.subarray(0, 2).toString()).toBe("PK");
  await load(page, {
    name: "points.zip",
    mimeType: "application/zip",
    buffer: archive,
  });
  await expect(page.getByRole("table")).toContainText("武汉");
  const result = await exportJson(page);
  expect(result.features[0].geometry.coordinates[0]).toBeCloseTo(114.01, 8);
  expect(result.features[0].geometry.coordinates[1]).toBeCloseTo(30.01, 8);
  expect(result.features[0].properties.name).toBe("武汉");
});

test("真实分析 Worker 取消后释放资源并可重新分析", async ({ page }) => {
  await start(page);
  const many = Array.from({ length: 9000 }, (_, i) =>
    feature(
      {
        type: "Point",
        coordinates: [
          114 + (i % 100) * 0.0001,
          30 + Math.floor(i / 100) * 0.0001,
        ],
      },
      String(i),
    ),
  );
  await load(page, input("many.geojson", collection(many)));
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
  const box = await choose(page, "buffer");
  await box.getByLabel("缓冲距离（米）").fill("100");
  await box.getByLabel("结果图层名称").fill("cancelled_result");
  // 暂缓首个实际 WASM 资源响应，使取消阶段确定，不依赖机器计算速度。
  let releaseWasm!: () => void;
  let sawWasm!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseWasm = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    sawWasm = resolve;
  });
  await page.route(
    "**/*.wasm",
    async (route) => {
      sawWasm();
      await gate;
      await route.continue().catch(() => {});
    },
    { times: 1 },
  );
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await requested;
  await page.getByRole("button", { name: "取消当前操作", exact: true }).click();
  releaseWasm();
  await expect(box).toContainText("分析已取消");
  await expect(
    page.getByRole("button", { name: "cancelled_result", exact: true }),
  ).toHaveCount(0);
  await choose(page, "layer_summary");
  await box.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(box.getByLabel("分析结果", { exact: true })).toBeVisible();
  await expect(box).toContainText("9,000");
});
