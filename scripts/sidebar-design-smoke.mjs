import { expect } from "@playwright/test";
import assert from "node:assert/strict";

// Run only from the isolated installed smoke, without launching an Agent session.
export async function sidebarDesignSmoke(page) {
  const originalTheme = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  const setTheme = async (theme) => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
  };
  const toolbox = page.locator(".processing-toolbox");
  if (!(await toolbox.isVisible()))
    await page.getByRole("button", { name: "工具", exact: true }).click();
  const toolResize = page.getByRole("separator", { name: "调整工具侧栏宽度" });
  await toolResize.focus();
  await page.keyboard.press("Home");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await expect(toolResize).toHaveAttribute("aria-valuenow", "400");
  const option = toolbox.getByRole("button", { name: "缓冲区", exact: true });
  if (!(await option.isVisible()))
    await toolbox
      .getByRole("button", { name: "叠加分析", exact: true })
      .click();
  if ((await option.getAttribute("aria-pressed")) !== "true")
    await option.click();

  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    await toolbox.locator(".processing-configuration").evaluate((node) => {
      node.scrollTop = 0;
    });
    const measurements = await toolbox.evaluate((node) => {
      const region = node
        .querySelector(".processing-browser")
        .getBoundingClientRect();
      const heading = node
        .querySelector(".processing-tool-title")
        .getBoundingClientRect();
      const groups = node.querySelectorAll("fieldset");
      const channels = (color) =>
        color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number);
      const luminance = (rgb) =>
        rgb
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          })
          .reduce(
            (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i],
            0,
          );
      const surface = getComputedStyle(node).backgroundColor;
      const colors = [
        [getComputedStyle(node).color, surface],
        [
          getComputedStyle(node.querySelector(".processing-description")).color,
          surface,
        ],
        [
          getComputedStyle(node.querySelector(".processing-run")).color,
          getComputedStyle(node.querySelector(".processing-run"))
            .backgroundColor,
        ],
      ];
      return {
        height: region.height,
        mainGap: heading.top - region.bottom,
        groupGap:
          groups[1].getBoundingClientRect().top -
          groups[0].getBoundingClientRect().bottom,
        neutral: colors.flat().every((color) => {
          const rgb = channels(color);
          return Math.max(...rgb) - Math.min(...rgb) <= 8;
        }),
        contrast: colors.map(([foreground, background]) => {
          const values = [
            luminance(channels(foreground)),
            luminance(channels(background)),
          ];
          return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
        }),
      };
    });
    assert.equal(measurements.height, 288);
    assert.equal(measurements.mainGap, 36);
    assert.equal(measurements.groupGap, 32);
    assert.ok(measurements.mainGap > measurements.groupGap);
    assert.ok(measurements.neutral);
    assert.ok(
      measurements.contrast.every((ratio) => ratio >= 4.5),
      `Insufficient ${theme} contrast: ${measurements.contrast}`,
    );
    await page
      .locator(".right-sidebar")
      .screenshot({ path: `output/desktop/sidebar-design-${theme}-tools.png` });
    await page
      .getByRole("button", { name: "Codex Agent", exact: true })
      .click();
    const agentResize = page.getByRole("separator", {
      name: "调整Agent侧栏宽度",
    });
    await expect(agentResize).toHaveAttribute("aria-valuenow", "400");
    await page
      .locator(".right-sidebar")
      .screenshot({ path: `output/desktop/sidebar-design-${theme}-agent.png` });
    await agentResize.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(agentResize).toHaveAttribute("aria-valuenow", "420");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await expect(toolResize).toHaveAttribute("aria-valuenow", "420");
    await toolResize.focus();
    await page.keyboard.press("ArrowRight");
    await expect(toolResize).toHaveAttribute("aria-valuenow", "400");
  }
  await toolbox.locator(".processing-help summary").click();
  await expect(toolbox.locator(".processing-help")).toHaveAttribute("open", "");
  await expect(
    toolbox.getByRole("button", { name: "运行分析", exact: true }),
  ).toBeVisible();
  await toolbox
    .getByRole("button", { name: "关闭工具侧栏", exact: true })
    .click();
  await setTheme(originalTheme ?? "dark");
  console.log(
    "PASS: installed neutral dark/light sidebars, readable contrast, fixed 288px directory, 36/32px whitespace, shared width and reachable help/action",
  );
}
