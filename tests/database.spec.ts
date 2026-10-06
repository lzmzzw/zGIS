import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
test("PostGIS text WKT defaults to 4326 and passes all three source SRIDs", async ({ page }) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page.locator(".app-header summary").filter({hasText: /^数据$/}).click();
  await page.getByRole("button", { name: "PostGIS 数据源…", exact: true }).filter({ visible: true }).click();
  await page.getByLabel("数据库", { exact: true }).fill("test");
  await page.getByLabel("用户", { exact: true }).fill("tester");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  for (const srid of [4326, 4490, 3857]) {
    if (srid !== 4326) { await page.locator(".app-header summary").filter({hasText: /^数据$/}).click(); await page.getByRole("button", { name: "PostGIS 数据源…", exact: true }).click(); }
    await page.locator(".source-table").filter({ hasText: "public.wkt_points" }).dblclick();
    await expect(page.getByLabel("来源 SRID")).toHaveValue("4326");
    await page.getByLabel("WKT 文本列").selectOption("location");
    await page.getByLabel("来源 SRID").selectOption(String(srid));
    await page.getByRole("button", { name: "载入", exact: true }).click();
    const query = await page.evaluate(() => window.__ZG_TEST__.calls.filter(call => call.command === "query_layer").at(-1)?.args);
    expect(query?.srid).toBe(srid);
    expect(query?.geometryKind).toBe("wkt");
    expect(query?.geometryColumn).toBe("location");
  }
});
async function loadSource(page: Page, table = "roads") {
  await installDesktopMock(page);
  await page.goto("/");
  await page.locator(".app-header summary").filter({hasText: /^数据$/}).click();
  await page
    .getByRole("button", { name: "PostGIS 数据源…", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByLabel("数据库", { exact: true }).fill("test");
  await page.getByLabel("用户", { exact: true }).fill("tester");
  await expect(page.locator(".connection-advanced summary")).toContainText(
    "TLS · 校验证书",
  );
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page
    .locator(".source-table")
    .filter({ hasText: `public.${table}` })
    .dblclick();
  await expect(page.getByRole("dialog")).toContainText("加载摘要");
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await page
    .locator(".header-actions")
    .getByRole("button", { name: "属性表", exact: true })
    .click();
  await page.locator(".attribute-panel tbody tr").first().click();
}
test("PostGIS geometry with no SRID defaults to 4326", async ({ page }) => {
  await loadSource(page, "unassigned");
  const query = await page.evaluate(() => window.__ZG_TEST__.calls.find(call => call.command === "query_layer")?.args);
  expect(query?.srid).toBe(4326);
  expect(query?.geometryKind).toBe("geometry");
});
test("source loading, explicit submit counts and conflict details retain edits", async ({
  page,
}) => {
  await loadSource(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("属性 name", { exact: true }).fill("更新道路");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "提交修改", exact: true }).click();
  await expect(page.locator(".submit-counts")).toContainText("修改1");
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "commit_changes",
        ).length,
    ),
  ).toBe(0);
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "并发冲突：原记录已变化";
  });
  await page.getByRole("button", { name: "提交到数据库", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "本地修改已保留",
  );
  await page.getByText("错误详情", { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("并发冲突");
  await page.screenshot({ path: "output/smoke/submit-conflict.png" });
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "";
  });
  await page.getByRole("button", { name: "提交到数据库", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".attribute-panel tbody tr")).toContainText(
    "更新道路",
  );
});
test("no primary key remains selectable and read only", async ({ page }) => {
  await loadSource(page, "readonly");
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "新增面", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toBeEnabled();
});
test("uncertain commit disables repeat submission", async ({ page }) => {
  await loadSource(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("属性 name", { exact: true }).fill("待核对");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^文件$/ })
    .click();
  await page.getByRole("button", { name: "提交修改", exact: true }).click();
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "提交结果待核对";
  });
  await page.getByRole("button", { name: "提交到数据库", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "提交到数据库", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "commit_changes",
        ).length,
    ),
  ).toBe(1);
});
for (const viewer of ["JSON 属性", "WKT 几何"]) {
  test(`read-only ${viewer} viewer exits without an editing confirmation`, async ({ page }) => {
    await loadSource(page, "readonly");
    await page.getByRole("button", { name: `${viewer}…`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: viewer, exact: true })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: viewer, exact: true })).toHaveAttribute("readonly", "");
    await page.evaluate(() => window.__ZG_TEST__.requestClose());
    await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(true);
    await expect(page.getByRole("heading", { name: "退出 zGIS", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__ZG_TEST__.calls.some(call => call.command === "commit_changes"))).toBe(false);
  });
}
