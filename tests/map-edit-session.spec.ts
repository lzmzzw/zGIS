import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function open(page: Page) {
  await page.goto("/");
  await page.locator("input[type=file]").setInputFiles({
    name: "session.geojson",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [116, 40],
              [117, 40],
              [117, 41],
              [116, 41],
              [116, 40],
            ],
          ],
        },
        properties: { name: "original" },
      }),
    ),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page
    .locator(".attribute-panel")
    .getByRole("button", { name: "展开属性表", exact: true })
    .click();
}

test("coordinates replace scale/footer and hand pans without selecting features", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("footer, .ol-scale-line")).toHaveCount(0);
  await expect(page.getByLabel("经纬度坐标")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新增点", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "缩放至图层", exact: true }).click();
  await page.waitForTimeout(300);
  const box = (await page.getByLabel("地理数据地图").boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.getByRole("button", { name: "手形", exact: true }).click();
  await page.mouse.click(x, y);
  await page.mouse.dblclick(x, y);
  await expect(page.locator("tbody tr.selected")).toHaveCount(0);
  await page.mouse.move(x, y);
  const before = await page.getByLabel("经纬度坐标").innerText();
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.mouse.move(x, y);
  await expect(page.getByLabel("经纬度坐标")).not.toHaveText(before);
  await expect(page.locator("tbody tr.selected")).toHaveCount(0);
  await page.getByRole("button", { name: "缩放至图层", exact: true }).click();
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.waitForTimeout(300);
  await page.mouse.click(x, y);
  await expect(page.locator("tbody tr.selected")).toHaveCount(1);
});

test("save exits a fresh session; cancellation and failure preserve edits", async ({
  page,
}) => {
  await installDesktopMock(page);
  await open(page);
  await page.locator("tbody tr").click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const save = page.getByRole("button", {
    name: "退出编辑",
    exact: true,
  });
  await expect(save).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "新增点", exact: true }),
  ).toBeVisible();
  await page.locator('td[data-field="name"]').dblclick();
  await page.getByLabel("属性 name", { exact: true }).fill("changed");
  await page.keyboard.press("Enter");
  await expect(save).toBeEnabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(save).toBeEnabled();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("退出编辑");
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = true;
  });
  await page.getByRole("button", {name:"保存并退出",exact:true}).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await page.evaluate(() => {
    window.__ZG_TEST__.saveCancelled = false;
    window.__ZG_TEST__.saveError = "test save failed";
  });
  await page.getByRole("button", {name:"保存并退出",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("test save failed");
  await expect(save).toBeEnabled();
  await page.evaluate(() => {
    window.__ZG_TEST__.saveError = "";
  });
  await page.getByRole("button", {name:"保存并退出",exact:true}).click();
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新增点", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "撤销", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".document-state")).toHaveText("源文件已保存");
  await expect(page.locator("tbody tr")).toContainText("changed");
  await page.locator('td[data-field="name"]').dblclick();
  await expect(page.getByLabel("属性 name", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
});

test("exit without edits does not save; cancelled exit retains changes and discard restores baseline", async ({ page }) => {
  await installDesktopMock(page);
  await open(page);
  const toolbar = page.getByRole("toolbar", { name: "地图工具", exact: true });
  await toolbar.getByRole("button", { name: "编辑", exact: true }).click();
  await toolbar.getByRole("button", { name: "退出编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__ZG_TEST__.calls.filter(call => call.command === "save_file").length)).toBe(0);
  await toolbar.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "保存编辑", exact: true })).toHaveCount(1);
  await expect(toolbar.getByRole("button", { name: "保存并退出编辑", exact: true })).toHaveCount(0);
  await expect(toolbar).toHaveText("");
  await expect(toolbar.getByRole("button", { name: "编辑顶点", exact: true }).locator("svg")).toHaveClass(/lucide-spline/);
  await page.locator("tbody tr").click();
  await page.locator('td[data-field="name"]').dblclick();
  await page.getByLabel("属性 name", { exact: true }).fill("discard me");
  await page.keyboard.press("Enter");
  await toolbar.getByRole("button", { name: "退出编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "退出编辑", exact: true });
  await page.screenshot({ path: "output/edit-toolbar-adjustment/unsaved-exit.png" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("tbody tr")).toContainText("discard me");
  await toolbar.getByRole("button", { name: "退出编辑", exact: true }).click();
  await dialog.getByRole("button", { name: "不保存退出", exact: true }).click();
  await expect(toolbar.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toContainText("original");
  await expect.poll(async () => {
    const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot);
    if (!raw) return false;
    const snapshot = JSON.parse(raw);
    return !snapshot.session && snapshot.layers[0].features[0].properties.name === "original";
  }).toBe(true);
});

test("discard after saving restores the latest saved values and fields", async ({ page }) => {
  await installDesktopMock(page);
  await open(page);
  const toolbar = page.getByRole("toolbar", { name: "地图工具", exact: true });
  await toolbar.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator("tbody tr").click();
  const changeName = async (name: string) => {
    await page.locator('td[data-field="name"]').dblclick();
    await page.getByLabel("属性 name", { exact: true }).fill(name);
    await page.keyboard.press("Enter");
  };
  await changeName("saved value");
  await toolbar.getByRole("button", { name: "保存编辑", exact: true }).click();
  await expect(page.locator(".document-state")).toHaveText("源文件已保存");
  await toolbar.getByRole("button", { name: "退出编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "编辑", exact: true }).click();
  await changeName("unsaved value");
  await page.locator(".attribute-panel thead th").filter({has: page.locator('summary:text-is("name")')}).click({ button: "right" });
  await page.getByRole("menuitem", { name: "添加字段", exact: true }).click();
  await page.getByLabel("新字段名", { exact: true }).fill("discard_field");
  await page.getByRole("dialog").getByRole("button", { name: "添加字段", exact: true }).click();
  await expect(page.locator(".attribute-panel thead summary").filter({hasText: /^discard_field$/})).toBeVisible();
  await toolbar.getByRole("button", { name: "退出编辑", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "不保存退出", exact: true }).click();
  await expect(page.locator("tbody tr")).toContainText("saved value");
  await expect(page.locator(".attribute-panel thead summary").filter({hasText: /^discard_field$/})).toHaveCount(0);
  await expect(page.locator(".document-state")).toHaveText("源文件已保存");
});
