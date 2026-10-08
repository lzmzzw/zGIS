import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock, openDatabaseManager, loadDatabaseTestLayer } from "./desktop.mock";
test("PostGIS text WKT defaults to 4326 and passes all three source SRIDs", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  for (const srid of [4326, 4490, 3857]) {
    if (srid === 4326) await loadDatabaseTestLayer(page, "wkt_points");
    else {
      await openDatabaseManager(page);
      const manager = page.getByRole("region", {name:"PostGIS 数据源管理",exact:true});
      await manager.locator(".pg-table").filter({hasText:"wkt_points"}).click();
      await manager.getByRole("button",{name:"从 WKT 列加载",exact:true}).click();
    }
    await expect(page.getByLabel("来源 SRID")).toHaveValue("4326");
    await page.getByLabel("WKT 文本列").selectOption("location");
    await page.getByLabel("来源 SRID").selectOption(String(srid));
    await page.getByRole("button", { name: "载入", exact: true }).click();
    const query = await page.evaluate(
      () =>
        window.__ZG_TEST__.calls
          .filter((call) => call.command === "query_layer")
          .at(-1)?.args,
    );
    expect(query?.srid).toBe(srid);
    expect(query?.geometryKind).toBe("wkt");
    expect(query?.geometryColumn).toBe("location");
  }
});
async function loadSource(page: Page, table = "roads") {
  await installDesktopMock(page);
  await page.goto("/");
  await loadDatabaseTestLayer(page,table);
  await expect(page.getByRole("dialog")).toContainText("加载摘要");
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
  await page.locator(".attribute-panel tbody tr").first().click();
}

async function editName(page: Page) {
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await page
    .locator('.attribute-panel tbody tr.selected td[data-field="name"]')
    .dblclick();
}
test("PostGIS geometry with no SRID defaults to 4326", async ({ page }) => {
  await loadSource(page, "unassigned");
  const query = await page.evaluate(
    () =>
      window.__ZG_TEST__.calls.find((call) => call.command === "query_layer")
        ?.args,
  );
  expect(query?.srid).toBe(4326);
  expect(query?.geometryKind).toBe("geometry");
});
test("source loading and direct save conflicts retain edits without a submit dialog", async ({
  page,
}) => {
  await loadSource(page);
  await editName(page);
  await page.getByLabel("属性 name", { exact: true }).fill("更新道路");
  await page.getByRole("button", { name: "应用", exact: true }).click();
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
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("并发冲突");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", {name:"保存并退出编辑",exact:true})).toBeEnabled();
  await expect(page.locator(".attribute-panel tbody tr")).toContainText("更新道路");
  await page.screenshot({ path: "output/smoke/submit-conflict.png" });
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "";
  });
  await page.getByRole("button", { name: "保存并退出编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".attribute-panel tbody tr")).toContainText(
    "更新道路",
  );
});
test("no primary key remains selectable and read only", async ({ page }) => {
  await loadSource(page, "readonly");
  await expect(
    page.getByRole("button", { name: "编辑属性", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "新增面", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toBeEnabled();
});
test("uncertain commit disables repeat submission", async ({ page }) => {
  await loadSource(page);
  await editName(page);
  await page.getByLabel("属性 name", { exact: true }).fill("待核对");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "提交结果待核对";
  });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("提交结果待核对");
  await expect(
    page.getByRole("button", { name: "保存并退出编辑", exact: true }),
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
  test(`read-only ${viewer} viewer exits without an editing confirmation`, async ({
    page,
  }) => {
    await loadSource(page, "readonly");
    await page
      .locator(".attribute-panel summary")
      .filter({ hasText: /^更多$/ })
      .click();
    await page.getByRole("button", { name: `${viewer}…`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: viewer, exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: viewer, exact: true }),
    ).toHaveAttribute("readonly", "");
    await page.evaluate(() => window.__ZG_TEST__.requestClose());
    await expect
      .poll(() => page.evaluate(() => window.__ZG_TEST__.destroyed))
      .toBe(true);
    await expect(
      page.getByRole("heading", { name: "退出 zGIS", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        window.__ZG_TEST__.calls.some(
          (call) => call.command === "commit_changes",
        ),
      ),
    ).toBe(false);
  });
}
