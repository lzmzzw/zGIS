import { test, expect, type Page } from "@playwright/test";
import type { DocumentLayer } from "../src/domain";
import Papa from "papaparse";
import { installDesktopMock, loadDatabaseTestLayer } from "./desktop.mock";

const toolbar = (page: Page) =>
  page.getByRole("toolbar", { name: "地图工具", exact: true });
const saveDialog = (page: Page) =>
  page.getByRole("dialog", { name: "保存图层", exact: true });
const sourceRow = (page: Page, kind: string) =>
  page.locator(`.tree-row[data-source-kind="${kind}"]`);
const layer = (overrides: Partial<DocumentLayer> = {}): DocumentLayer => ({
  id: "source-test",
  name: "points.geojson",
  sourceKind: "geojson",
  visible: true,
  color: "#5479b6",
  crs: "EPSG:4326",
  dirty: false,
  features: [
    {
      id: "point-1",
      geometry: { type: "Point", coordinates: [116, 40] },
      properties: { name: "original" },
    },
  ],
  ...overrides,
});
const snapshot = (layers: DocumentLayer[]) =>
  JSON.stringify({
    version: 2,
    layers,
    tree: layers.map(({ id }) => ({ kind: "layer", id })),
  });
async function recovered(page: Page, layers: DocumentLayer[]) {
  await installDesktopMock(page, snapshot(layers));
  await page.goto("/");
  await expect(page.locator(".tree-row[data-node-kind=layer]")).toHaveCount(
    layers.length,
  );
}
async function changeName(page: Page, name: string) {
  const expand = page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true });
  if (await expand.count()) await expand.click();
  await page.locator("tbody tr").first().click();
  await page.locator('td[data-field="name"]').first().dblclick();
  await page.getByLabel("属性 name", { exact: true }).fill(name);
  await page.keyboard.press("Enter");
}
async function savedLayer(page: Page): Promise<DocumentLayer> {
  return page.evaluate(
    () => JSON.parse(window.__ZG_TEST__.snapshot!).layers[0],
  );
}

test("工作区 CSV 首次保存选择格式路径，绑定后继续保存直接覆盖文件", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "points.csv",
    mimeType: "text/csv",
    buffer: Buffer.from('name,wkt\noriginal,"POINT (116 40)"'),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(
    sourceRow(page, "workspace").locator(".layer-source-badge"),
  ).toHaveText("工作区");
  await expect(
    sourceRow(page, "workspace").locator(".layer-source-badge"),
  ).toHaveAttribute("title", /选择格式和路径/);
  await toolbar(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await changeName(page, "first saved");
  await page.keyboard.press("Control+s");
  const dialog = saveDialog(page);
  await expect(dialog).toBeVisible();
  expect(
    await dialog
      .getByLabel("输出格式")
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["geojson", "shp", "wkt", "xy"]);
  await dialog.getByLabel("输出格式").selectOption("wkt");
  await dialog.getByLabel("文件名", { exact: true }).fill("saved-points");
  await dialog
    .getByLabel("目标坐标系", { exact: true })
    .selectOption("EPSG:3857");
  await dialog
    .getByRole("button", { name: "选择路径并保存", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    sourceRow(page, "file").locator(".layer-source-badge"),
  ).toHaveText("文件");
  await expect
    .poll(async () => (await savedLayer(page)).sourcePath)
    .toBe("test-file");
  const saved = await savedLayer(page);
  expect(saved).toMatchObject({
    sourceHash: "test-hash",
    sourceKind: "csv",
    originalCrs: "EPSG:3857",
    csvConfig: { geometryMode: "wkt", wktColumn: "WKT", crs: "EPSG:3857" },
    dirty: false,
  });
  const first = await page.evaluate(() =>
    window.__ZG_TEST__.calls
      .filter((call) => call.command === "save_file")
      .at(-1)!,
  );
  expect(first.args).toMatchObject({
    suggestedName: "saved-points.csv",
    overwrite: false,
    preserveExtension: "csv",
  });
  expect(String(first.args.content)).toContain("first saved");
  expect(String(first.args.content)).toMatch(/POINT\s*\(12913060/);
  await changeName(page, "second saved");
  await toolbar(page)
    .getByRole("button", { name: "保存编辑", exact: true })
    .click();
  await expect(saveDialog(page)).toHaveCount(0);
  const second = await page.evaluate(() =>
    window.__ZG_TEST__.calls
      .filter((call) => call.command === "save_file")
      .at(-1)!,
  );
  expect(second.args).toMatchObject({
    sourceId: "test-saved",
    sourcePath: "test-file",
    sourceHash: "test-hash",
    overwrite: true,
    suggestedName: "saved-points.csv",
  });
  expect(String(second.args.content)).toContain("second saved");
  expect(String(second.args.content)).toMatch(/POINT\s*\(12913060/);
});

test("工作区首次保存为 SHP 文件组，绑定后直接回写文件组", async ({ page }) => {
  await recovered(page, [layer({ dirty: true })]);
  await toolbar(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await toolbar(page)
    .getByRole("button", { name: "保存编辑", exact: true })
    .click();
  await saveDialog(page).getByLabel("输出格式").selectOption("shp");
  await expect(
    saveDialog(page).getByLabel("输出格式").locator('option[value="shp"]'),
  ).toHaveText("Shapefile · 文件组");
  await saveDialog(page)
    .getByLabel("文件名", { exact: true })
    .fill("saved-points");
  await saveDialog(page)
    .getByLabel("目标坐标系", { exact: true })
    .selectOption("EPSG:4490");
  await saveDialog(page)
    .getByRole("button", { name: "选择路径并保存", exact: true })
    .click();
  await expect(saveDialog(page)).toHaveCount(0);
  await expect(sourceRow(page, "file")).toHaveCount(1);
  await changeName(page, "shp next edit");
  await toolbar(page)
    .getByRole("button", { name: "保存编辑", exact: true })
    .click();
  const calls = await page.evaluate(() => window.__ZG_TEST__.calls);
  expect(
    calls.filter((call) => call.command === "save_shapefile_folder"),
  ).toHaveLength(1);
  expect(
    calls.find((call) => call.command === "save_shapefile_folder")!.args,
  ).toMatchObject({ suggestedName: "saved-points.shp", crs: "EPSG:4490" });
  expect(
    calls.filter((call) => call.command === "save_shapefile_source"),
  ).toHaveLength(1);
  expect(
    calls.find((call) => call.command === "save_shapefile_source")!.args,
  ).toMatchObject({
    sourceId: "test-saved",
    sourcePath: "test-file",
    sourceHash: "test-hash",
    crs: "EPSG:4490",
  });
  expect(calls.some((call) => call.command === "export_shapefile")).toBe(false);
});

test("首次保存取消或失败保留修改和编辑会话，成功保存才退出", async ({
  page,
}) => {
  await recovered(page, [layer()]);
  await toolbar(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await changeName(page, "pending changes");
  await toolbar(page)
    .getByRole("button", { name: "退出编辑", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "退出编辑", exact: true })
    .getByRole("button", { name: "保存并退出", exact: true })
    .click();
  await expect(saveDialog(page)).toBeVisible();
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = true;
  });
  await saveDialog(page)
    .getByRole("button", { name: "选择路径并保存", exact: true })
    .click();
  await expect(saveDialog(page)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("tbody tr")).toContainText("pending changes");
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = false;
    window.__ZG_TEST__.saveError = "test save failed";
  });
  await saveDialog(page)
    .getByRole("button", { name: "选择路径并保存", exact: true })
    .click();
  await expect(saveDialog(page).getByRole("alert")).toContainText(
    "test save failed",
  );
  await saveDialog(page)
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(
    toolbar(page).getByRole("button", { name: "退出编辑", exact: true }),
  ).toBeEnabled();
  await expect(
    sourceRow(page, "workspace").locator(".layer-text"),
  ).toContainText("*");
  await expect.poll(async () => (await savedLayer(page)).dirty).toBe(true);
  await page.evaluate(() => {
    window.__ZG_TEST__.saveError = "";
  });
  await toolbar(page)
    .getByRole("button", { name: "退出编辑", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "退出编辑", exact: true })
    .getByRole("button", { name: "保存并退出", exact: true })
    .click();
  await saveDialog(page)
    .getByRole("button", { name: "选择路径并保存", exact: true })
    .click();
  await expect(
    toolbar(page).getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(sourceRow(page, "file")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("pending changes");
});

test("恢复的 CSV 文件保存保留来源坐标系与 XY 列名", async ({ page }) => {
  await recovered(page, [
    layer({
      name: "projected.csv",
      sourceKind: "csv",
      sourceId: "csv-source",
      sourcePath: "F:/test/projected.csv",
      sourceHash: "csv-baseline",
      originalCrs: "EPSG:3857",
      csvConfig: {
        geometryMode: "xy",
        xColumn: "easting",
        yColumn: "northing",
        crs: "EPSG:3857",
      },
    }),
  ]);
  await expect(
    sourceRow(page, "file").locator(".layer-source-badge"),
  ).toHaveAttribute("title", /F:\/test\/projected.csv/);
  await toolbar(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await changeName(page, "restored saved");
  await toolbar(page)
    .getByRole("button", { name: "保存编辑", exact: true })
    .click();
  await expect(saveDialog(page)).toHaveCount(0);
  const call = await page.evaluate(() =>
    window.__ZG_TEST__.calls
      .filter((call) => call.command === "save_file")
      .at(-1)!,
  );
  expect(call.args).toMatchObject({
    sourcePath: "F:/test/projected.csv",
    sourceHash: "csv-baseline",
    overwrite: true,
    suggestedName: "projected.csv",
  });
  expect(String(call.args.content).split("\n")[0]).toContain(
    "easting,northing",
  );
  expect(String(call.args.content)).toContain("12913060");
  await expect
    .poll(async () => (await savedLayer(page)).originalCrs)
    .toBe("EPSG:3857");
});

test("旧 CSV 快照缺少格式或坐标系元数据时拒绝直接覆盖来源", async ({
  page,
}) => {
  await recovered(page, [
    layer({
      name: "legacy.csv",
      sourceKind: "csv",
      sourcePath: "F:/test/legacy.csv",
      sourceHash: "legacy-hash",
      dirty: true,
    }),
  ]);
  await toolbar(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await toolbar(page)
    .getByRole("button", { name: "保存编辑", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(/重新打开|另存/);
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some((call) => call.command === "save_file"),
    ),
  ).toBe(false);
  await expect(sourceRow(page, "file").locator(".layer-text")).toContainText(
    "*",
  );
  await expect(
    toolbar(page).getByRole("button", { name: "退出编辑", exact: true }),
  ).toBeEnabled();
});

for (const mode of ["wkt", "xy"] as const) {
  test(`首次保存 CSV ${mode} 及后续覆盖保留同名业务字段`, async ({ page }) => {
    const original = layer();
    original.features[0].properties = {
      name: "original",
      WKT: "业务文本",
      X: "业务横坐标",
      Y: "业务纵坐标",
    };
    await recovered(page, [original]);
    await toolbar(page)
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await changeName(page, "first");
    await toolbar(page)
      .getByRole("button", { name: "保存编辑", exact: true })
      .click();
    await saveDialog(page).getByLabel("输出格式").selectOption(mode);
    await saveDialog(page)
      .getByRole("button", { name: "选择路径并保存", exact: true })
      .click();
    await expect(saveDialog(page)).toHaveCount(0);
    await changeName(page, "second");
    await toolbar(page)
      .getByRole("button", { name: "保存编辑", exact: true })
      .click();
    const calls = await page.evaluate(() =>
      window.__ZG_TEST__.calls.filter((call) => call.command === "save_file"),
    );
    expect(calls).toHaveLength(2);
    for (const [index, call] of calls.entries()) {
      const parsed = Papa.parse<Record<string, string>>(
        String(call.args.content),
        { header: true },
      ).data[0];
      expect(parsed).toMatchObject({
        name: index ? "second" : "first",
        WKT: "业务文本",
        X: "业务横坐标",
        Y: "业务纵坐标",
      });
      if (mode === "wkt") expect(parsed.WKT_2).toMatch(/POINT\s*\(116 40\)/);
      else expect(parsed).toMatchObject({ X_2: "116", Y_2: "40" });
    }
    expect(calls[1].args.overwrite).toBe(true);
  });
}

for (const [path, zipMember] of [
  ["F:/test/points.shp", undefined],
  ["F:/test/points.zip", "nested/points.shp"],
] as const) {
  test(`SHP 来源直接保存到 ${zipMember ? "ZIP 中指定图层" : "已有文件组"}`, async ({
    page,
  }) => {
    await recovered(page, [
      layer({
        name: "points",
        sourceKind: "shp",
        sourceId: "shp-source",
        sourcePath: path,
        sourceHash: "shp-baseline",
        originalCrs: "EPSG:4490",
        zipMember,
      }),
    ]);
    await toolbar(page)
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    await changeName(page, "shp edited");
    await page.evaluate(() => {
      window.__ZG_TEST__.saveCancelled = true;
    });
    await toolbar(page)
      .getByRole("button", { name: "保存编辑", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const calls = await page.evaluate(() => window.__ZG_TEST__.calls);
    expect(
      calls.filter((call) =>
        ["save_file", "save_shapefile_folder", "export_shapefile"].includes(
          call.command,
        ),
      ),
    ).toHaveLength(0);
    expect(
      calls.filter((call) => call.command === "save_shapefile_source"),
    ).toHaveLength(1);
    expect(
      calls.find((call) => call.command === "save_shapefile_source")!.args,
    ).toMatchObject({
      sourcePath: path,
      sourceHash: "shp-baseline",
      crs: "EPSG:4490",
      ...(zipMember ? { zipMember } : {}),
    });
    await expect
      .poll(async () => (await savedLayer(page)).sourceHash)
      .toBe("test-shp-saved-hash");
    expect(await savedLayer(page)).toMatchObject({
      sourcePath: path,
      sourceKind: "shp",
      originalCrs: "EPSG:4490",
      dirty: false,
    });
  });
}

test("数据库图层徽标与直接提交，窄栏长名称在深浅主题不遮挡来源", async ({
  page,
}) => {
  await recovered(page, [
    layer({ name: "尚未写入文件的工作区分析结果长名称.geojson" }),
    layer({
      id: "file-test",
      name: "已经从本地文件路径打开的长名称图层.geojson",
      sourceId: "file-source",
      sourcePath: "F:/test/long-name.geojson",
      sourceHash: "file-hash",
    }),
  ]);
  await loadDatabaseTestLayer(page);
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await expect(
    sourceRow(page, "database").locator(".layer-source-badge"),
  ).toHaveText("数据库");
  await expect(
    sourceRow(page, "database").locator(".layer-source-badge"),
  ).toHaveAttribute("title", /public.roads/);
  await toolbar(page)
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await changeName(page, "database edited");
  await toolbar(page)
    .getByRole("button", { name: "保存编辑", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.filter(
        (call) => call.command === "commit_changes",
      ),
    ),
  ).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some((call) =>
        ["save_file", "save_shapefile_source"].includes(call.command),
      ),
    ),
  ).toBe(false);
  await toolbar(page)
    .getByRole("button", { name: "退出编辑", exact: true })
    .click();
  await page
    .getByRole("separator", { name: "调整图层栏宽度", exact: true })
    .focus();
  await page.keyboard.press("Home");
  await expect(page.locator(".layers-panel")).toHaveCSS("width", "200px");
  const rows = await page
    .locator(".tree-row[data-source-kind]")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const name = node.querySelector(".layer-text strong")!;
        const badge = node.querySelector(".layer-source-badge")!;
        return {
          nameRight: name.getBoundingClientRect().right,
          badgeLeft: badge.getBoundingClientRect().left,
          badgeRight: badge.getBoundingClientRect().right,
          rowRight: node.getBoundingClientRect().right,
          clipped: name.scrollWidth > name.clientWidth,
        };
      }),
    );
  for (const row of rows) {
    expect(row.nameRight).toBeLessThanOrEqual(row.badgeLeft);
    expect(row.badgeRight).toBeLessThanOrEqual(row.rowRight);
  }
  expect(rows.slice(0, 2).every((row) => row.clipped)).toBe(true);
  await page.screenshot({
    path: "output/layer-source-save/sources-narrow-dark.png",
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.setViewportSize({ width: 960, height: 640 });
  await expect(
    sourceRow(page, "workspace").locator(".layer-source-badge"),
  ).toHaveCSS("border-top-style", "dashed");
  await page.screenshot({
    path: "output/layer-source-save/sources-narrow-light.png",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
