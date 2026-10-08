import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function layout(page: Page) {
  const sidebar = await page.locator(".right-sidebar").boundingBox();
  const column = await page.locator(".map-column").boundingBox();
  const map = await page.locator(".map-surface").boundingBox();
  const table = await page.locator(".attribute-panel").boundingBox();
  expect(sidebar).not.toBeNull();
  expect(column!.x + column!.width).toBeLessThanOrEqual(sidebar!.x + 1);
  expect(map!.x + map!.width).toBeLessThanOrEqual(sidebar!.x + 1);
  expect(table!.x + table!.width).toBeLessThanOrEqual(sidebar!.x + 1);
  expect(map!.width).toBeGreaterThanOrEqual(359);
  return sidebar!;
}

test("both docks resize by drag and keyboard, keep independent widths and never cover the workspace", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await page
    .getByRole("button", { name: "空间分析工具箱", exact: true })
    .click();
  const resize = page.getByRole("separator", { name: "调整工具箱侧栏宽度" });
  await expect(resize).toHaveAttribute("aria-valuenow", "368");
  const box = await resize.boundingBox();
  await page.mouse.move(box!.x + 2, box!.y + 100);
  await page.mouse.down();
  await page.mouse.move(box!.x - 130, box!.y + 100);
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "500");
  await layout(page);
  await page.getByRole("button", { name: "Codex Agent", exact: true }).click();
  const agentResize = page.getByRole("separator", {
    name: "调整Agent侧栏宽度",
  });
  await expect(agentResize).toHaveAttribute("aria-valuenow", "368");
  await agentResize.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(agentResize).toHaveAttribute("aria-valuenow", "388");
  const agentBox = await agentResize.boundingBox();
  await page.mouse.move(agentBox!.x + 2, agentBox!.y + 100);
  await page.mouse.down();
  await page.mouse.move(agentBox!.x - 58, agentBox!.y + 100);
  await page.mouse.up();
  await expect(agentResize).toHaveAttribute("aria-valuenow", "448");
  await layout(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.locator(".right-sidebar")).toBeHidden();
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await expect(agentResize).toHaveAttribute("aria-valuenow", "448");
  await page.reload();
  await page
    .getByRole("button", { name: "空间分析工具箱", exact: true })
    .click();
  await expect(resize).toHaveAttribute("aria-valuenow", "500");
  await page.getByRole("button", { name: "Codex Agent", exact: true }).click();
  await expect(agentResize).toHaveAttribute("aria-valuenow", "448");
  await page.getByRole("button", { name: "隐藏助手侧栏" }).click();
  await expect(page.locator(".right-sidebar")).toBeHidden();
});

for (const theme of ["dark", "light"]) {
  test(`${theme} narrow window clamps widths and restores them when enlarged`, async ({
    page,
  }) => {
    await installDesktopMock(page);
    await page.addInitScript(
      (theme) => localStorage.setItem("zgis.theme", theme),
      theme,
    );
    await page.goto("/");
    await page
      .getByRole("button", { name: "Codex Agent", exact: true })
      .click();
    const resize = page.getByRole("separator", { name: "调整Agent侧栏宽度" });
    await resize.focus();
    await page.keyboard.press("End");
    await expect(resize).toHaveAttribute("aria-valuenow", "720");
    await page.setViewportSize({ width: 960, height: 720 });
    await expect(resize).toHaveAttribute("aria-valuenow", "340");
    await layout(page);
    await page.screenshot({ path: `output/agent-dock-${theme}.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(resize).toHaveAttribute("aria-valuenow", "720");
    await resize.focus();
    await page.keyboard.press("Home");
    await expect(resize).toHaveAttribute("aria-valuenow", "320");
    await page
      .getByRole("button", { name: "空间分析工具箱", exact: true })
      .click();
    await layout(page);
    await page.screenshot({ path: `output/toolbox-dock-${theme}.png` });
  });
}
