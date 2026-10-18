import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const features = [0, 10, 20, 30, null, undefined].map((amount, index) => ({
  type: "Feature",
  properties: {
    name: `station-${index}`,
    ...(amount === undefined ? {} : { amount }),
  },
  geometry: { type: "Point", coordinates: [114 + index * 0.01, 30, index] },
}));
async function load(page: Page) {
  await page
    .getByLabel("选择空间文件", { exact: true })
    .setInputFiles({
      name: "stations.geojson",
      mimeType: "application/geo+json",
      buffer: Buffer.from(
        JSON.stringify({ type: "FeatureCollection", features }),
      ),
    });
  await page
    .getByRole("dialog", { name: "导入文件", exact: true })
    .getByRole("button", { name: "导入", exact: true })
    .click();
  await expect(page.locator(".web-layer")).toHaveCount(1);
}
test.beforeEach(async ({ page }) => {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("./");
});
test("命令搜索禁用原因、焦点恢复与工具仅打开不执行", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /搜索操作/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "搜索操作", exact: true });
  const input = dialog.getByRole("textbox", { name: "搜索操作", exact: true });
  await expect(input).toBeFocused();
  await input.fill("字段概览");
  const command = dialog.locator(".command-palette-results button").first();
  await expect(command).toHaveAttribute("aria-disabled", "true");
  await input.press("Enter");
  await expect(dialog).toBeVisible();
  await input.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await load(page);
  await trigger.click();
  await input.fill("buffer");
  await expect(
    dialog.locator(".command-palette-results button").first(),
  ).toHaveAttribute("aria-disabled", "false");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(
    page.locator(".processing-toolbox").getByLabel("缓冲距离（米）"),
  ).toBeVisible();
  await expect(page.locator(".processing-result")).toHaveCount(0);
  await expect(page.locator(".web-layer")).toHaveCount(1);
});

test("字段概览进入分级，取消预览与图例数量不会改变来源数据", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await load(page);
  const layer = page.locator(".web-layer");
  const legend = layer.locator(".layer-legend");
  await legend.locator("summary").click();
  await expect(legend.locator("li")).toHaveCount(1);
  await expect(legend.locator("li small")).toHaveText("6");
  await layer.getByRole("button", { name: "字段概览", exact: true }).click();
  const inspector = page.locator(".layer-inspector");
  await inspector
    .getByLabel("概览字段", { exact: true })
    .selectOption("amount");
  await expect(
    inspector.getByRole("button", { name: "按此字段分级着色", exact: true }),
  ).toBeEnabled();
  await inspector
    .getByRole("button", { name: "按此字段分级着色", exact: true })
    .click();
  await expect(
    inspector.getByRole("tab", { name: "图层样式", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByLabel("分级字段", { exact: true })).toHaveValue(
    "amount",
  );
  await expect(inspector).toContainText("当前预览尚未应用");
  await expect(legend.locator("li")).toHaveCount(1);
  await inspector.getByRole("button", { name: "取消", exact: true }).click();
  await expect(inspector).toBeHidden();
  await layer.getByRole("button", { name: "图层样式", exact: true }).click();
  await expect(inspector.getByLabel("着色方式", { exact: true })).toHaveValue(
    "single",
  );
  await inspector
    .getByLabel("着色方式", { exact: true })
    .selectOption("graduated");
  await inspector.getByLabel("分级数量", { exact: true }).selectOption("3");
  await inspector
    .getByRole("button", { name: "应用样式", exact: true })
    .click();
  await expect(legend.locator("li")).toHaveCount(6);
  await expect(legend.locator("li small")).toHaveText([
    "2",
    "1",
    "1",
    "0",
    "1",
    "1",
  ]);
  await expect(legend).toContainText("≤ 10");
  await expect(legend).toContainText("(10, 20]");
  await inspector
    .getByLabel("分级方法", { exact: true })
    .selectOption("manual");
  await inspector.getByLabel("内部分割点", { exact: true }).fill("10, 10");
  await inspector
    .getByRole("button", { name: "应用断点", exact: true })
    .click();
  await expect(inspector.getByRole("alert")).toContainText("严格递增");
  await inspector.getByRole("button", { name: "取消", exact: true }).click();
  await layer.getByRole("button", { name: "图层样式", exact: true }).click();
  await expect(inspector.getByLabel("分级方法", { exact: true })).toHaveValue(
    "equal_interval",
  );
  await inspector
    .getByRole("button", { name: "关闭检查器", exact: true })
    .click();
  await page.screenshot({
    path: "output/interface-0.4.1/graduated-legend-web.png",
    fullPage: true,
  });
  await page.getByRole("table", { name: "图层属性", exact: true }).getByRole("button", { name: "amount", exact: true }).click();
  await expect(inspector.getByRole("tab", { name: "字段概览", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByLabel("概览字段", { exact: true })).toHaveValue("amount");
  await inspector.getByRole("button", { name: "关闭检查器", exact: true }).click();
  await page.getByRole("button", { name: "下载图层", exact: true }).click();
  await page.getByLabel("输出格式").selectOption("geojson");
  const pending = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "下载", exact: true })
    .click();
  const output = JSON.parse(
    await readFile((await (await pending).path())!, "utf8"),
  );
  expect(
    output.features.map(
      (feature: { properties: unknown; geometry: unknown }) => ({
        properties: feature.properties,
        geometry: feature.geometry,
      }),
    ),
  ).toEqual(
    features.map(({ properties, geometry }) => ({ properties, geometry })),
  );
  expect(JSON.stringify(output)).not.toMatch(
    /graduatedStyle|categorizedStyle|breaks/,
  );
  expect(errors).toEqual([]);
});
