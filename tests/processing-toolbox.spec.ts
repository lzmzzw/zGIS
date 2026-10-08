import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const polygon = (id: string, x: number) => ({
  id,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x, 40],
        [x + 0.01, 40],
        [x + 0.01, 40.01],
        [x, 40.01],
        [x, 40],
      ],
    ],
  },
  properties: { name: id, group: "甲" },
});
const fixture = () =>
  JSON.stringify({
    version: 3,
    layers: [
      {
        id: "zones-a",
        name: "区域甲.geojson",
        features: [polygon("a1", 116), polygon("a2", 116.02)],
      },
      {
        id: "zones-b",
        name: "区域乙.geojson",
        features: [polygon("b1", 116.005)],
      },
    ],
    tree: [
      { kind: "layer", id: "zones-a" },
      { kind: "layer", id: "zones-b" },
    ],
  });
const toolbox = (page: Page) => page.locator(".processing-toolbox");
const run = (page: Page) =>
  toolbox(page).getByRole("button", { name: "运行分析", exact: true });
async function start(page: Page) {
  await installDesktopMock(page, fixture());
  await page.goto("/");
  await expect(page.locator(".layer-text")).toHaveCount(2);
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await expect(toolbox(page)).toBeVisible();
}
async function tool(page: Page, label: string) {
  const option = toolbox(page)
    .locator(".processing-tool-option")
    .getByText(label, { exact: true });
  if (!(await option.isVisible())) {
    const group = option.locator(
      'xpath=ancestor::div[contains(@class,"processing-tool-group")]',
    );
    await group.locator(".processing-group-toggle").click();
  }
  if ((await option.locator("..").getAttribute("aria-pressed")) !== "true")
    await option.click();
}
const calls = (page: Page) =>
  page.evaluate(() =>
    window.__ZG_TEST__.calls.filter(
      (item) => item.command === "gis_run_analysis",
    ),
  );

test("fixed tree and subtle boundary remain stable while selection toggles configuration and help", async ({
  page,
}) => {
  await start(page);
  await expect(toolbox(page).locator(".processing-form")).toHaveCount(0);
  await expect(toolbox(page).locator(".processing-help")).toHaveCount(0);
  const tree = toolbox(page).locator(".processing-tool-list");
  expect((await tree.boundingBox())!.height).toBe(200);
  const border = await toolbox(page)
    .locator(".processing-browser")
    .evaluate((element) => getComputedStyle(element).borderTopWidth);
  expect(border).toBe("1px");
  await tool(page, "缓冲区");
  expect((await tree.boundingBox())!.height).toBe(200);
  await toolbox(page).getByLabel("缓冲距离（米）").fill("350");
  await toolbox(page).getByLabel("结果图层名称").fill("保留草稿");
  const selected = toolbox(page).getByRole("button", {
    name: "缓冲区",
    exact: true,
  });
  await selected.click();
  await expect(selected).toHaveAttribute("aria-pressed", "false");
  await expect(toolbox(page).locator(".processing-form")).toHaveCount(0);
  await expect(toolbox(page).locator(".processing-help")).toHaveCount(0);
  await expect(run(page)).toHaveCount(0);
  expect(await calls(page)).toHaveLength(0);
  await selected.focus();
  await page.keyboard.press("Enter");
  await expect(toolbox(page).getByLabel("缓冲距离（米）")).toHaveValue("350");
  await expect(toolbox(page).getByLabel("结果图层名称")).toHaveValue(
    "保留草稿",
  );
  await toolbox(page)
    .getByRole("button", { name: "叠加分析", exact: true })
    .click();
  expect((await tree.boundingBox())!.height).toBe(200);
  await expect(toolbox(page).locator(".processing-form")).toBeVisible();
  await page.screenshot({ path: "output/tools-fixed-tree.png" });
});

test("collapsed categories, search, keyboard and hiding preserve parameters without removed controls", async ({
  page,
}) => {
  await start(page);
  const categories = toolbox(page).locator(".processing-group-toggle");
  await expect(categories).toHaveCount(4);
  for (const category of await categories.all())
    await expect(category).toHaveAttribute("aria-expanded", "false");
  await expect(
    toolbox(page).locator(".processing-tool-option:visible"),
  ).toHaveCount(0);
  await expect(toolbox(page).getByLabel("搜索分析工具")).not.toHaveAttribute(
    "placeholder",
  );
  await expect(toolbox(page).getByLabel("分析工具分类")).toHaveCount(0);
  await expect(toolbox(page)).not.toContainText("选择工具");
  await expect(toolbox(page)).not.toContainText("本次运行记录");
  await expect(
    toolbox(page).getByRole("button", { name: "收藏", exact: true }),
  ).toHaveCount(0);
  await categories.first().focus();
  await page.keyboard.press("Enter");
  await expect(categories.first()).toHaveAttribute("aria-expanded", "true");
  await expect(
    toolbox(page).locator(".processing-tool-option:visible"),
  ).toHaveCount(6);
  await toolbox(page).getByLabel("搜索分析工具").fill("centroid");
  await expect(
    toolbox(page).locator(".processing-tool-option:visible"),
  ).toHaveCount(1);
  await tool(page, "质心");
  await toolbox(page).getByLabel("结果图层名称").fill("质心工作稿");
  await toolbox(page)
    .getByRole("button", { name: "关闭工具侧栏", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "工具", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toolbox(page).getByLabel("结果图层名称")).toHaveValue(
    "质心工作稿",
  );
  await page.reload();
  await page.getByRole("button", { name: "工具", exact: true }).click();
  for (const category of await categories.all())
    await expect(category).toHaveAttribute("aria-expanded", "false");
});

test("two layer intersection creates an independent result usable as the next input", async ({
  page,
}) => {
  await start(page);
  await tool(page, "相交");
  await toolbox(page)
    .getByLabel("目标图层", { exact: true })
    .selectOption({ label: "区域乙.geojson" });
  await toolbox(page).getByLabel("结果图层名称").fill("共同区域");
  await run(page).click();
  await expect(toolbox(page).getByRole("status")).toContainText("分析完成");
  await expect(page.locator(".layer-text")).toHaveCount(3);
  const request = (await calls(page))[0].args;
  expect(request.operation).toBe("intersection");
  expect(request.source).toHaveLength(2);
  expect(request.target).toHaveLength(1);
  expect(
    Object.keys((request.source as Record<string, unknown>[])[0]).sort(),
  ).toEqual(["geometry", "id", "properties", "type"]);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(window.__ZG_TEST__.snapshot!).layers[0].features.length,
      ),
    )
    .toBe(2);
  await tool(page, "质心");
  await toolbox(page)
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "共同区域" });
  await toolbox(page).getByLabel("结果图层名称").fill("区域中心");
  await run(page).click();
  await expect(page.locator(".layer-text")).toHaveCount(4);
  await tool(page, "相交");
  await expect(toolbox(page).getByLabel("结果图层名称")).toHaveValue(
    "共同区域",
  );
  expect(await calls(page)).toHaveLength(2);
});

test("text header entry and inline fields keep actions above bottom help at minimum width", async ({
  page,
}) => {
  await start(page);
  const entry = page
    .locator(".header-menus")
    .getByRole("button", { name: "工具", exact: true });
  await expect(entry.locator("svg")).toHaveCount(0);
  expect(
    await page.locator(".header-menus > button").allTextContents(),
  ).toEqual(["工具", "设置"]);
  await expect(
    page
      .locator(".header-actions")
      .getByRole("button", { name: "工具", exact: true }),
  ).toHaveCount(0);
  await tool(page, "相交");
  await page.setViewportSize({ width: 960, height: 640 });
  const resizer = page.getByRole("separator", { name: "调整工具侧栏宽度" });
  await resizer.focus();
  await page.keyboard.press("Home");
  for (const field of ["输入图层", "目标图层", "结果图层名称"]) {
    const input = toolbox(page).getByLabel(field, { exact: true });
    const label = input.locator("..").locator("span");
    const a = (await input.boundingBox())!;
    const b = (await label.boundingBox())!;
    expect(a.x).toBeGreaterThan(b.x + b.width);
    expect(Math.abs(a.y + a.height / 2 - b.y - b.height / 2)).toBeLessThan(2);
  }
  const options = await toolbox(page)
    .getByLabel("输入图层", { exact: true })
    .locator("option")
    .allTextContents();
  expect(options.join("")).not.toContain("个要素");
  await expect(toolbox(page).locator(".processing-description")).toHaveCount(0);
  await expect(toolbox(page)).not.toContainText("参数已就绪");
  await expect(toolbox(page)).not.toContainText("生成独立图层，保留原图层。");
  const button = (await run(page).boundingBox())!;
  const help = (await toolbox(page).locator(".processing-help").boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(help.y);
  expect(help.y + help.height).toBeLessThanOrEqual(640);
  await page.screenshot({ path: "output/tools-workbench-compact.png" });
});

test("failure preserves parameters, retry works, and duplicate runs or close are blocked", async ({
  page,
}) => {
  await start(page);
  await tool(page, "缓冲区");
  await toolbox(page).getByLabel("缓冲距离（米）").fill("250");
  await toolbox(page).getByLabel("结果图层名称").fill("250米缓冲");
  await page.evaluate(() => {
    window.__ZG_TEST__.analysisError = "无效几何，请检查";
    window.__ZG_TEST__.analysisDelay = 400;
  });
  await run(page).click();
  await expect(
    toolbox(page).getByRole("button", { name: "正在分析…", exact: true }),
  ).toBeDisabled();
  await expect(
    toolbox(page).getByRole("button", {
      name: "关闭工具侧栏",
      exact: true,
    }),
  ).toBeDisabled();
  await page.evaluate(() => window.__ZG_TEST__.requestClose());
  expect(await page.evaluate(() => window.__ZG_TEST__.destroyed)).toBe(false);
  await expect(toolbox(page).getByRole("alert")).toContainText("无效几何");
  await expect(toolbox(page).getByLabel("缓冲距离（米）")).toHaveValue("250");
  expect(await calls(page)).toHaveLength(1);
  await page.evaluate(() => {
    window.__ZG_TEST__.analysisError = "";
    window.__ZG_TEST__.analysisDelay = 0;
  });
  await run(page).click();
  await expect(page.locator(".layer-text")).toHaveCount(3);
  expect((await calls(page))[1].args.parameters).toEqual({
    distanceMeters: 250,
  });
});

test("selected input sends only the chosen feature, and invalid distance stays local", async ({
  page,
}) => {
  await start(page);
  await tool(page, "缓冲区");
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await page.locator("tbody tr").first().click();
  await toolbox(page)
    .getByLabel(/仅使用选中的要素/)
    .check();
  await toolbox(page).getByLabel("缓冲距离（米）").fill("0");
  await expect(run(page)).toBeDisabled();
  expect(await calls(page)).toHaveLength(0);
  await toolbox(page).getByLabel("缓冲距离（米）").fill("100");
  await run(page).click();
  await expect(toolbox(page).getByRole("status")).toContainText(
    "输出 1 个要素",
  );
  expect((await calls(page))[0].args.source).toHaveLength(1);
});

test("topology and summary show readable reports without adding vector layers", async ({
  page,
}) => {
  await start(page);
  await tool(page, "拓扑检查");
  await run(page).click();
  await expect(toolbox(page).getByLabel("分析结果")).toContainText("重叠");
  await expect(page.locator(".layer-text")).toHaveCount(2);
  await tool(page, "图层摘要");
  await run(page).click();
  await expect(toolbox(page).getByLabel("分析结果")).toContainText("name");
  await expect(toolbox(page).getByLabel("分析结果")).toContainText("EPSG:4326");
});

test("editing blocks analysis while XYZ coordinates can run", async ({
  page,
}) => {
  await start(page);
  await tool(page, "缓冲区");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(run(page)).toBeDisabled();
  await expect(toolbox(page)).toContainText("保存并退出编辑");
  await page
    .getByRole("button", { name: "保存并退出编辑", exact: true })
    .click();
  await expect(run(page)).toBeEnabled();
  const elevated = JSON.parse(fixture());
  elevated.layers[0].features[0].geometry.coordinates[0] =
    elevated.layers[0].features[0].geometry.coordinates[0].map(
      (coordinate: number[]) => [...coordinate, 8],
    );
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.removeItem("zgis.editRecovery"));
  const next = await page.context().newPage();
  await installDesktopMock(next, JSON.stringify(elevated));
  await next.goto("/");
  await next.getByRole("button", { name: "工具", exact: true }).click();
  await tool(next, "缓冲区");
  await expect(run(next)).toBeEnabled();
  await expect(toolbox(next)).toContainText("按 XY 分析");
  await run(next).click();
  await expect.poll(async () => (await calls(next)).length).toBe(1);
  const request = (await calls(next))[0].args as {
    source: { geometry: { coordinates: number[][][] } }[];
  };
  expect(request.source[0].geometry.coordinates[0][0][2]).toBe(8);
});

test("toolbox stays inside 960px dark and light windows with keyboard controls", async ({
  page,
}) => {
  await start(page);
  await page.setViewportSize({ width: 960, height: 640 });
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    // ResizeObserver may clamp the dock between two independent DOM reads.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const box = document
            .querySelector(".processing-toolbox")!
            .getBoundingClientRect();
          const map = document
            .querySelector(".map-surface")!
            .getBoundingClientRect();
          return (
            box.right <= 960 && map.width > 200 && map.right <= box.left + 1
          );
        }),
      )
      .toBe(true);
    await toolbox(page).getByLabel("搜索分析工具").fill("centroid");
    if (
      (await toolbox(page)
        .locator(".processing-tool-option")
        .getAttribute("aria-pressed")) === "true"
    )
      await toolbox(page).locator(".processing-tool-option").click();
    await toolbox(page).locator(".processing-tool-option").focus();
    await page.keyboard.press("Enter");
    await expect(toolbox(page).locator(".processing-tool-title")).toContainText(
      "质心",
    );
    await page.screenshot({ path: `output/processing-toolbox-${theme}.png` });
  }
});

test("browser version explains the desktop requirement", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await tool(page, "缓冲区");
  await expect(toolbox(page)).toContainText("空间分析需要桌面版");
  await expect(run(page)).toBeDisabled();
});
