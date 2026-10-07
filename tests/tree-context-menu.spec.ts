import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const snapshot = JSON.stringify({
  version: 2,
  layers: [
    {
      id: "point",
      name: "points.geojson",
      visible: true,
      color: "#5479b6",
      sourceKind: "geojson",
      features: [
        {
          id: "point-f",
          geometry: { type: "Point", coordinates: [116, 40] },
          properties: { name: "测量点" },
        },
      ],
    },
  ],
  tree: [
    {
      kind: "group",
      id: "parent",
      name: "父组",
      visible: true,
      collapsed: false,
      children: [
        {
          kind: "group",
          id: "child",
          name: "子组",
          visible: true,
          collapsed: false,
          children: [{ kind: "layer", id: "point" }],
        },
      ],
    },
  ],
});
const row = (page: Page, name: string) =>
  page.locator(".tree-row").filter({
    has: page.locator(".layer-text").filter({
      hasText: new RegExp(
        `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\*)?$`,
      ),
    }),
  });
async function setup(page: Page) {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(row(page, "points.geojson")).toBeVisible();
}

test("root and node menus expose only relevant actions; disabled moves reflect current position", async ({
  page,
}) => {
  await setup(page);
  const tree = page.getByRole("tree", { name: "图层树" });
  await tree.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem")).toHaveText([
    "添加文件…",
    "添加 PostGIS…",
    "新建分组…",
  ]);
  await page.keyboard.press("Escape");
  await expect(tree).toBeFocused();
  await row(page, "父组").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "移到顶层", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "上移", exact: false }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "新建子分组…", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await row(page, "points.geojson").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "新建分组…", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "添加文件…", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "缩放至图层", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("menuitem", { name: "打开属性表", exact: true }),
  ).toBeEnabled();
  await page.getByRole("menuitem", { name: "隐藏图层", exact: true }).click();
  await row(page, "points.geojson").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "显示图层", exact: true }),
  ).toBeEnabled();
  await page.getByRole("menuitem", { name: "移到顶层", exact: true }).click();
  await expect(row(page, "points.geojson")).toHaveAttribute("aria-level", "1");
  await row(page, "points.geojson").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "移到顶层", exact: true }),
  ).toBeDisabled();
});

test("creating children expands the parent; dissolving confirms and preserves nested layers", async ({
  page,
}) => {
  await setup(page);
  await row(page, "父组")
    .getByRole("button", { name: "折叠 父组", exact: true })
    .click();
  await row(page, "父组").focus();
  await page.keyboard.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "新建子分组…", exact: true })
    .click();
  await page.getByLabel("分组名称", { exact: true }).fill("新增子组");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(row(page, "父组")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "新增子组")).toHaveAttribute("aria-level", "2");
  await row(page, "子组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "解散分组…", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "解散分组", exact: true }),
  ).toContainText("图层和子分组将保留在上一级");
  await page.keyboard.press("Escape");
  await expect(row(page, "子组")).toBeFocused();
  await expect(row(page, "points.geojson")).toHaveAttribute("aria-level", "3");
  await row(page, "子组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "解散分组…", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "解散", exact: true })
    .click();
  await expect(row(page, "子组")).toHaveCount(0);
  await expect(row(page, "points.geojson")).toHaveAttribute("aria-level", "2");
  await expect(row(page, "新增子组")).toHaveAttribute("aria-level", "2");
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.snapshot))
    .not.toContain('"id":"child"');
});

test("tree menus open tables, preserve drafts and confirm dirty layer removal", async ({
  page,
}) => {
  await setup(page);
  await row(page, "points.geojson").click({ button: "right" });
  await page.getByRole("menuitem", { name: "打开属性表", exact: true }).click();
  await expect(page.locator(".table-scroll")).toBeVisible();
  await page.locator("tbody tr").first().click();
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await page
    .locator('.attribute-panel tbody tr.selected td[data-field="name"]')
    .dblclick();
  const draft = page.getByRole("textbox", { name: "属性 name", exact: true });
  await draft.fill("未应用");
  await row(page, "父组").click({ button: "right" });
  for (const item of await page.getByRole("menuitem").all())
    await expect(item).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(draft).toHaveValue("未应用");
  await row(page, "points.geojson").click({ button: "right" });
  for (const item of await page.getByRole("menuitem").all())
    await expect(item).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await row(page, "points.geojson").click({ button: "right" });
  await page.getByRole("menuitem", { name: "移除图层…", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(row(page, "points.geojson")).toBeVisible();
});
