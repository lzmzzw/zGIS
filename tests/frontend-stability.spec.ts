import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test("仅含空几何的图层导入和定位保持属性表可用", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "null-geometry.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "Feature",
        geometry: null,
        properties: { name: "只有属性" },
      }),
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("button", { name: "缩放至图层", exact: true }).click();
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
  const row = page.locator(".attribute-panel tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row.locator('td[data-field="name"]')).toHaveText("只有属性");
  await row.dblclick();
  await expect(row).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

const recovery = JSON.stringify({
  version: 3,
  layers: [
    {
      id: "layer",
      name: "draft.geojson",
      visible: true,
      color: "#5479b6",
      dirty: true,
      features: [
        {
          id: "feature",
          geometry: { type: "Point", coordinates: [116, 40] },
          properties: { value: 7 },
        },
      ],
    },
  ],
  tree: [{ kind: "layer", id: "layer" }],
  session: {
    layerId: "layer",
    selectedId: "feature",
    tool: "select",
    snapping: false,
    cellDraft: {
      featureId: "feature",
      field: "value",
      text: "7",
      isNull: true,
    },
  },
});

test("恢复旧版本 NULL 草稿时保留空值语义并允许重新输入", async ({ page }) => {
  await installDesktopMock(page, recovery);
  await page.goto("/");
  const input = page.getByLabel("属性 value", { exact: true });
  await expect(input).toHaveValue("NULL");
  await input.press("Enter");
  const cell = page.locator('tbody tr.selected td[data-field="value"]');
  await expect(cell).toHaveText("NULL");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.__ZG_TEST__.snapshot;
        return raw
          ? JSON.parse(raw).layers[0].features[0].properties.value
          : undefined;
      }),
    )
    .toBeNull();
});

test("恢复 NULL 草稿后重新输入数值可覆盖空值意图", async ({ page }) => {
  await installDesktopMock(page, recovery);
  await page.goto("/");
  const input = page.getByLabel("属性 value", { exact: true });
  await expect(input).toHaveValue("NULL");
  await input.fill("9");
  await input.press("Enter");
  await expect(
    page.locator('tbody tr.selected td[data-field="value"]'),
  ).toHaveText("9");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.__ZG_TEST__.snapshot;
        return raw
          ? JSON.parse(raw).layers[0].features[0].properties.value
          : undefined;
      }),
    )
    .toBe(9);
});
