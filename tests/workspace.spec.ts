import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test("empty header can drag while menus and window buttons remain interactive", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  const title = page.locator(".document-title");
  const bounds = await title.boundingBox();
  expect(bounds?.height).toBeGreaterThan(20);
  await title.click();
  await page.locator(".brand-mark").click();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "plugin:window|start_dragging",
        ).length,
    ),
  ).toBe(2);
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await expect(
    page
      .locator(".header-menus")
      .getByRole("button", { name: "打开文件…", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "最小化", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "plugin:window|start_dragging",
        ).length,
    ),
  ).toBe(2);
  await title.dblclick();
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) => call.command === "plugin:window|toggle_maximize",
      ),
    ),
  ).toBe(true);
});

const snapshot = JSON.stringify(
  ["first", "second"].map((name) => ({
    id: name,
    name,
    visible: true,
    color: "#5479b6",
    sourceKind: "postgis",
    dirty: true,
    db: { connectionId: "old" },
    sourceId: "old-source",
    features: [
      {
        id: name,
        geometry: { type: "Point", coordinates: [116, 40] },
        properties: { value: 1 },
        baseline: "old",
        dbKey: [1],
      },
    ],
  })),
);
async function exit(page: Page) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "退出", exact: true }).click();
}

test("native open continues into worker import after dialog busy state", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page
    .locator(".app-header")
    .getByRole("button", { name: "打开文件…", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-row")).toContainText("native.geojson");
});

test("restored CSV saves as GeoJSON from the main file menu", async ({
  page,
}) => {
  const layers = JSON.parse(snapshot);
  layers[0].name = "points.csv";
  layers[0].sourceKind = "csv";
  await installDesktopMock(page, JSON.stringify([layers[0]]));
  await page.goto("/");
  await expect(page.locator(".operation-status")).toContainText("已恢复");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page
    .locator(".app-header")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.locator(".operation-status")).toContainText("保存完成");
  const save = await page.evaluate(() =>
    window.__ZG_TEST__.calls.find((call) => call.command === "save_file")!,
  );
  expect(save.args.suggestedName).toBe("points.geojson");
  expect(JSON.parse(String(save.args.content)).type).toBe("FeatureCollection");
});

const savedLayers = (raw: string) => {
  const saved = JSON.parse(raw);
  return Array.isArray(saved) ? saved : saved.layers;
};
async function editProperty(page: Page) {
  await page
    .locator(".header-actions")
    .getByRole("button", { name: "属性表", exact: true })
    .click();
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await editValueCell(page);
}

async function editValueCell(page: Page) {
  await page
    .locator('.attribute-panel tbody tr.selected td[data-field="value"]')
    .dblclick();
}

test("dirty restored layers exit without a prompt and all work copies are saved", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".operation-status")).toContainText("已恢复 2");
  await exit(page);
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot!);
  expect(savedLayers(raw).map((layer: { name: string }) => layer.name)).toEqual(
    ["first", "second"],
  );
  expect(raw).not.toMatch(/baseline|dbKey|sourceId|connectionId/);
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) =>
          call.command === "save_file" || call.command === "commit_changes",
      ),
    ),
  ).toBe(false);
});

test("editing exit can be cancelled; confirmation keeps applied changes but not property drafts", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".operation-status")).toContainText("已恢复");
  await editProperty(page);
  await page
    .getByRole("textbox", { name: "属性 value", exact: true })
    .fill("2");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await editValueCell(page);
  await page
    .getByRole("textbox", { name: "属性 value", exact: true })
    .fill("999");
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: "退出 zGIS", exact: true }),
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "属性 value", exact: true }),
  ).toHaveValue("999");
  await exit(page);
  await page
    .getByRole("button", { name: "退出并保留工作区", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  const layers = savedLayers(
    await page.evaluate(() => window.__ZG_TEST__.snapshot!),
  );
  expect(layers[0].features[0].properties.value).toBe(2);
  expect(layers).toHaveLength(2);
});

test("vertex editing prompts even before geometry changes", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".operation-status")).toContainText("已恢复");
  await page.getByRole("button", { name: "编辑顶点", exact: true }).click();
  await exit(page);
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: "退出 zGIS", exact: true }),
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
});

test("backup failure prevents normal exit and allows a successful retry", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".operation-status")).toContainText("已恢复");
  await page.evaluate(() => {
    window.__ZG_TEST__.backupError = "snapshot failed";
  });
  await exit(page);
  await expect(page.getByRole("alert")).toContainText("snapshot failed");
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
  expect(await page.evaluate(() => window.__ZG_TEST__.snapshot)).toBe(snapshot);
  await page.evaluate(() => {
    window.__ZG_TEST__.backupError = "";
  });
  await page.getByRole("button", { name: "关闭错误", exact: true }).click();
  await exit(page);
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
});

test("invalid recovery is not overwritten and exit is blocked", async ({
  page,
}) => {
  await installDesktopMock(page, "invalid snapshot");
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("恢复副本加载失败");
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => window.__ZG_TEST__.snapshot)).toBe(
    "invalid snapshot",
  );
  await page.getByRole("button", { name: "关闭错误", exact: true }).click();
  await exit(page);
  await expect(page.getByRole("alert")).toContainText("避免覆盖原副本");
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
  expect(await page.evaluate(() => window.__ZG_TEST__.snapshot)).toBe(
    "invalid snapshot",
  );
});

test("immediate native close flushes new empty groups instead of a stale autosnapshot", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "图层树" });
  await tree.click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建分组…" }).click();
  await page.getByLabel("分组名称").fill("空分组");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(tree).toContainText("空分组");
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(1800);
  const saved = JSON.parse(
    await page.evaluate(() => window.__ZG_TEST__.snapshot!),
  );
  expect(saved.layers).toEqual([]);
  expect(saved.tree[0]).toMatchObject({
    kind: "group",
    name: "空分组",
    children: [],
  });
});
