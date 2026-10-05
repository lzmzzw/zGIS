import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test("one header entry opens independent settings and preserves edit draft", async ({page}) => {
 await page.goto("/");
 await expect(page.getByRole("button", {name:"设置",exact:true})).toHaveCount(1);
 await expect(page.getByRole("button", {name:"底图设置",exact:true})).toHaveCount(0);
 await expect(page.locator(".header-menus").getByRole("button", {name:"设置…",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"城市示例",exact:true}).filter({visible:true}).click();
 await page.locator(".header-actions").getByRole("button",{name:"属性表",exact:true}).click();
 await page.locator("tbody tr").first().click();
 await page.getByRole("button",{name:"编辑",exact:true}).click();
 await page.getByRole("textbox",{name:"属性 城市",exact:true}).fill("尚未应用的草稿");
 await page.getByRole("button",{name:"设置",exact:true}).click();
 await expect(page.getByRole("main",{name:"后台设置"})).toBeVisible();
 await expect(page.locator(".workspace")).toBeHidden();
 await expect(page.getByRole("dialog")).toHaveCount(0);
 await page.getByLabel("主题",{exact:true}).selectOption("light");
 await page.keyboard.press("Escape");
 await expect(page.locator(".workspace")).toBeVisible();
 await expect(page.getByRole("textbox",{name:"属性 城市",exact:true})).toHaveValue("尚未应用的草稿");
 await expect(page.locator("tbody tr.selected")).toHaveCount(1);
 await expect(page.locator("tbody tr")).toHaveCount(4);
 await expect(page.getByRole("button",{name:"设置",exact:true})).toBeFocused();
});
test("MCP stays active across settings categories and return to map", async ({page}) => {
 await installDesktopMock(page); await page.goto("/");
 await expect(page.locator(".header-actions").getByRole("button",{name:"空间分析 MCP",exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:"设置",exact:true}).click();
 await page.getByRole("button",{name:"空间分析 MCP",exact:true}).click();
 await page.getByRole("button",{name:"启用 MCP",exact:true}).click();
 await page.getByRole("button",{name:"地图",exact:true}).click();
 await page.getByRole("button",{name:"返回地图",exact:true}).click();
 await page.getByRole("button",{name:"设置",exact:true}).click();
 await page.getByRole("button",{name:"空间分析 MCP",exact:true}).click();
 await expect(page.getByRole("button",{name:"停止 MCP",exact:true})).toBeVisible();
 await expect(page.getByLabel("MCP 访问令牌")).toHaveAttribute("type","password");
});
test("settings fit desktop minimum and both themes", async ({page}) => {
 await installDesktopMock(page); await page.goto("/");
 await page.getByRole("button",{name:"设置",exact:true}).click();
 for (const theme of ["dark","light"]) {
  await page.getByRole("button",{name:"外观",exact:true}).click();
  await page.getByLabel("主题",{exact:true}).selectOption(theme);
  for (const width of [1440,960]) {
   await page.setViewportSize({width,height:800});
   await page.getByRole("button",{name:"空间分析 MCP",exact:true}).click();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
   await expect(page.getByRole("button",{name:"返回地图",exact:true})).toBeVisible();
   await expect(page.getByRole("button",{name:"启用 MCP",exact:true})).toBeVisible();
   await page.screenshot({path:`output/smoke/settings-${theme}-${width}.png`});
  }
 }
});
