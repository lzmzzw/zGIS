import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const geometries = [
  {
    type: "MultiPoint",
    coordinates: [
      [114, 30],
      [114.1, 30.1],
    ],
  },
  {
    type: "MultiLineString",
    coordinates: [
      [
        [114, 30],
        [114.1, 30.1],
      ],
    ],
  },
  {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [114, 30],
          [114.1, 30],
          [114.1, 30.1],
          [114, 30],
        ],
      ],
    ],
  },
];
const layers = geometries.map((geometry, i) => ({
  id: `layer-${i}`,
  name: ["站点.geojson", "路线.geojson", "范围.geojson"][i],
  visible: true,
  color: "#5479b6",
  sourceKind: "geojson",
  dirty: false,
  features: [1, 10, 20].map((value, j) => ({
    id: `${i}-${j}`,
    geometry,
    properties: { 名称: `对象${j + 1}`, 数量: value },
  })),
}));

test("geometry-specific controls, right-side legend, preview cancellation and persisted settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installDesktopMock(
    page,
    JSON.stringify({
      version: 2,
      layers,
      tree: layers.map((layer) => ({ kind: "layer", id: layer.id })),
    }),
  );
  await page.goto("/");
  const inspector = page.locator(".layer-inspector");
  await page
    .getByRole("button", { name: "站点.geojson样式", exact: true })
    .click();
  await expect(inspector.getByLabel("点直径", { exact: true })).toBeVisible();
  await expect(
    inspector.getByLabel("填充不透明度", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tree", { name: "图层树" }).locator(".layer-legend"),
  ).toHaveCount(0);
  await expect(inspector.locator(".layer-legend")).toBeVisible();
  await expect(inspector.locator(".layer-legend li small")).toHaveCount(0);
  await expect(inspector.getByLabel("边框宽度", { exact: true })).toHaveValue(
    "1",
  );
  await inspector.getByLabel("点直径", { exact: true }).fill("24");
  await inspector.getByLabel("填充颜色", { exact: true }).fill("#22aa77");
  await inspector.getByLabel("边框颜色", { exact: true }).fill("#222222");
  await inspector
    .getByRole("button", { name: "应用样式", exact: true })
    .click();
  await page
    .getByRole("button", { name: "路线.geojson样式", exact: true })
    .click();
  await expect(inspector.getByLabel("填充颜色", { exact: true })).toHaveCount(
    0,
  );
  await inspector.getByLabel("线条颜色", { exact: true }).fill("#bb5533");
  await inspector.getByLabel("线宽", { exact: true }).fill("4");
  await inspector.getByLabel("线型", { exact: true }).selectOption("dashed");
  await inspector
    .getByRole("button", { name: "应用样式", exact: true })
    .click();
  await page
    .getByRole("button", { name: "范围.geojson样式", exact: true })
    .click();
  await inspector.getByLabel("填充颜色", { exact: true }).fill("#11aa55");
  // Fill editing does not change the existing border color.
  await expect(inspector.getByLabel("边框颜色", { exact: true })).toHaveValue(
    "#5479b6",
  );
  await inspector.getByLabel("填充不透明度", { exact: true }).fill("65");
  await inspector.getByLabel("边框颜色", { exact: true }).fill("#773311");
  await inspector.getByLabel("边框宽度", { exact: true }).fill("3");
  await inspector.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("button", { name: "范围.geojson样式", exact: true })
    .click();
  await expect(inspector.getByLabel("填充颜色", { exact: true })).toHaveValue(
    "#5479b6",
  );
  await inspector.getByLabel("填充颜色", { exact: true }).fill("#11aa55");
  await inspector.getByLabel("填充不透明度", { exact: true }).fill("65");
  await inspector.getByLabel("边框颜色", { exact: true }).fill("#773311");
  await inspector.getByLabel("边框宽度", { exact: true }).fill("3");
  await inspector
    .getByRole("button", { name: "应用样式", exact: true })
    .click();
  await inspector
    .getByLabel("着色方式", { exact: true })
    .selectOption("unique");
  await page.screenshot({ path: "output/inspector-redesign/polygon-dark.png" });
  await expect(inspector.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("字段概览", { exact: true })).toHaveCount(0);
  await inspector
    .getByLabel("着色方式", { exact: true })
    .selectOption("graduated");
  await expect(
    inspector.getByLabel("填充颜色", { exact: true }),
  ).toBeDisabled();
  await expect(inspector.locator(".layer-legend li")).toHaveCount(6);
  await inspector.getByRole("button", { name: "取消", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.snapshot))
    .toContain('"fillOpacity":0.65');
  const snapshot = await page.evaluate(() => window.__ZG_TEST__.snapshot);
  const saved = JSON.parse(snapshot!).layers;
  expect(saved[0].pointRadius).toBe(12);
  expect(saved[0].strokeWidth).toBeUndefined();
  expect(saved[1].linePattern).toBe("dashed");
  expect(saved[2].strokeColor).toBe("#773311");
  expect(saved[2].dirty).toBe(false);
  expect(
    saved[2].features.map(
      (feature: { properties: unknown }) => feature.properties,
    ),
  ).toEqual(layers[2].features.map((feature) => feature.properties));
  await installDesktopMock(page, snapshot!);
  await page.reload();
  await page
    .getByRole("button", { name: "范围.geojson样式", exact: true })
    .click();
  await expect(
    inspector.getByLabel("填充不透明度", { exact: true }),
  ).toHaveValue("65");
  await expect(inspector.getByLabel("边框颜色", { exact: true })).toHaveValue(
    "#773311",
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.setViewportSize({ width: 960, height: 640 });
  await page
    .getByRole("button", { name: "范围.geojson样式", exact: true })
    .click();
  await page.screenshot({
    path: "output/inspector-redesign/polygon-light-narrow.png",
  });
  expect(
    await inspector.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("category and graduated editors match legend symbols throughout draft changes", async ({
  page,
}) => {
  await installDesktopMock(
    page,
    JSON.stringify({
      version: 2,
      layers,
      tree: layers.map((layer) => ({ kind: "layer", id: layer.id })),
    }),
  );
  await page.goto("/");
  const inspector = page.locator(".layer-inspector");
  const symbols = async () =>
    inspector.evaluate((element) => ({
      editors: Array.from(
        element.querySelectorAll(".symbol-color-input svg"),
        (node) => node.outerHTML,
      ),
      legend: Array.from(
        element.querySelectorAll(".layer-legend svg"),
        (node) => node.outerHTML,
      ),
    }));
  for (const layer of layers) {
    await page
      .getByRole("button", { name: `${layer.name}样式`, exact: true })
      .click();
    await inspector
      .getByLabel("着色方式", { exact: true })
      .selectOption("unique");
    await inspector.getByLabel("图层不透明度", { exact: true }).fill("55");
    await inspector
      .getByLabel(
        layer.features[0].geometry.type === "MultiLineString"
          ? "线宽"
          : "边框宽度",
        { exact: true },
      )
      .fill("3");
    if (layer.features[0].geometry.type !== "MultiPoint")
      await inspector
        .getByLabel("线型", { exact: true })
        .selectOption("dashed");
    if (layer.features[0].geometry.type !== "MultiLineString")
      await inspector.getByLabel("边框颜色", { exact: true }).fill("#ef3300");
    if (layer.features[0].geometry.type === "MultiPolygon")
      await inspector.getByLabel("填充不透明度", { exact: true }).fill("14");
    const category = inspector.getByLabel("类别 1 颜色", { exact: true });
    await category.fill("#22aa77");
    await category.focus();
    await expect(category).toBeFocused();
    const categorized = await symbols();
    expect(categorized.editors).toEqual(categorized.legend);
    expect(categorized.editors[0]).toContain("#22aa77");
    await inspector
      .getByLabel("着色方式", { exact: true })
      .selectOption("graduated");
    await inspector.getByLabel("分级 1 颜色", { exact: true }).fill("#cc55aa");
    const graduated = await symbols();
    expect(graduated.editors).toEqual(graduated.legend);
    expect(graduated.editors[0]).toContain("#cc55aa");
    if (layer.features[0].geometry.type === "MultiPolygon") {
      await inspector.getByLabel("填充不透明度", { exact: true }).fill("0");
      const transparent = await symbols();
      expect(transparent.editors).toEqual(transparent.legend);
      expect(transparent.editors[0]).toContain('fill-opacity="0"');
      await page.screenshot({
        path: "output/inspector-redesign/symbol-editors.png",
      });
    }
    await inspector.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("button", { name: `${layer.name}样式`, exact: true })
      .click();
    await expect(inspector.getByLabel("着色方式", { exact: true })).toHaveValue(
      "single",
    );
    await inspector.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("thematic modes generate editable defaults immediately without a rebuild action", async ({
  page,
}) => {
  const layer = {
    ...layers[2],
    fillOpacity: 0,
    opacity: 0,
    features: layers[2].features.map((feature, i) => ({
      ...feature,
      properties: {
        FID: i,
        name: `Object${i}`,
        group: i < 2 ? "A" : "B",
        amount: i * 10,
      },
    })),
  };
  await installDesktopMock(
    page,
    JSON.stringify({
      version: 2,
      layers: [layer],
      tree: [{ kind: "layer", id: layer.id }],
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: `${layer.name}样式`, exact: true })
    .click();
  const inspector = page.locator(".layer-inspector");
  await inspector
    .getByLabel("着色方式", { exact: true })
    .selectOption("unique");
  await expect(inspector.getByLabel("分类字段", { exact: true })).toHaveValue(
    "group",
  );
  await expect(
    inspector.locator(".layer-category-list input[type=color]"),
  ).toHaveCount(5);
  const colors = await inspector
    .locator(".layer-category-list input[type=color]")
    .evaluateAll((nodes) =>
      nodes.slice(0, 2).map((node) => (node as HTMLInputElement).value),
    );
  expect(new Set(colors).size).toBe(2);
  await expect(
    inspector.getByLabel("填充不透明度", { exact: true }),
  ).toHaveValue("70");
  await inspector.getByLabel("类别 1 颜色", { exact: true }).fill("#abcdef");
  await inspector.getByLabel("填充不透明度", { exact: true }).fill("25");
  await inspector
    .getByRole("button", { name: "应用样式", exact: true })
    .click();
  await inspector
    .getByRole("button", { name: "关闭检查器", exact: true })
    .click();
  await page
    .getByRole("button", { name: `${layer.name}样式`, exact: true })
    .click();
  await expect(
    inspector.getByLabel("类别 1 颜色", { exact: true }),
  ).toHaveValue("#abcdef");
  await expect(
    inspector.getByLabel("填充不透明度", { exact: true }),
  ).toHaveValue("25");
  await inspector
    .getByLabel("着色方式", { exact: true })
    .selectOption("graduated");
  await expect(inspector.getByLabel("分级字段", { exact: true })).toHaveValue(
    "amount",
  );
  await expect(inspector.getByLabel("分级方法", { exact: true })).toHaveValue(
    "quantile",
  );
  await expect(inspector.getByLabel("分级数量", { exact: true })).toHaveValue(
    "3",
  );
  await expect(
    inspector.locator(".layer-category-list input[type=color]"),
  ).toHaveCount(6);
  // Changing modes after manual adjustment keeps the user's opacity.
  await expect(
    inspector.getByLabel("填充不透明度", { exact: true }),
  ).toHaveValue("25");
  await inspector.getByLabel("分级 1 颜色", { exact: true }).fill("#112233");
  await inspector.getByLabel("分级数量", { exact: true }).selectOption("2");
  await expect(inspector.locator(".layer-legend li")).toHaveCount(5);
});
