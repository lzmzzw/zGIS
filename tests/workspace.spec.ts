import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const snapshot = JSON.stringify(
  ["first", "second"].map((name) => ({
    id: name,
    name,
    visible: true,
    color: "#5479b6",
    sourceKind: "postgis",
    dirty: true,
    db: { connectionId: "old" },
    sourceId: "old-source",
    features: [
      {
        id: name,
        geometry: { type: "Point", coordinates: [116, 40] },
        properties: { value: 1 },
        baseline: "old",
        dbKey: [1],
      },
    ],
  })),
);
async function exit(page: Page) {
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "退出", exact: true }).click();
}

test("native open continues into worker import after dialog busy state", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page
    .locator(".app-header")
    .getByRole("button", { name: "打开文件…", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.locator(".layer-row")).toContainText("native.geojson");
});

test("restored CSV saves as GeoJSON with matching filename", async ({
  page,
}) => {
  const layers = JSON.parse(snapshot);
  layers[0].name = "points.csv";
  layers[0].sourceKind = "csv";
  await installDesktopMock(page, JSON.stringify([layers[0]]));
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("已恢复");
  await exit(page);
  await page.getByLabel("退出处理 points.csv").selectOption("save");
  await page.getByRole("button", { name: "处理并退出" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  const save = await page.evaluate(() =>
    window.__ZG_TEST__.calls.find((call) => call.command === "save_file")!,
  );
  expect(save.args.suggestedName).toBe("points.geojson");
  expect(JSON.parse(String(save.args.content)).type).toBe("FeatureCollection");
});

test("auto recovery detaches database state and exit keeps only chosen layers", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("已恢复 2");
  await expect(page.locator(".layer-list .layer-row")).toHaveCount(2);
  await exit(page);
  await expect(page.getByLabel("退出处理 first")).toHaveValue("keep");
  await expect(
    page.getByLabel("退出处理 first").locator("option[value=submit]"),
  ).toHaveCount(0);
  await page.getByLabel("退出处理 second").selectOption("discard");
  await page.getByRole("button", { name: "处理并退出" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot!);
  const saved = JSON.parse(raw);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ name: "first", sourceKind: "geojson" });
  expect(raw).not.toMatch(/baseline|dbKey|sourceId|connectionId/);
});

test("cancelled save preserves workspace; earlier successful saves remain clean after later failure", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("已恢复");
  await exit(page);
  await page.getByLabel("退出处理 first").selectOption("save");
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = true;
  });
  await page.getByRole("button", { name: "处理并退出" }).click();
  await expect(page.getByRole("alert")).toContainText("已取消保存");
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = false;
    window.__ZG_TEST__.backupError = "snapshot failed";
  });
  await page.getByRole("button", { name: "处理并退出" }).click();
  await expect(page.getByRole("alert")).toContainText("snapshot failed");
  await expect(page.getByLabel("退出处理 first")).toHaveCount(0);
  await expect(page.getByLabel("退出处理 second")).toHaveCount(1);
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("invalid recovery stays intact and discard is not overwritten by pending autosnapshot", async ({
  page,
}) => {
  await installDesktopMock(page, "invalid snapshot");
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("恢复副本加载失败");
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => window.__ZG_TEST__.snapshot)).toBe(
    "invalid snapshot",
  );
});

test("discard exit flushes the snapshot queue without stale copies", async ({
  page,
}) => {
  await installDesktopMock(page, snapshot);
  await page.goto("/");
  await expect(page.locator(".statusbar")).toContainText("已恢复");
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("退出处理 first").selectOption("discard");
  await page.getByLabel("退出处理 second").selectOption("discard");
  await page.getByRole("button", { name: "处理并退出" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
    .toBe(true);
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => window.__ZG_TEST__.snapshot)).toBe("[]");
});
