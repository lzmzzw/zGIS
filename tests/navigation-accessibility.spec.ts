import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

test.beforeEach(async ({ page, baseURL }) => {
  await installDesktopMock(page);
  const appOrigin = new URL(baseURL!).origin;
  await page.route(
    (url) => /^https?:$/.test(url.protocol) && url.origin !== appOrigin,
    (route) => route.abort(),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeEnabled();
});

test("主菜单支持键盘选择、跳过禁用项目、退出与互斥", async ({ page }) => {
  const file = page
    .locator(".header-menu")
    .filter({ has: page.locator("summary", { hasText: /^文件$/ }) });
  const data = page
    .locator(".header-menu")
    .filter({ has: page.locator("summary", { hasText: /^数据$/ }) });
  const trigger = file.locator("summary");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    file.getByRole("button", { name: "新建", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    file.getByRole("button", { name: "打开", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    file.getByRole("button", { name: "新建", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    file.getByRole("button", { name: "打开", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    file.getByRole("button", { name: "新建", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(
    file.getByRole("button", { name: "新建", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    file.getByRole("button", { name: "打开", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(data.locator("summary")).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(
    data.getByRole("button", { name: "Mysql 数据源", exact: true }),
  ).toBeFocused();
  await trigger.click();
  await expect(page.locator(".header-menu[open]")).toHaveCount(1);
  await expect(data.locator("summary")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("菜单操作后的弹窗关闭恢复入口焦点", async ({ page }) => {
  const trigger = page
    .locator(".header-menus summary")
    .filter({ hasText: /^文件$/ });
  await trigger.click();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("底图展开进入当前选项，Escape 返回，焦点离开关闭", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "底图", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("radio", { name: "OpenStreetMap" }),
  ).toBeFocused();
  await page.locator(".basemap-card").click();
  await expect(
    page.getByRole("radio", { name: "OpenStreetMap" }),
  ).toBeChecked();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "工具", exact: true }).focus();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("region", { name: "底图服务", exact: true }),
  ).toHaveCount(0);
});
