import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const snapshot = JSON.stringify([
  {
    id: "mac-layer",
    name: "mac.geojson",
    sourceKind: "geojson",
    sourcePath: "/Users/test/mac.geojson",
    sourceHash: "original-hash",
    visible: true,
    color: "#5479b6",
    dirty: true,
    features: [
      {
        id: "point",
        geometry: { type: "Point", coordinates: [116, 40] },
        properties: { value: 1 },
      },
    ],
  },
]);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".layer-row")).toContainText("mac.geojson");
});

test("macOS reserves the native traffic lights and uses system fonts in both themes", async ({
  page,
}) => {
  await expect(page.locator("html")).toHaveAttribute("data-platform", "macos");
  await expect(page.locator(".window-controls")).toHaveCount(0);
  await expect(page.locator(".app-header")).toHaveCSS("padding-left", "88px");
  await expect(page.locator(".app-header")).toHaveCSS(
    "font-family",
    /-apple-system/,
  );
  await page.setViewportSize({ width: 960, height: 640 });
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    const brand = await page.locator(".brand-mark").boundingBox();
    expect(brand!.x).toBeGreaterThanOrEqual(88);
    const settings = await page
      .getByRole("button", { name: "设置", exact: true })
      .boundingBox();
    expect(settings!.x + settings!.width).toBeLessThanOrEqual(960);
    await page.screenshot({ path: `output/macos-arm64/ui-${theme}.png` });
  }
});

test("Command-S saves the source and native close keeps the editing confirmation", async ({
  page,
}) => {
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.keyboard.press("Control+s");
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter((c) => c.command === "save_file")
          .length,
    ),
  ).toBe(0);
  await page.keyboard.press("Meta+s");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.calls.filter((c) => c.command === "save_file")
            .length,
      ),
    )
    .toBe(1);
  const save = await page.evaluate(() =>
    window.__ZG_TEST__.calls.find((c) => c.command === "save_file"),
  );
  expect(save?.args.sourcePath).toBe("/Users/test/mac.geojson");
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect(
    page.getByRole("heading", { name: "退出 zGIS", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回编辑", exact: true }).click();
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
});
