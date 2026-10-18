import { test, expect, type Page, type Locator } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import { analysisTools } from "../src/analysisTools";
import shared from "../src/i18n/shared";

const fixture = JSON.stringify({
  version: 3,
  layers: [
    {
      id: "input",
      name: "zones.geojson",
      features: [
        {
          id: "zone-1",
          properties: { name: "zone", group: "A" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [116, 40],
                [116.01, 40],
                [116.01, 40.01],
                [116, 40.01],
                [116, 40],
              ],
            ],
          },
        },
      ],
    },
  ],
  tree: [{ kind: "layer", id: "input" }],
});

async function start(page: Page) {
  await installDesktopMock(page, fixture);
  await page.addInitScript(() => localStorage.setItem("zgis.locale", "en"));
  await page.goto("/");
  await expect(page.locator(".layer-text")).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

async function switchLocale(page: Page, locale: "en" | "zh-CN") {
  // A second tab's language preference must update already-open shared panels.
  await page.evaluate((locale) => {
    localStorage.setItem("zgis.locale", locale);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "zgis.locale", newValue: locale }),
    );
  }, locale);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

async function noChineseUi(root: Locator) {
  const fragments = await root.evaluate((element) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (
        parent &&
        parent.getClientRects().length &&
        /\p{Script=Han}/u.test(node.textContent ?? "")
      )
        found.push(node.textContent ?? "");
    }
    for (const item of [element, ...element.querySelectorAll("*")]) {
      if (!item.getClientRects().length) continue;
      for (const attribute of ["aria-label", "title", "placeholder"]) {
        const value = item.getAttribute(attribute);
        if (value && /\p{Script=Han}/u.test(value))
          found.push(`${attribute}: ${value}`);
      }
    }
    return found;
  });
  expect(fragments).toEqual([]);
}

test("all shared tools translate labels, help, parameters and validation while preserving drafts", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const box = page.locator(".processing-toolbox");
  for (const toggle of await box.locator(".processing-group-toggle").all())
    await toggle.click();
  await expect(box.locator(".processing-tool-option:visible")).toHaveCount(analysisTools.length);
  for (const tool of analysisTools) {
    const label = shared[tool.label];
    expect(label).toBeTruthy();
    await box.getByRole("button", { name: label, exact: true }).click();
    await expect(box.locator(".processing-description")).toHaveText(
      shared[tool.description],
    );
    await box.locator(".processing-help summary").click();
    await expect(box.locator(".processing-help")).toContainText(
      shared[tool.help],
    );
    await noChineseUi(box);
    await box.locator(".processing-help summary").click();
  }
  await box.getByRole("button", { name: "Buffer", exact: true }).click();
  await box.getByLabel("Buffer distance (metres)").fill("-1");
  await expect(box.locator(".processing-notice")).toHaveText(
    shared["距离或容差须大于 0 且不超过 100000 米。"],
  );
  await switchLocale(page, "zh-CN");
  await expect(box.getByLabel("缓冲距离（米）")).toHaveValue("-1");
  await expect(box.locator(".processing-notice")).toHaveText(
    "距离或容差须大于 0 且不超过 100000 米。",
  );
  await switchLocale(page, "en");
  await noChineseUi(box);
  await expect(box.getByLabel("Buffer distance (metres)")).toHaveValue("-1");
  await expect(page.locator(".layer-text strong")).toHaveAttribute(
    "title",
    "zones.geojson",
  );
});

test("topology and summary reports switch existing issue labels, ordinals and generated status", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  const box = page.locator(".processing-toolbox");
  await box
    .getByRole("button", { name: "Quality and statistics", exact: true })
    .click();
  await box
    .getByRole("button", { name: "Topology check", exact: true })
    .click();
  await box.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(box.locator(".processing-report:not(.processing-explanation)")).toContainText(
    "Overlapping polygons",
  );
  await expect(box.locator(".processing-report:not(.processing-explanation)")).toContainText("Feature 1");
  await noChineseUi(box);
  await switchLocale(page, "zh-CN");
  await expect(box.locator(".processing-report:not(.processing-explanation)")).toContainText("面重叠");
  await expect(box.locator(".processing-report:not(.processing-explanation)")).toContainText("第 1 个");
  await switchLocale(page, "en");
  await box.getByRole("button", { name: "Layer summary", exact: true }).click();
  await box.getByRole("button", { name: "Run analysis", exact: true }).click();
  await expect(box.locator(".processing-report:not(.processing-explanation)")).toContainText("Fields (1)");
  await noChineseUi(box);
});

test("MCP catalogue and retained About update failures use the selected language", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await page.evaluate((tools) => {
    window.__ZG_TEST__.mcpTools = tools.map((tool) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: {},
    }));
  }, analysisTools);
  await page.getByRole("button", { name: /Tool details/ }).click();
  for (const summary of await page.locator(".mcp-tool-item summary").all())
    await summary.click();
  await expect(page.locator(".mcp-tool-item")).toHaveCount(analysisTools.length);
  await noChineseUi(page.locator(".mcp-panel"));
  await switchLocale(page, "zh-CN");
  await expect(page.locator(".mcp-tool-item[open]")).toHaveCount(analysisTools.length);
  await switchLocale(page, "en");
  await expect(page.locator(".mcp-tool-item[open]")).toHaveCount(analysisTools.length);
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page.evaluate(() => {
    window.__ZG_TEST__.updateResult = {
      currentVersion: "0.4.0",
      status: "available",
      latestVersion: "0.4.1",
    };
    window.__ZG_TEST__.downloadError = "fixture failure";
  });
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Download update", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Download or verification failed",
  );
  await noChineseUi(page.locator(".settings-about"));
  await switchLocale(page, "zh-CN");
  await expect(page.getByRole("alert")).toContainText("下载或校验失败");
  await switchLocale(page, "en");
  await expect(page.getByRole("alert")).toContainText(
    "Download or verification failed",
  );
});

test("layer actions and all export formats include English labels and validations", async ({
  page,
}) => {
  await start(page);
  await page.locator(".layer-text").click({ button: "right" });
  await noChineseUi(page.locator(".context-menu"));
  await page.keyboard.press("Escape");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^File$/ })
    .click();
  await page.getByRole("button", { name: "Export as", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const format of ["geojson", "shp", "wkt", "xy", "postgis"]) {
    await dialog.getByLabel("Output format").selectOption(format);
    if (format === "shp")
      await dialog
        .getByText("Shapefile format limits", { exact: true })
        .click();
    await noChineseUi(dialog);
  }
  await dialog.getByLabel("Output format").selectOption("geojson");
  await dialog.getByLabel(/File ?name/i).fill("");
  await expect(dialog.getByRole("alert")).toHaveText("Enter a file name.");
  await switchLocale(page, "zh-CN");
  await expect(dialog.getByRole("alert")).toHaveText("请填写文件名。");
  await switchLocale(page, "en");
  await noChineseUi(dialog);
});

test("both database managers and connection dialogs have English text and accessibility labels", async ({
  page,
}) => {
  await start(page);
  for (const engine of ["MySQL", "PostGIS"]) {
    await page
      .locator(".app-header summary")
      .filter({ hasText: /^Data$/ })
      .click();
    await page
      .getByRole("button", { name: `${engine} data source`, exact: true })
      .click();
    const manager = page.locator(".pg-manager:visible");
    await noChineseUi(manager);
    await page
      .getByRole("button", { name: "Add data source", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await noChineseUi(dialog);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await manager
      .getByRole("button", { name: /(?:Back|Return) to map/, exact: true })
      .click();
  }
});
