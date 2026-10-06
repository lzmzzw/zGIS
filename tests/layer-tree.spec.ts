import { test, expect } from "@playwright/test";
test("empty unified tree, context group and pointer sorting", async ({
  page,
}) => {
  await page.goto("/");
  const tree = page.getByRole("tree", { name: "图层树" });
  await expect(tree.getByRole("treeitem")).toHaveCount(0);
  await expect(page.locator(".layers-panel button")).toHaveCount(0);
  await tree.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "添加文件…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "新建分组…" }).click();
  await page.getByLabel("分组名称").fill("测绘");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  for (const name of ["a.geojson", "b.geojson"]) {
    await page
      .locator("input[type=file]")
      .setInputFiles({
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
  const b = await row("b.geojson").boundingBox(), target = await row("测绘").boundingBox();
  await page.mouse.move(b!.x + 100, b!.y + 18);
  await page.mouse.down();
  await page.mouse.move(target!.x + 100, target!.y + target!.height - 2, {steps: 12});
  await page.mouse.up();
  await expect(tree.locator(":scope > [role=none] > .tree-row .layer-text")).toHaveText(["测绘", "b.geojson"]);

});
