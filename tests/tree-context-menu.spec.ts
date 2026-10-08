import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock, openDatabaseManager, addTestSource } from "./desktop.mock";

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

for (const engine of ["Mysql", "PostGIS"] as const) {
  test(`${engine} table entry uses a configured source and adds to the selected group`, async ({ page }) => {
    await setup(page);
    await openDatabaseManager(page, engine);
    await addTestSource(page, "已配置数据源", engine);
    const panel = page.getByRole("region", { name: `${engine} 数据源管理`, exact: true });
    await panel.getByRole("button", { name: "返回地图", exact: true }).click();
    await row(page, "子组").click({ button: "right" });
    await page.getByRole("menuitem", { name: `添加${engine}表图层`, exact: true }).click();
    await expect(panel.locator(".pg-source")).toContainText("已配置数据源");
    await panel.locator(".pg-table").filter({ hasText: /^roads$/ }).click();
    await panel.getByRole("button", { name: "添加到地图", exact: true }).click();
    await page.getByRole("button", { name: "载入", exact: true }).click();
    await expect(page.locator('.tree-row[data-node-kind="layer"]').filter({ hasText: "roads" })).toHaveAttribute("aria-level", "3");
  });
}

test("root, group and layer menus contain exactly the requested actions without horizontal overflow", async ({
  page,
}) => {
  await setup(page);
  const tree = page.getByRole("tree", { name: "图层树" });
  await tree.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem")).toHaveText([
    "新建分组",
    "新建文件",
    "添加文件图层",
    "添加Mysql表图层",
    "添加PostGIS表图层",
  ]);
  await expect(page.getByRole("menuitem", { name: "添加Mysql表图层", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "添加PostGIS表图层", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "添加文件图层", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await row(page, "父组").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "新建子分组",
    "重命名分组",
    "新建文件",
    "添加文件图层",
    "添加Mysql表图层",
    "添加PostGIS表图层",
    "解散分组",
    "删除分组",
  ]);
  await page.keyboard.press("Escape");
  await row(page, "points.geojson").click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText([
    "设置别名",
    "重命名",
    "移除",
  ]);
  await expect(
    page.getByRole("menuitem", { name: "重命名", exact: true }),
  ).toBeDisabled();
  expect(
    await page
      .getByRole("menu")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
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
  await page.getByRole("menuitem", { name: "新建子分组", exact: true }).click();
  await page.getByLabel("分组名称", { exact: true }).fill("新增子组");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(row(page, "父组")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "新增子组")).toHaveAttribute("aria-level", "2");
  await row(page, "子组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "解散分组", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "解散分组", exact: true }),
  ).toContainText("图层和子分组将按原有结构移到根层");
  await page.keyboard.press("Escape");
  await expect(row(page, "子组")).toBeFocused();
  await expect(row(page, "points.geojson")).toHaveAttribute("aria-level", "3");
  await row(page, "子组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "解散分组", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "解散", exact: true })
    .click();
  await expect(row(page, "子组")).toHaveCount(0);
  await expect(row(page, "points.geojson")).toHaveAttribute("aria-level", "1");
  await expect(row(page, "新增子组")).toHaveAttribute("aria-level", "2");
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.snapshot))
    .not.toContain('"id":"child"');
});

test("tree menus open tables, preserve drafts and confirm dirty layer removal", async ({
  page,
}) => {
  await setup(page);
  await row(page, "points.geojson").click();
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
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
  await expect(page.getByRole("menuitem", {name:"移除",exact:true})).toBeEnabled();
  await page.getByRole("menuitem", {name:"移除",exact:true}).click();
  await page.getByRole("dialog").getByRole("button", {name:"取消",exact:true}).click();
  await expect(draft).toHaveValue("未应用");
  await page.locator(".cell-editor input").press("Enter");
  await page.locator('.attribute-panel tbody tr.selected td[data-field="name"]').dblclick();
  await draft.fill("第二份未应用草稿");
  await row(page, "points.geojson").click({ button: "right" });
  await page.getByRole("menuitem", { name: "移除", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await expect(row(page, "points.geojson")).toBeVisible();
  await expect(draft).toHaveValue("第二份未应用草稿");
  await row(page, "points.geojson").click({button:"right"});
  await page.getByRole("menuitem", {name:"移除",exact:true}).click();
  await page.getByRole("dialog").getByRole("button", {name:"放弃并移除",exact:true}).click();
  await expect(row(page, "points.geojson")).toHaveCount(0);
  await expect(draft).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const snapshot = JSON.parse(window.__ZG_TEST__.snapshot!);
    return {layers:snapshot.layers.length, session:snapshot.session ?? null};
  })).toEqual({layers:0, session:null});
  expect(await page.evaluate(() => window.__ZG_TEST__.calls.filter((call) =>
    ["save_source_file", "commit_changes", "commit_mysql_changes"].includes(call.command),
  ))).toEqual([]);
});

test("deleting a group confirms recursive removal while cancel preserves the tree", async ({
  page,
}) => {
  await setup(page);
  await row(page, "父组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("磁盘文件保留");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(row(page, "points.geojson")).toBeVisible();
  await row(page, "父组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.locator(".tree-row")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(window.__ZG_TEST__.snapshot!).layers.length,
      ),
    )
    .toBe(0);
});

test("file rename uses the registered source, preserves alias and handles collision", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    window.__ZG_TEST__.dropFiles([
      {
        name: "source.geojson",
        sourceId: "native-source",
        bytes: [
          ...new TextEncoder().encode(
            '{"type":"FeatureCollection","features":[]}',
          ),
        ],
      },
    ]),
  );
  await row(page, "source.geojson").click({ button: "right" });
  await page.getByRole("menuitem", { name: "设置别名", exact: true }).click();
  await page.getByLabel("图层别名", { exact: true }).fill("工作别名");
  await page.getByRole("button", { name: "确定", exact: true }).click();
  const rename = async (name: string) => {
    await row(page, "工作别名").click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await page.getByLabel("文件名称", { exact: true }).fill(name);
    await page.getByRole("button", { name: "确定", exact: true }).click();
  };
  await page.evaluate(() => {
    window.__ZG_TEST__.saveError = "同名文件不能覆盖";
  });
  await rename("taken");
  await expect(page.getByRole("alert")).toContainText("同名文件不能覆盖");
  await page.evaluate(() => {
    window.__ZG_TEST__.saveError = "";
  });
  await rename("renamed");
  await expect(page.locator(".operation-status")).toContainText("文件已重命名");
  await expect(row(page, "工作别名")).toBeVisible();
  const calls = await page.evaluate(() =>
    window.__ZG_TEST__.calls.filter((c) => c.command === "rename_source_file"),
  );
  expect(calls.at(-1)!.args).toEqual({
    sourceId: "native-source",
    newName: "renamed",
  });
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.snapshot))
    .toContain("renamed.geojson");
});
test("new file from a group is inserted into that group", async ({ page }) => {
  await setup(page);
  await row(page, "子组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建文件", exact: true }).click();
  await page.getByRole("button", { name: "创建并编辑", exact: true }).click();
  await expect(page.locator('[data-node-kind="layer"]').last()).toHaveAttribute(
    "aria-level",
    "3",
  );
  await row(page, "父组").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("请先保存并退出");
  await expect(row(page, "父组")).toBeVisible();
});
