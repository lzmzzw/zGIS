import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function setup(page: Page) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "attributes.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "FeatureCollection",
        features: [1, 2].map((n) => ({
          type: "Feature",
          id: `f${n}`,
          geometry: { type: "Point", coordinates: [116 + n, 40] },
          properties: {
            code: "001",
            count: n,
            enabled: true,
            empty: null,
            detail: { name: "原值" },
            long: "长文本".repeat(50),
          },
        })),
      }),
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
}
const cell = (page: Page, field: string) =>
  page.locator(`tbody tr.selected td[data-field="${field}"]`);

for (const theme of ["dark", "light"]) {
  test(`inline editing keeps row height, column positions and typography stable (${theme})`, async ({ page }) => {
    await setup(page);
    await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
    const geometry = () => page.locator(".attribute-panel tbody tr").evaluateAll((rows) =>
      rows.map((row) => [...row.children].map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { x: rect.x, width: rect.width, height: rect.height };
      })),
    );
    for (const field of ["code", "count", "enabled", "empty"]) {
      const before = await geometry();
      const font = await cell(page, field).evaluate((el) => getComputedStyle(el).font);
      await cell(page, field).dblclick();
      const input = page.getByLabel(`属性 ${field}`, { exact: true });
      await expect(input).toBeFocused();
      expect(await geometry()).toEqual(before);
      expect(await input.evaluate((el) => getComputedStyle(el).font)).toBe(font);
      if (field === "code") {
        await input.fill("不会撑开列宽的较长编辑内容".repeat(8));
        expect(await geometry()).toEqual(before);
        await page.locator(".attribute-panel").screenshot({ path: `output/smoke/inline-cell-${theme}.png` });
        await page.getByRole("button", { name: "展开单元格编辑", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
      } else {
        await input.press("Escape");
      }
      expect(await geometry()).toEqual(before);
    }
  });
}

test("column widths and display order change without changing attribute values", async ({ page }) => {
  await setup(page);
  const handle = page.getByRole("separator", { name: "调整 code 列宽", exact: true });
  const header = handle.locator("..");
  const before = await header.boundingBox();
  const box = await handle.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 80, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await header.boundingBox())!.width).toBeCloseTo(before!.width + 80, 0);
  await cell(page, "code").dblclick();
  expect((await cell(page, "code").boundingBox())!.width).toBeCloseTo(before!.width + 80, 0);
  await page.getByLabel("属性 code", { exact: true }).press("Escape");
  const countHeader = page.getByRole("separator", { name: "调整 count 列宽", exact: true }).locator("..");
  await countHeader.dragTo(header, { targetPosition: { x: 8, y: 12 } });
  await expect(page.locator(".attribute-panel thead .header-menu > summary")).toHaveText([
    "count", "code", "enabled", "empty", "detail", "long",
  ]);
  expect(await page.locator(".attribute-panel tbody tr.selected td[data-field]").evaluateAll((cells) =>
    cells.map((el) => [el.getAttribute("data-field"), el.textContent]),
  )).toEqual([["count", "1"], ["code", "001"], ["enabled", "true"], ["empty", "NULL"], ["detail", '{"name":"原值"}'], ["long", "长文本".repeat(50)]]);
  expect((await header.boundingBox())!.width).toBeCloseTo(before!.width + 80, 0);
  await handle.dblclick();
  await expect(page.locator(".attribute-panel table")).not.toHaveClass("resized-columns");
  await header.locator("summary").focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator(".attribute-panel thead .header-menu > summary")).toHaveText([
    "code", "count", "enabled", "empty", "detail", "long",
  ]);
  await expect(page.locator(".layer-text").filter({ hasText: "attributes.geojson" })).not.toContainText("*");
});

test("cell validation, keyboard commit, cancellation and NULL retain correct types", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await expect(page.locator(".inspector")).toHaveCount(0);
  await cell(page, "count").dblclick();
  const count = page.getByLabel("属性 count", { exact: true });
  await count.fill("wrong");
  await count.press("Enter");
  await expect(page.locator(".cell-error")).toBeVisible();
  await expect(count).toHaveValue("wrong");
  await expect(page.getByLabel("搜索属性")).toBeDisabled();
  await count.fill("42");
  await count.press("Tab");
  await expect(cell(page, "enabled")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByLabel("属性 enabled", { exact: true }).selectOption("false");
  await page.getByLabel("属性 enabled", { exact: true }).press("Enter");
  await cell(page, "code").dblclick();
  await page.getByLabel("属性 code", { exact: true }).fill("009");
  await page.getByLabel("属性 code", { exact: true }).press("Escape");
  await expect(cell(page, "code")).toHaveText("001");
  await cell(page, "code").press("Enter");
  await page.getByLabel("属性 code", { exact: true }).fill("007");
  await page.getByLabel("属性 code", { exact: true }).press("Enter");
  await cell(page, "empty").dblclick();
  await page.getByLabel("属性 empty", { exact: true }).fill('"filled"');
  await page.getByLabel("属性 empty", { exact: true }).press("Enter");
  await cell(page, "code").dblclick();
  await page.getByLabel("设为 NULL", { exact: true }).check();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(cell(page, "code")).toHaveText("NULL");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(cell(page, "code")).toHaveText("007");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "导出为", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const { readFileSync } = await import("node:fs");
  const data = JSON.parse(
    readFileSync((await (await pending).path())!, "utf-8"),
  );
  expect(data.features[0].properties).toMatchObject({
    code: "007",
    count: 42,
    enabled: false,
    empty: "filled",
  });
  expect(errors).toEqual([]);
});

test("complex cells use an independent editor and maximized table restores the map", async ({
  page,
}) => {
  await setup(page);
  await cell(page, "detail").dblclick();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("输入 JSON");
  await page.getByLabel("属性 detail", { exact: true }).fill("[]");
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("JSON 对象");
  await page.getByLabel("属性 detail", { exact: true }).fill('{"name":"更新"}');
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cell(page, "detail")).toContainText("更新");
  await cell(page, "long").dblclick();
  await expect(dialog).toBeVisible();
  await page.getByLabel("属性 long", { exact: true }).fill("cancelled");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(cell(page, "long")).toContainText("长文本");
  await page.getByRole("button", { name: "最大化属性表", exact: true }).click();
  await expect(page.locator(".map-container")).toBeHidden();
  await page.screenshot({ path: "output/smoke/attribute-table-maximized.png" });
  await page.getByRole("button", { name: "还原属性表", exact: true }).click();
  await expect(page.locator(".map-container")).toBeVisible();
});

test("layer symbol styles target the clicked layer and support apply and cancel", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  const row = page
    .locator(".tree-row")
    .filter({ hasText: "attributes.geojson" });
  await page
    .getByRole("button", { name: "attributes.geojson样式", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveAccessibleName("图层样式：attributes.geojson");
  await page
    .getByLabel("attributes.geojson颜色", { exact: true })
    .fill("#ff0000");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("button", { name: "attributes.geojson样式", exact: true })
    .click();
  await expect(
    page.getByLabel("attributes.geojson颜色", { exact: true }),
  ).not.toHaveValue("#ff0000");
  await page
    .getByLabel("attributes.geojson颜色", { exact: true })
    .fill("#00ff00");
  await dialog.getByRole("button", { name: "应用样式", exact: true }).click();
  await page
    .getByRole("button", { name: "attributes.geojson样式", exact: true })
    .click();
  await expect(
    page.getByLabel("attributes.geojson颜色", { exact: true }),
  ).toHaveValue("#00ff00");
  await page.screenshot({ path: "output/smoke/layer-properties.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".inspector")).toHaveCount(0);
});

test("layer style drafts survive cancelled native exit and defer incoming analysis layers", async ({
  page,
}) => {
  await installDesktopMock(page);
  await setup(page);
  const row = page
    .locator(".tree-row")
    .filter({ hasText: "attributes.geojson" });
  await page
    .getByRole("button", { name: "attributes.geojson样式", exact: true })
    .click();
  await page
    .getByLabel("attributes.geojson颜色", { exact: true })
    .fill("#123456");
  await page.evaluate(() =>
    window.__ZG_TEST__.analysisResults.push({
      id: "analysis",
      name: "分析结果",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [116, 40] },
          properties: { name: "result" },
        },
      ],
    }),
  );
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.analysisResults.length))
    .toBe(0);
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "图层样式：attributes.geojson",
  );
  await expect(
    page.locator(".layer-text").filter({ hasText: "分析结果" }),
  ).toHaveCount(0);
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect(page.getByRole("dialog")).toHaveAccessibleName("退出 zGIS");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "返回编辑", exact: true })
    .click();
  await expect(
    page.getByLabel("attributes.geojson颜色", { exact: true }),
  ).toHaveValue("#123456");
  await page.getByRole("button", { name: "应用样式", exact: true }).click();
  await expect(page.locator(".layer-text").filter({ hasText: "分析结果" })).toHaveCount(0);
  await page.getByRole("button", { name: "保存并退出编辑", exact: true }).click();
  await expect(
    page.locator(".layer-text").filter({ hasText: "分析结果" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "attributes.geojson样式", exact: true })
    .click();
  await expect(
    page.getByLabel("attributes.geojson颜色", { exact: true }),
  ).toHaveValue("#123456");
});

test("confirmed native exit includes deferred analysis layers but discards unconfirmed styles", async ({
  page,
}) => {
  await installDesktopMock(page);
  await setup(page);
  await page
    .getByRole("button", { name: "attributes.geojson样式", exact: true })
    .click();
  const originalColor = await page
    .getByLabel("attributes.geojson颜色", { exact: true })
    .inputValue();
  await page
    .getByLabel("attributes.geojson颜色", { exact: true })
    .fill("#abcdef");
  await page.evaluate(() =>
    window.__ZG_TEST__.analysisResults.push({
      id: "deferred",
      name: "退出保留结果",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [116, 40] },
          properties: { name: "result" },
        },
      ],
    }),
  );
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.analysisResults.length))
    .toBe(0);
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await page
    .getByRole("button", { name: "退出并保留工作区", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  const saved = JSON.parse(
    (await page.evaluate(() => window.__ZG_TEST__.snapshot))!,
  );
  const layers = Array.isArray(saved) ? saved : saved.layers;
  expect(layers.map((l: { name: string }) => l.name)).toEqual([
    "attributes.geojson",
    "退出保留结果",
  ]);
  expect(layers[0].color).toBe(originalColor);
});
