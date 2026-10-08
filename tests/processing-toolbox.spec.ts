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
  await page
    .getByRole("button", { name: "空间分析工具箱", exact: true })
    .click();
  await expect(toolbox(page)).toBeVisible();
}
async function tool(page: Page, label: string) {
  await toolbox(page)
    .locator(".processing-tool-option")
    .getByText(label, { exact: true })
    .click();
}
const calls = (page: Page) =>
  page.evaluate(() =>
    window.__ZG_TEST__.calls.filter(
      (item) => item.command === "gis_run_analysis",
    ),
  );

test("search, categories, favorites, hiding and keyboard preserve the usable toolbox", async ({
  page,
}) => {
  await start(page);
  await expect(toolbox(page).locator(".processing-tool-option")).toHaveCount(
    22,
  );
  await toolbox(page).getByLabel("搜索分析工具").fill("centroid");
  await expect(toolbox(page).locator(".processing-tool-option")).toHaveCount(1);
  await tool(page, "质心");
  await toolbox(page)
    .getByRole("button", { name: "收藏质心", exact: true })
    .click();
  await toolbox(page)
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  await toolbox(page).getByLabel("搜索分析工具").fill("");
  await expect(toolbox(page).locator(".processing-tool-option")).toHaveCount(1);
  await toolbox(page).getByLabel("结果图层名称").fill("质心工作稿");
  await toolbox(page)
    .getByRole("button", { name: "关闭空间分析工具箱", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "空间分析工具箱", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toolbox(page).getByLabel("结果图层名称")).toHaveValue(
    "质心工作稿",
  );
  await page.reload();
  await page
    .getByRole("button", { name: "空间分析工具箱", exact: true })
    .click();
  await toolbox(page)
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  await expect(toolbox(page).locator(".processing-tool-option")).toHaveText(
    "质心",
  );
});

test("two layer intersection creates an independent result usable as the next input", async ({
  page,
}) => {
  await start(page);
  await tool(page, "相交");
  await toolbox(page)
    .getByLabel("目标图层", { exact: true })
    .selectOption({ label: "区域乙.geojson · 1 个要素" });
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
    .selectOption({ label: "共同区域 · 2 个要素" });
  await toolbox(page).getByLabel("结果图层名称").fill("区域中心");
  await run(page).click();
  await expect(page.locator(".layer-text")).toHaveCount(4);
  await toolbox(page)
    .getByRole("button", { name: "本次运行记录", exact: false })
    .click();
  await expect(toolbox(page).locator(".processing-history-item")).toHaveCount(
    2,
  );
  await toolbox(page).locator(".processing-history-item").last().click();
  await expect(toolbox(page).getByLabel("结果图层名称")).toHaveValue(
    "共同区域",
  );
  expect(await calls(page)).toHaveLength(2);
});

test("failure preserves parameters, retry works, and duplicate runs or close are blocked", async ({
  page,
}) => {
  await start(page);
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
      name: "关闭空间分析工具箱",
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

test("editing and elevated geometry give explicit guidance and cannot run", async ({
  page,
}) => {
  await start(page);
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
  await next
    .getByRole("button", { name: "空间分析工具箱", exact: true })
    .click();
  await expect(run(next)).toBeDisabled();
  await expect(toolbox(next)).toContainText("含高程");
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
  await page
    .getByRole("button", { name: "空间分析工具箱", exact: true })
    .click();
  await expect(toolbox(page)).toContainText("空间分析需要桌面版");
  await expect(run(page)).toBeDisabled();
});
