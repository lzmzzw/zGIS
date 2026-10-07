import { test, expect, type Locator } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function iconSize(locator: Locator, size: number) {
  await expect(locator).toHaveCSS("width", `${size}px`);
  await expect(locator).toHaveCSS("height", `${size}px`);
}

for (const theme of ["dark", "light"]) {
  test(`shared typography and icons preserve desktop layout (${theme})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDesktopMock(page);
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await expect(page.locator(".settings-page h1")).toHaveCSS(
      "font-size",
      "19px",
    );
    await expect(page.locator(".settings-page h2")).toHaveCSS(
      "font-size",
      "17px",
    );
    await expect(page.locator(".settings-fields > label > span")).toHaveCSS(
      "font-size",
      "13px",
    );
    await iconSize(
      page
        .getByRole("button", { name: "返回地图", exact: true })
        .locator(".lucide"),
      16,
    );
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
    await page.locator("input[type=file]").setInputFiles({
      name: "layout.geojson",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          type: "Feature",
          geometry: { type: "Point", coordinates: [116, 40] },
          properties: { 数值: 1, 名称: "示例" },
        }),
      ),
    });
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByRole("button", { name: "展开属性表", exact: true }).click();

    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".brand-mark")).toHaveCSS("width", "19px");
      await expect(page.locator(".brand-mark")).toHaveCSS("height", "19px");
      await expect(page.locator(".app-header")).toHaveCSS("height", "44px");
      await expect(page.locator(".layers-panel")).toHaveCSS("width", "260px");
      await expect(page.locator(".attribute-panel")).toHaveCSS(
        "height",
        "250px",
      );
      await iconSize(
        page
          .getByRole("button", { name: "手形", exact: true })
          .locator(".lucide"),
        18,
      );
      await iconSize(
        page
          .getByRole("button", { name: "编辑属性", exact: true })
          .locator(".lucide"),
        16,
      );
      await iconSize(page.locator(".search-field .lucide"), 14);
      await iconSize(
        page
          .getByRole("button", { name: "底图", exact: true })
          .locator(".lucide"),
        20,
      );
      await expect(page.locator(".map-coordinates")).toHaveCSS(
        "font-size",
        "11px",
      );
      await expect(page.locator(".map-coordinates")).toHaveCSS(
        "font-family",
        "Consolas, monospace",
      );
      await page.getByRole("button", { name: "编辑属性", exact: true }).focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(
        page.getByRole("button", { name: "编辑属性", exact: true }),
      ).toHaveCSS("outline-style", "solid");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `output/smoke/ui-style-${theme}-${width}.png`,
      });
    }

    await page.locator("tbody tr").first().click();
    await page.getByRole("button", { name: "编辑属性", exact: true }).click();
    await page.locator('tbody tr.selected td[data-field="数值"]').dblclick();
    await page.getByLabel("属性 数值", { exact: true }).fill("invalid");
    await page.getByLabel("属性 数值", { exact: true }).press("Enter");
    await expect(page.locator(".cell-error")).toHaveCSS(
      "color",
      theme === "dark" ? "rgb(238, 146, 146)" : "rgb(184, 62, 62)",
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Codex Agent", exact: true })
      .click();
    const close = page.getByRole("button", {
      name: "隐藏助手侧栏",
      exact: true,
    });
    await iconSize(close.locator(".lucide"), 16);
    await expect(close).toHaveCSS("height", "32px");
    await close.click();
    expect(errors).toEqual([]);
  });
}
