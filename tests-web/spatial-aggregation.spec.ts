import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("空间关联可选汇总目标字段，保留旧默认与无匹配语义", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("./");
  const source = [
    {
      type: "Feature",
      properties: { sourceOnly: "A", total: 99 },
      geometry: { type: "Point", coordinates: [114, 30, 9] },
    },
    {
      type: "Feature",
      properties: { sourceOnly: "B", total_: 88 },
      geometry: { type: "Point", coordinates: [115, 30, 10] },
    },
  ];
  const targets = [
    {
      type: "Feature",
      properties: { amount: 2 },
      geometry: { type: "Point", coordinates: [114, 30] },
    },
    {
      type: "Feature",
      properties: { amount: 4 },
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [114, 30],
          [114, 30],
        ],
      },
    },
  ];
  await page.getByLabel("选择空间文件", { exact: true }).setInputFiles(
    [
      ["source.geojson", source],
      ["target.geojson", targets],
    ].map(([name, features]) => ({
      name: name as string,
      mimeType: "application/geo+json",
      buffer: Buffer.from(
        JSON.stringify({ type: "FeatureCollection", features }),
      ),
    })),
  );
  await page
    .getByRole("dialog", { name: "导入文件", exact: true })
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await page.getByRole("button", { name: "空间分析", exact: true }).click();
  const box = page.locator(".processing-toolbox");
  await box.getByLabel("搜索分析工具").fill("按位置关联统计");
  await box
    .getByRole("button", { name: "按位置关联统计", exact: true })
    .click();
  await box
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "source.geojson" });
  await box
    .getByLabel("目标图层", { exact: true })
    .selectOption({ label: "target.geojson" });
  const enabled = box.getByLabel("汇总匹配目标的属性", { exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(box.getByLabel("统计方式", { exact: true })).toHaveCount(0);
  const download = async () => {
    await page.getByRole("button", { name: "下载图层", exact: true }).click();
    await page.getByLabel("输出格式").selectOption("geojson");
    const pending = page.waitForEvent("download");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "下载", exact: true })
      .click();
    return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
  };
  const run = async (name: string) => {
    await box.getByLabel("结果图层名称").fill(name);
    await box.getByRole("button", { name: "运行分析", exact: true }).click();
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    return download();
  };
  const legacy = await run("legacy_join");
  expect(legacy.features[0].properties).not.toHaveProperty("total__");
  await enabled.check();
  await box.getByLabel("指标名称", { exact: true }).fill("total");
  await box.getByLabel("统计方式", { exact: true }).selectOption("sum");
  const fields = box.getByLabel("统计字段", { exact: true });
  await expect(fields.locator('option[value="sourceOnly"]')).toHaveCount(0);
  await fields.selectOption("amount");
  await box
    .getByLabel("目标图层", { exact: true })
    .selectOption({ label: "source.geojson" });
  await expect(
    box.getByRole("button", { name: "运行分析", exact: true }),
  ).toBeDisabled();
  await box
    .getByLabel("目标图层", { exact: true })
    .selectOption({ label: "target.geojson" });
  await box.getByRole("button", { name: "添加指标", exact: true }).click();
  await box.getByLabel("指标名称", { exact: true }).nth(1).fill("records");
  const result = await run("aggregated_join");
  expect(result.features[0].properties.total__).toBe(6);
  expect(result.features[0].properties.records).toBe(2);
  expect(result.features[0].properties.total).toBe(99);
  expect(result.features[1].properties.total__).toBeNull();
  expect(result.features[1].properties.records).toBe(0);
  expect(
    result.features.map((feature: { geometry: unknown }) => feature.geometry),
  ).toEqual(source.map((feature) => feature.geometry));
  await expect(box.locator(".processing-explanation")).toContainText(
    "total → total__",
  );
  await expect(box.locator(".processing-explanation")).toContainText(
    "各区域合计不等于全图唯一总量",
  );
  await page.screenshot({
    path: "output/feature-expansion-2026-10-18/spatial-aggregation-zh.png",
    fullPage: true,
  });
  await enabled.uncheck();
  const reverted = await run("legacy_again");
  expect(
    reverted.features.map(
      (feature: { properties: unknown }) => feature.properties,
    ),
  ).toEqual(
    legacy.features.map(
      (feature: { properties: unknown }) => feature.properties,
    ),
  );
  expect(errors).toEqual([]);
});
