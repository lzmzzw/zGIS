import { expect } from "@playwright/test";
import assert from "node:assert/strict";

export async function contextMenuSmoke(page) {
  const menu = page.getByRole("menu");
  const tree = page.getByRole("tree", { name: "图层树" });
  const layer = tree.locator('[data-node-kind="layer"]').first();
  const firstRow = page.locator(".attribute-panel tbody tr").first();
  const targetRow = page.locator(".attribute-panel tbody tr").nth(1);
  const search = page.getByRole("textbox", { name: "搜索属性", exact: true });
  const prevented = async (locator) => locator.evaluate((element) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(await prevented(page.locator(".app-header")), true);
  await expect(menu).toHaveCount(0);
  assert.equal(await prevented(search), false);
  await expect(menu).toHaveCount(0);

  const map = page.getByLabel("地理数据地图", { exact: true });
  await map.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "地图操作", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "复制经纬度", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(map).toBeFocused();

  await layer.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "图层操作", exact: true })).toBeVisible();
  for (const name of ["设置别名", "移除"])
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
  for (const name of ["添加文件图层", "新建分组", "新建子分组"])
    await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem")).toHaveText(["设置别名", "重命名", "移除"]);
  assert.equal(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await page.keyboard.press("Escape");
  await expect(layer).toBeFocused();

  await targetRow.locator('td[data-field="城市"]').click({ button: "right" });
  await expect(targetRow).toHaveAttribute("aria-selected", "true");
  await expect(firstRow).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("menu", { name: "要素操作", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveText(["定位到要素", "JSON属性预览", "WKT几何预览", "复制单元格", "复制JSON属性", "复制WKT几何", "删除要素"]);
  await expect(page.getByRole("button", {name:"定位到选中要素",exact:true})).toHaveCount(0);
  for (const name of ["定位到要素", "JSON属性预览", "WKT几何预览", "复制单元格", "复制JSON属性", "复制WKT几何"])
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(targetRow).toBeFocused();
  await firstRow.click();

  const fieldSummary = page.locator('.attribute-panel thead summary').filter({ hasText: /^城市$/ });
  await fieldSummary.focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menu", { name: "字段操作", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveText(["复制字段名", "添加字段", "重命名字段", "删除字段"]);
  for (const name of ["复制字段名", "添加字段"])
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(fieldSummary).toBeFocused();

  await firstRow.locator('td[data-field="城市"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "JSON属性预览", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "JSON属性预览", exact: true });
  const json = dialog.getByRole("textbox", { name: "JSON 属性", exact: true });
  await expect(json).toHaveAttribute("readonly", "");
  await expect(dialog.getByRole("button", {name:"应用属性",exact:true})).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(firstRow).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "output/desktop/context-menu-verified.png" });
  console.log("PASS: native header suppression, text inputs, map/tree/record/field menus, selection, focus and dialog Escape isolation");
}
