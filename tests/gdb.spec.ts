import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import type { GdbCatalog, GdbReadResult } from "../src/gdb";

const fields = [
  {
    name: "name",
    type: "String",
    nullable: true,
    alias: "名称",
    domain: '{"1":"道路"}',
  },
  { name: "payload", type: "Binary", nullable: true },
];
const catalog: GdbCatalog = {
  sourceId: "ephemeral-gdb",
  path: "C:/测试/roads.gdb",
  fingerprint: "gdb-hash",
  warnings: [],
  layers: [
    {
      name: "roads",
      alias: "道路",
      group: "基础",
      geometryType: "Point Z",
      featureCount: null,
      sourceCrs: "EPSG:4490",
      sourceCrsWkt: "CGCS2000-WKT",
      fields,
      supported: true,
      warnings: [],
    },
  ],
};
const result: GdbReadResult = {
  features: [
    {
      id: "road-1",
      sourceFeatureId: "9007199254740993",
      geometry: { type: "Point", coordinates: [116, 39, 7] },
      properties: { name: "道路" },
    },
  ],
  sourceCrs: "EPSG:4490",
  sourceCrsWkt: "CGCS2000-WKT",
  fields: [fields[0]],
  geometryType: "Point Z",
  warnings: [],
  truncated: true,
  loadedCount: 1,
  readLimit: 1,
  bounds: [110, 30, 120, 40],
  sourceFingerprint: "gdb-hash",
  transformation: "XY approximation; Z unchanged",
};
async function openPanel(page: Page) {
  await page
    .locator(".header-menu summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "打开 GDB…", exact: true }).click();
  return page.getByRole("dialog", { name: "GDB 只读导入", exact: true });
}
async function setup(page: Page) {
  await installDesktopMock(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeEnabled();
  await page.evaluate(
    ({ catalog, result }) => {
      window.__ZG_TEST__.gdbCatalog = catalog;
      window.__ZG_TEST__.gdbReadResult = result;
    },
    { catalog, result },
  );
}
async function choose(page: Page) {
  const panel = await openPanel(page);
  await panel
    .getByRole("button", { name: "选择 GDB 目录", exact: true })
    .click();
  await expect(panel.getByLabel("GDB 图层", { exact: true })).toHaveValue(
    "roads",
  );
  return panel;
}

test("GDB导入保留范围字段与只读身份，快捷键仅导出且恢复后仍不可编辑", async ({
  page,
}) => {
  await setup(page);
  const panel = await choose(page);
  await expect(
    panel.getByText("未知（不扫描整层）", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByLabel("读取字段 name", { exact: true }),
  ).toBeChecked();
  await expect(
    panel.getByLabel("读取字段 payload", { exact: true }),
  ).not.toBeChecked();
  await panel.getByLabel("GDB 读取上限", { exact: true }).fill("1");
  await panel.getByLabel("按 WGS84 范围读取", { exact: true }).check();
  for (const [label, value] of [
    ["西经度", "110"],
    ["南纬度", "30"],
    ["东经度", "120"],
    ["北纬度", "40"],
  ])
    await panel.getByLabel(label, { exact: true }).fill(value);
  await expect(
    panel.getByLabel("允许 CGCS2000 与 WGS84 的近似转换", { exact: true }),
  ).not.toBeChecked();
  await panel
    .getByLabel("允许 CGCS2000 与 WGS84 的近似转换", { exact: true })
    .check();
  await panel.screenshot({ path: "output/gdb-import-panel.png" });
  await panel
    .getByRole("button", { name: "添加只读图层", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  const row = page.locator('.tree-row[data-source-kind="gdb"]');
  await expect(row).toHaveCount(1);
  await expect(row.getByLabel("只读图层", { exact: true })).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: "地图工具", exact: true });
  await expect(
    toolbar.getByRole("button", { name: "编辑", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await page.locator('td[data-field="name"]').first().dblclick();
  await expect(page.getByLabel("属性 name", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("dialog", { name: "删除选中要素", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Control+s");
  const exportPanel = page.getByRole("dialog", { name: "导出为", exact: true });
  await expect(exportPanel).toBeVisible();
  await exportPanel.getByRole("button", { name: "导出", exact: true }).click();
  await expect(exportPanel).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.snapshot &&
          JSON.parse(window.__ZG_TEST__.snapshot).layers[0].sourceKind,
      ),
    )
    .toBe("gdb");
  const stored = await page.evaluate(() => ({
    layer: JSON.parse(window.__ZG_TEST__.snapshot!).layers[0],
    read: window.__ZG_TEST__.calls.find((call) => call.command === "gdb_read")!,
    writes: window.__ZG_TEST__.calls.filter(
      (call) => call.command === "save_file",
    ),
  }));
  expect(stored.read.args).toMatchObject({
    sourceId: "ephemeral-gdb",
    layerName: "roads",
    limit: 1,
    fields: ["name"],
    bounds: [110, 30, 120, 40],
    allowApproximateDatum: true,
  });
  expect(stored.layer).toMatchObject({
    sourceKind: "gdb",
    sourcePath: catalog.path,
    gdb: {
      readLimit: 1,
      loadedCount: 1,
      truncated: true,
      allowApproximateDatum: true,
    },
  });
  expect(stored.layer.sourceId).toBeUndefined();
  expect(stored.writes).toHaveLength(1);
  expect(stored.writes[0].args.overwrite).toBe(false);
  expect(stored.writes[0].args.sourcePath).toBeUndefined();
  expect(stored.writes[0].args.sourceId).toBeUndefined();
  expect(
    JSON.parse(
      stored.writes[0].resolvedContent ?? String(stored.writes[0].args.content),
    ).features,
  ).toHaveLength(1);
  await installDesktopMock(
    page,
    await page.evaluate(() => window.__ZG_TEST__.snapshot),
  );
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(
    toolbar.getByRole("button", { name: "编辑", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.calls.filter((call) => call.command === "gdb_read")
            .length,
      ),
    )
    .toBe(0);
});

test("GDB取消读取及关闭面板会丢弃迟到结果，并允许重新选择来源", async ({
  page,
}) => {
  await setup(page);
  const panel = await choose(page);
  await panel.getByLabel("GDB 读取上限", { exact: true }).fill("1");
  await page.evaluate(() => window.__ZG_TEST__.heldCommands.push("gdb_read"));
  await panel
    .getByRole("button", { name: "添加只读图层", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "取消读取", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "取消读取", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "选择 GDB 目录", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.__ZG_TEST__.releaseCommand("gdb_read"));
  await expect
    .poll(() =>
      page.evaluate(() => window.__ZG_TEST__.completedCommands.gdb_read),
    )
    .toBe(1);
  await expect(page.locator('.tree-row[data-source-kind="gdb"]')).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.calls.filter(
            (call) => call.command === "gdb_cancel",
          ).length,
      ),
    )
    .toBe(1);
  await page.evaluate(() => window.__ZG_TEST__.heldCommands.push("gdb_open"));
  await panel
    .getByRole("button", { name: "选择 GDB ZIP", exact: true })
    .click();
  await panel.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => window.__ZG_TEST__.releaseCommand("gdb_open"));
  await expect
    .poll(() =>
      page.evaluate(() => window.__ZG_TEST__.completedCommands.gdb_open),
    )
    .toBe(2);
  await expect(page.locator('.tree-row[data-source-kind="gdb"]')).toHaveCount(
    0,
  );
  await openPanel(page);
  await expect(
    page.getByRole("button", { name: "选择 GDB 目录", exact: true }),
  ).toBeEnabled();
});

test("GDB范围表单拒绝跨日期变更线，不向后端提交错误范围", async ({ page }) => {
  await setup(page);
  const panel = await choose(page);
  await panel.getByLabel("按 WGS84 范围读取", { exact: true }).check();
  for (const [label, value] of [
    ["西经度", "170"],
    ["南纬度", "-10"],
    ["东经度", "-170"],
    ["北纬度", "10"],
  ])
    await panel.getByLabel(label, { exact: true }).fill(value);
  await panel
    .getByRole("button", { name: "添加只读图层", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("不支持跨日期变更线");
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some((call) => call.command === "gdb_read"),
    ),
  ).toBe(false);
});
