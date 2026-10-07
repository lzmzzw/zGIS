import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const categories = ["外观", "地图", "空间分析 MCP", "关于"];
const longName = "测绘项目用于跨区连续显示的自定义地图服务名称".repeat(4);
const settings = (page: Page) =>
  page.getByRole("main", { name: "后台设置", exact: true });
const category = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name, exact: true });
const opener = (page: Page) =>
  page.getByRole("button", { name: "添加底图", exact: true });
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "添加底图", exact: true });

async function setup(page: Page) {
  await installDesktopMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

async function addService(page: Page, name: string, host: string) {
  await opener(page).click();
  await page.getByLabel("新底图名称", { exact: true }).fill(name);
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill(`https://${host}/{z}/{x}/{y}.png`);
  await page.getByLabel("底图来源说明", { exact: true }).fill("测试地图服务");
  await dialog(page).getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator(".basemap-service-list li").last()).toContainText(
    name,
  );
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".settings-page-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const bounds = (await settings(page).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
}

test("add-service controls appear on demand and cancel or Escape returns focus before leaving settings", async ({
  page,
}) => {
  await setup(page);
  await category(page, "地图").click();
  await expect(page.getByLabel("新底图名称", { exact: true })).toHaveCount(0);
  await opener(page).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveCSS("width", "460px");
  await expect(dialog(page).getByRole("heading")).toHaveCSS("font-size", "15px");
  await page.screenshot({ path: "output/smoke/settings-add-basemap.png" });
  await expect(page.getByLabel("新底图名称", { exact: true })).toBeFocused();
  await page.getByLabel("新底图名称", { exact: true }).fill("取消添加");
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(settings(page)).toBeVisible();
  await expect(category(page, "地图")).toHaveAttribute("aria-current", "page");
  await expect(opener(page)).toBeFocused();
  await expect(page.locator(".basemap-service-list li")).toHaveCount(3);
  await opener(page).click();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(settings(page)).toBeVisible();
  await expect(opener(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "设置", exact: true }),
  ).toBeFocused();
});

test("invalid service URLs preserve the form and sequential additions remain independent", async ({
  page,
}) => {
  await setup(page);
  await category(page, "地图").click();
  await opener(page).click();
  await page.getByLabel("新底图名称", { exact: true }).fill("保留输入的底图");
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill("ftp://invalid.example/{z}/{x}/{y}.png");
  await page.getByLabel("底图来源说明", { exact: true }).fill("保留来源");
  await dialog(page).getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("HTTP(S)");
  await expect(page.getByLabel("新底图名称", { exact: true })).toHaveValue(
    "保留输入的底图",
  );
  await expect(page.getByLabel("XYZ 瓦片地址", { exact: true })).toHaveValue(
    "ftp://invalid.example/{z}/{x}/{y}.png",
  );
  await expect(page.getByLabel("底图来源说明", { exact: true })).toHaveValue(
    "保留来源",
  );
  await expect(page.locator(".basemap-service-list li")).toHaveCount(3);
  await page
    .getByLabel("XYZ 瓦片地址", { exact: true })
    .fill("https://first.example/{z}/{x}/{y}.png");
  await dialog(page).getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await addService(page, "第二个底图", "second.example");
  await expect(page.locator(".basemap-service-list li")).toHaveCount(5);
  await expect(page.getByLabel("底图类型", { exact: true })).toContainText(
    "保留输入的底图",
  );
  await expect(page.getByLabel("底图类型", { exact: true })).toContainText(
    "第二个底图",
  );
});

test("four settings categories retain concise labels and an accessible icon back button", async ({
  page,
}) => {
  await setup(page);
  await expect(
    page.getByRole("navigation", { name: "设置分类" }).getByRole("button"),
  ).toHaveText(categories);
  const back = page.getByRole("button", { name: "返回地图", exact: true });
  await expect(back).toHaveAttribute("title", "返回地图");
  await expect(back).toHaveText("");
  for (const name of categories) {
    await category(page, name).click();
    await expect(
      settings(page).getByRole("heading", { name, exact: true }),
    ).toBeVisible();
    await expect(
      settings(page).locator(
        ".settings-page-heading p, .settings-page-content > header p",
      ),
    ).toHaveCount(0);
    for (const text of [
      "外观、地图与本机服务",
      "界面主题",
      "底图、注记与服务配置",
      "本机服务与外部文件访问",
      "版本与数据处理",
      "即时生效，自动保存。",
      "当前地图背景",
      "地名与道路标注",
      "按此顺序显示底图选项。",
    ])
      await expect(settings(page).getByText(text, { exact: true })).toHaveCount(
        0,
      );
  }
});

for (const theme of ["dark", "light"]) {
  test(`settings retain their layout with long service names at desktop widths (${theme})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await setup(page);
    await page.evaluate(() => {
      window.__ZG_TEST__.mcpEnabled = true;
    });
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await category(page, "地图").click();
    await addService(page, longName, "long-name.example");
    for (const width of [1440, 960]) {
      await page.setViewportSize({ width, height: width === 960 ? 640 : 900 });
      for (const name of categories) {
        await category(page, name).click();
        await expectNoOverflow(page);
        await expect(
          page.getByRole("button", { name: "返回地图", exact: true }),
        ).toBeVisible();
        if (name === "地图") {
          await expect(opener(page)).toBeVisible();
          const remove = page.getByRole("button", {
            name: `删除 ${longName}`,
            exact: true,
          });
          await remove.scrollIntoViewIfNeeded();
          await expect(remove).toBeInViewport();
          const actions = (await remove.boundingBox())!;
          expect(actions.x + actions.width).toBeLessThanOrEqual(width);
          await expect(
            page.getByLabel("新底图名称", { exact: true }),
          ).toHaveCount(0);
        }
        await page.mouse.move(width - 150, 50);
        await page.screenshot({
          path: `output/playwright/settings-design-${theme}-${width}-${name}.png`,
        });
      }
    }
    expect(errors).toEqual([]);
  });
}
