import { test, expect } from "@playwright/test";
test("empty unified tree, context group and pointer sorting", async ({
  page,
}) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "图层树" });
  await expect(tree.getByRole("treeitem")).toHaveCount(0);
  await expect(page.locator(".layers-panel button")).toHaveCount(0);
  await tree.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "添加文件图层" })).toBeVisible();
  await page.getByRole("menuitem", { name: "新建分组" }).click();
  await page.getByLabel("分组名称").fill("测绘");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  for (const name of ["a.geojson", "b.geojson"]) {
    await page.locator("input[type=file]").setInputFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.from(
        '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[116,40,8]}}',
      ),
    });
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  const row = (name: string) =>
    tree
      .getByRole("treeitem")
      .filter({ has: page.locator(".layer-text", { hasText: name }) })
      .first();
  const a = await row("a.geojson").boundingBox(),
    g = await row("测绘").boundingBox();
  await page.mouse.move(a!.x + 100, a!.y + 18);
  await page.mouse.down();
  await page.mouse.move(g!.x + 100, g!.y + 18, { steps: 12 });
  await page.mouse.up();
  await expect(tree.getByRole("group").locator(".layer-text")).toContainText(
    "a.geojson",
  );
  await row("测绘").getByRole("button", { name: "折叠 测绘" }).click();
  await expect(row("a.geojson")).toHaveCount(0);
  await row("测绘").getByRole("button", { name: "展开 测绘" }).click();
  await expect(row("a.geojson")).toBeVisible();
  const b = await row("b.geojson").boundingBox(),
    target = await row("测绘").boundingBox();
  await page.mouse.move(b!.x + 100, b!.y + 18);
  await page.mouse.down();
  await page.mouse.move(target!.x + 100, target!.y + target!.height - 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(
    tree.locator(":scope > [role=none] > .tree-row .layer-text"),
  ).toHaveText(["测绘", "b.geojson"]);
});

test("nested groups move as a whole into collapsed subgroups without cycles", async ({
  page,
}) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "图层树" });
  const row = (name: string) =>
    tree.locator(".tree-row").filter({
      has: page
        .locator(".layer-text")
        .filter({ hasText: new RegExp(`^${name}$`) }),
    });
  const create = async (name: string, parent?: string) => {
    if (parent) await row(parent).click({ button: "right" });
    else await tree.click({ button: "right", position: { x: 30, y: 300 } });
    await page
      .getByRole("menuitem", { name: parent ? "新建子分组" : "新建分组" })
      .click();
    await page.getByLabel("分组名称").fill(name);
    await page.getByRole("button", { name: "创建", exact: true }).click();
  };
  const drag = async (from: string, to: string) => {
    const a = await row(from).boundingBox(),
      b = await row(to).boundingBox();
    await page.mouse.move(
      a!.x + Math.min(110, a!.width - 20),
      a!.y + a!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      b!.x + Math.min(110, b!.width - 20),
      b!.y + b!.height / 2,
      { steps: 15 },
    );
    await page.mouse.up();
  };
  await create("甲组");
  await create("甲子组", "甲组");
  await create("甲孙组", "甲子组");
  await create("乙组");
  await create("乙子组", "乙组");
  await page.locator("input[type=file]").setInputFiles({
    name: "nested.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"Feature","properties":{"name":"保留属性"},"geometry":{"type":"Point","coordinates":[116,40,19]}}',
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await drag("nested.geojson", "甲孙组");
  await row("乙子组").getByRole("button", { name: "折叠 乙子组" }).click();
  await drag("甲组", "乙子组");
  await expect(row("甲组")).toHaveAttribute("aria-level", "3");
  await expect(row("甲子组")).toHaveAttribute("aria-level", "4");
  await expect(row("甲孙组")).toHaveAttribute("aria-level", "5");
  await expect(row("nested.geojson")).toHaveAttribute("aria-level", "6");
  await expect(row("乙子组")).toHaveAttribute("aria-expanded", "true");
  await expect(row("nested.geojson")).toHaveAttribute("aria-selected", "true");
  await drag("甲组", "甲孙组");
  await expect(row("甲组")).toHaveAttribute("aria-level", "3");
  await expect(row("nested.geojson")).toHaveAttribute("aria-level", "6");
  const moving = await row("甲组").boundingBox();
  const root = await page.getByRole("tree", {name:"图层树"}).boundingBox();
  await page.mouse.move(moving!.x + 110, moving!.y + moving!.height / 2);
  await page.mouse.down();
  await page.mouse.move(root!.x + 110, root!.y + root!.height - 20, {steps:15});
  await page.mouse.up();
  await expect(row("甲组")).toHaveAttribute("aria-level", "1");
  await expect(row("nested.geojson")).toHaveAttribute("aria-level", "4");
  await expect(
    page.locator(".layer-text").filter({ hasText: "nested.geojson" }),
  ).toHaveCount(1);
  await page.screenshot({ path: "output/smoke/nested-group-move.png" });
});
