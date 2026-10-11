import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test.beforeEach(async ({ page }) => {
  await installDesktopMock(page);
  await page.goto("/");
});

test("group dialogs contain focus, restore it and keep deletion explicit", async ({
  page,
}, testInfo) => {
  const tree = page.getByRole("tree", { name: "图层树" });
  await tree.click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建分组", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveJSProperty("open", true);
  await expect(page.getByLabel("分组名称")).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "创建", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("分组名称").fill("临时分组");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(tree).toBeFocused();
  const row = tree.getByRole("treeitem");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名分组", exact: true }).click();
  await expect(page.getByLabel("分组名称")).toBeFocused();
  expect(
    await page
      .getByLabel("分组名称")
      .evaluate((input: HTMLInputElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
  ).toEqual([0, 4]);
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "关闭", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "确定", exact: true }),
  ).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("group-rename.png") });
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(1);
  await expect(row).toBeFocused();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(tree).toBeFocused();
});

test("layer alias dialog selects current name and cancellation preserves it", async ({
  page,
}) => {
  await page.locator("input[type=file]").setInputFiles({
    name: "dialog.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[116,40]}}',
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  const row = page.getByRole("treeitem");
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "设置别名", exact: true }).click();
  const input = page.getByLabel("图层别名");
  await expect(input).toBeFocused();
  await input.fill("取消的别名");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(row).toContainText("dialog.geojson");
  await expect(row).toBeFocused();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "设置别名", exact: true }).click();
  await input.fill("已确认别名");
  await page.keyboard.press("Enter");
  await expect(row).toContainText("已确认别名");
  await expect(row).toBeFocused();
});

test("group dialog Escape closes once without changing the active drawing tool", async ({ page }) => {
  const tree = page.getByRole("tree", { name: "图层树" });
  await tree.click({ button: "right" });
  await page.getByRole("menuitem", { name: "新建分组", exact: true }).click();
  await page.getByLabel("分组名称").fill("绘制时分组");
  await page.keyboard.press("Enter");
  await page.locator("input[type=file]").setInputFiles({
    name: "drawing.geojson", mimeType: "application/json",
    buffer: Buffer.from('{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[116,40]}}'),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const draw = page.getByRole("button", { name: "新增点", exact: true });
  await draw.click();
  await tree.getByRole("treeitem").filter({ hasText: "绘制时分组" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除分组", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(draw).toHaveAttribute("aria-pressed", "true");
});
