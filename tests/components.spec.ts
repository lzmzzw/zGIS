import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
for (const theme of ["dark", "light"])
  test(`themed dropdown pointer and keyboard at window edge (${theme})`, async ({
    page,
  }) => {
    await installDesktopMock(page);
    await page.goto("/");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
    await page.setViewportSize({ width: 960, height: 640 });
    const trigger = page.getByRole("button", { name: "底图", exact: true });
    await trigger.click();
    const panel = page.getByRole("region", { name: "底图服务" });
    await expect(panel).toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640);
    await page.screenshot({ path: `output/smoke/basemap-${theme}.png` });
    await page.getByLabel("显示底图", { exact: true }).uncheck();
    await expect(
      page.getByRole("radio", { name: "OpenStreetMap" }),
    ).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const themes = page.getByLabel("主题", { exact: true });
    await themes.focus();
    await page.keyboard.press("Space");
    await expect(
      themes.getByRole("option", { name: "浅色", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("main", { name: "后台设置" })).toBeVisible();
    await page.getByRole("button", { name: "地图", exact: true }).click();
    await page.getByLabel("底图类型").click();
    await expect(
      page
        .getByRole("option", { name: "OpenStreetMap", exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "空间分析 MCP", exact: true })
      .click();
    await page.screenshot({ path: `output/smoke/components-mcp-${theme}.png` });
  });

test("picker Escape retains import dialog and terminal follows theme without remount", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Codex Agent", exact: true }).click();
  const terminal = page.locator(".gis-agent-terminal .xterm");
  await expect(terminal).toBeVisible();
  await terminal.evaluate((el) =>
    el.setAttribute("data-test-session", "retained"),
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByLabel("主题", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await expect(terminal).toHaveAttribute("data-test-session", "retained");
  await expect(page.locator(".gis-agent-panel")).toHaveCSS(
    "background-color",
    "rgb(240, 241, 243)",
  );
  await page.getByRole("button", { name: "隐藏助手侧栏" }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "theme.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      '{"type":"Feature","geometry":{"type":"Point","coordinates":[116,40]},"properties":{}}',
    ),
  });
  const source = page.getByLabel("theme.geojson 来源坐标系", { exact: true });
  await source.click();
  await expect(
    source.getByRole("option", { name: "EPSG:4490", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await source.click();
  await source.getByRole("option", { name: "EPSG:4490", exact: true }).click();
  await expect(source).toHaveValue("EPSG:4490");
  await page.screenshot({ path: "output/smoke/components-import-light.png" });
});
