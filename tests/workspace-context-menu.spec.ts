import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

declare global {
  interface Window {
    __CONTEXT_CLIPBOARD__: string[];
    __CONTEXT_CLIPBOARD_FAIL__: boolean;
  }
}

const snapshot = JSON.stringify([
  {
    name: "context.geojson",
    sourceKind: "geojson",
    visible: true,
    features: [
      {
        id: "first",
        geometry: { type: "Point", coordinates: [116, 40] },
        properties: { name: "第一条", count: 1, empty: null },
      },
      {
        id: "second",
        geometry: { type: "Point", coordinates: [117, 40] },
        properties: { name: "第二条", count: 2, empty: null },
      },
    ],
  },
]);

const rows = (page: Page) => page.locator(".attribute-panel tbody tr");
const cell = (page: Page, index: number, field = "name") =>
  rows(page).nth(index).locator(`td[data-field="${field}"]`);
const item = (page: Page, name: string) =>
  page.getByRole("menuitem", { name, exact: true });
const map = (page: Page) => page.getByLabel("地理数据地图", { exact: true });

async function clipboard(page: Page) {
  await page.addInitScript(() => {
    window.__CONTEXT_CLIPBOARD__ = [];
    window.__CONTEXT_CLIPBOARD_FAIL__ = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (window.__CONTEXT_CLIPBOARD_FAIL__)
            throw Error("clipboard denied");
          window.__CONTEXT_CLIPBOARD__.push(value);
        },
      },
    });
  });
}

async function setup(page: Page, recovery = snapshot) {
  await installDesktopMock(page, recovery);
  await clipboard(page);
  await page.goto("/");
  await expect(page.locator(".tree-row")).toContainText("context.geojson");
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
}

async function expectClipboard(page: Page, value: string) {
  await expect
    .poll(() => page.evaluate(() => window.__CONTEXT_CLIPBOARD__.at(-1)))
    .toBe(value);
}

test("chrome suppresses native menus while editable inputs retain them", async ({
  page,
}) => {
  await setup(page);
  const prevented = await page.locator(".app-header").evaluate((element) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.getByRole("menu")).toHaveCount(0);
  const search = page.getByLabel("搜索属性", { exact: true });
  const inputPrevented = await search.evaluate((element) => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(inputPrevented).toBe(false);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("record actions select and copy the clicked record, including NULL and WKT", async ({
  page,
}) => {
  await setup(page);
  await rows(page).first().click();
  await cell(page, 1).click({ button: "right" });
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await item(page, "复制单元格值").click();
  await expectClipboard(page, "第二条");
  await cell(page, 1).click({ button: "right" });
  await item(page, "复制属性 JSON").click();
  await expectClipboard(
    page,
    JSON.stringify({ name: "第二条", count: 2, empty: null }, null, 2),
  );
  await cell(page, 1).click({ button: "right" });
  await item(page, "复制 WKT").click();
  await expectClipboard(page, "POINT(117 40)");
  await cell(page, 0, "empty").click({ button: "right" });
  await item(page, "复制单元格值").click();
  await expectClipboard(page, "NULL");
});

test("direct cell editing preserves the active draft when another record is right-clicked", async ({
  page,
}) => {
  await setup(page);
  await cell(page, 1).click({ button: "right" });
  await item(page, "编辑单元格").click();
  const draft = page.getByRole("textbox", { name: "属性 name", exact: true });
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("第二条");
  await draft.fill("修改第二条");
  await cell(page, 0).click({ button: "right" });
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(draft).toHaveValue("修改第二条");
  for (const name of [
    "编辑单元格",
    "定位到要素",
    "JSON 属性…",
    "WKT 几何…",
    "编辑顶点",
    "删除要素…",
  ])
    await expect(item(page, name)).toBeDisabled();
  await item(page, "复制单元格值").click();
  await expectClipboard(page, "第一条");
  await draft.press("Enter");
  await expect(cell(page, 0)).toHaveText("第一条");
  await expect(cell(page, 1)).toHaveText("修改第二条");
});

test("field menus support keyboard access, restore focus and open an editable field dialog", async ({
  page,
}) => {
  await setup(page);
  const summary = page
    .locator(".attribute-panel thead summary")
    .filter({ hasText: /^name$/ });
  await summary.focus();
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menu", { name: "字段操作", exact: true }),
  ).toBeVisible();
  await expect(item(page, "复制字段名")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "复制字段摘要")).toBeFocused();
  await page.keyboard.press("Enter");
  await expectClipboard(page, "name：文本 · 2 条 · 0 空值");
  await expect(summary).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("End");
  await expect(item(page, "添加字段…")).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("dialog", { name: "添加字段", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog").locator(":focus")).toHaveCount(1);
});

test("menu geometry stays within the viewport and outside clicks, resize and replacement dismiss it", async ({
  page,
}) => {
  await setup(page);
  await cell(page, 1).evaluate((element) =>
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 1438,
        clientY: 898,
      }),
    ),
  );
  await expect(page.getByRole("menu")).toBeVisible();
  const bounds = (await page.getByRole("menu").boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8);
  expect(bounds.y).toBeGreaterThanOrEqual(8);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1432);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(892);
  await page.locator(".tree-row").click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(
    page.getByRole("menu", { name: "要素操作", exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".app-header")
    .click({ button: "right", position: { x: 10, y: 10 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await cell(page, 1).click({ button: "right" });
  await page.getByLabel("搜索属性", { exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await cell(page, 1).click({ button: "right" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("map coordinates copy accurately and a hit targets the visible feature", async ({
  page,
}) => {
  await setup(page);
  const box = (await map(page).boundingBox())!;
  const x = Math.round(box.x + box.width * 0.7),
    y = Math.round(box.y + box.height * 0.3);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: "right" });
  await expect(
    page.getByRole("menu", { name: "地图操作", exact: true }),
  ).toBeVisible();
  await expect(item(page, "复制属性 JSON")).toHaveCount(0);
  const displayed = await page
    .getByLabel("经纬度坐标", { exact: true })
    .innerText();
  await item(page, "复制经纬度").click();
  const copied = await page.evaluate(() =>
    window.__CONTEXT_CLIPBOARD__.at(-1)!,
  );
  const expected = displayed.split(",").map(Number);
  copied
    .split(",")
    .map(Number)
    .forEach((value, index) =>
      expect(Math.abs(value - expected[index])).toBeLessThan(0.00002),
    );
  await cell(page, 1).click({ button: "right" });
  await item(page, "定位到要素").click();
  await page.waitForTimeout(350);
  await map(page).click({
    button: "right",
    position: { x: box.width / 2, y: box.height / 2 },
  });
  await expect(item(page, "复制属性 JSON")).toBeVisible();
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await item(page, "复制 WKT").click();
  await expectClipboard(page, "POINT(117 40)");
});

test("drawing menu disables incomplete geometry and completes only after enough vertices", async ({
  page,
}) => {
  await setup(page);
  await rows(page).first().click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "新增线", exact: true }).click();
  await cell(page, 1).click({ button: "right" });
  await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(item(page, "编辑单元格")).toBeDisabled();
  await expect(item(page, "删除要素…")).toBeDisabled();
  await page.keyboard.press("Escape");
  const box = (await map(page).boundingBox())!;
  await map(page).click({
    button: "right",
    position: { x: box.width * 0.5, y: box.height * 0.5 },
  });
  await expect(item(page, "完成绘制")).toBeDisabled();
  await expect(item(page, "取消绘制")).toBeEnabled();
  await expect(item(page, "编辑顶点")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await map(page).click({
    position: { x: box.width * 0.3, y: box.height * 0.3 },
  });
  await map(page).click({
    position: { x: box.width * 0.5, y: box.height * 0.5 },
  });
  await map(page).click({
    button: "right",
    position: { x: box.width * 0.7, y: box.height * 0.6 },
  });
  await expect(item(page, "完成绘制")).toBeEnabled();
  await item(page, "完成绘制").click();
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).last()).toContainText("LineString");
  await page.getByRole("button", { name: "新增线", exact: true }).click();
  await map(page).click({
    button: "right",
    position: { x: box.width * 0.7, y: box.height * 0.6 },
  });
  await item(page, "取消绘制").click();
  await expect(
    page.getByRole("button", { name: "选择", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("an empty map skips disabled actions for keyboard navigation and closes on Tab", async ({
  page,
}) => {
  await installDesktopMock(page);
  await clipboard(page);
  await page.goto("/");
  await map(page).focus();
  await page.keyboard.press("Shift+F10");
  await expect(item(page, "复制经纬度")).toBeFocused();
  for (const name of ["缩放至图层", "打开属性表", "选择要素", "清除选择"])
    await expect(item(page, name)).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "手形平移")).toBeFocused();
  await page.keyboard.press("End");
  await expect(item(page, "手形平移")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(item(page, "复制经纬度")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await map(page).focus();
  await page.keyboard.press("Shift+F10");
  await page.keyboard.press("Escape");
  await expect(map(page)).toBeFocused();
});

test("read-only database records expose copying while edits and schema changes remain disabled", async ({
  page,
}) => {
  await installDesktopMock(page);
  await clipboard(page);
  await page.goto("/");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^数据$/ })
    .click();
  await page
    .getByRole("button", { name: "PostGIS 数据源…", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByLabel("数据库", { exact: true }).fill("test");
  await page.getByLabel("用户", { exact: true }).fill("tester");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page
    .locator(".source-table")
    .filter({ hasText: "public.readonly" })
    .dblclick();
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await cell(page, 0).click({ button: "right" });
  for (const name of ["编辑单元格", "编辑顶点", "删除要素…"])
    await expect(item(page, name)).toBeDisabled();
  await item(page, "复制单元格值").click();
  await expectClipboard(page, "道路");
  await page
    .locator(".attribute-panel thead summary")
    .filter({ hasText: /^name$/ })
    .focus();
  await page.keyboard.press("Shift+F10");
  await expect(item(page, "添加字段…")).toBeDisabled();
  await page.keyboard.press("End");
  await expect(item(page, "复制字段摘要")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(item(page, "复制字段名")).toBeFocused();
});

test("clipboard rejection surfaces an error without losing the selected record", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__CONTEXT_CLIPBOARD_FAIL__ = true;
  });
  await cell(page, 1).click({ button: "right" });
  await item(page, "复制单元格值").click();
  await expect(page.getByRole("alert")).toContainText("无法访问剪贴板");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => window.__CONTEXT_CLIPBOARD__)).toEqual([]);
});

test("empty field names retain their value and field-copy actions", async ({
  page,
}) => {
  const recovery = JSON.parse(snapshot);
  recovery[0].features[0].properties[""] = "空字段第一条";
  recovery[0].features[1].properties[""] = "空字段第二条";
  await setup(page, JSON.stringify(recovery));
  await cell(page, 1, "").click({ button: "right" });
  await item(page, "复制单元格值").click();
  await expectClipboard(page, "空字段第二条");
  await page
    .locator('.attribute-panel th[title=""]')
    .click({ button: "right" });
  await item(page, "复制字段名").click();
  await expectClipboard(page, "");
});

for (const theme of ["dark", "light"]) {
  test(`context menus share the existing typography and density (${theme})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.getByRole("button", { name: "返回地图", exact: true }).click();
    await cell(page, 1).click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCSS("width", "192px");
    await expect(page.getByRole("menu")).toHaveCSS("font-size", "13px");
    await expect(item(page, "复制单元格值")).toHaveCSS("height", "30px");
    await expect(item(page, "复制单元格值")).toBeFocused();
    await page.screenshot({
      path: `output/playwright/workspace-context-menu-${theme}.png`,
    });
    expect(errors).toEqual([]);
  });
}
