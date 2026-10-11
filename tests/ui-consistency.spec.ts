import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function setup(page: Page, theme = "dark") {
  await installDesktopMock(page);
  await page.addInitScript(
    (value) => localStorage.setItem("zgis.theme", value),
    theme,
  );
  // 样式验证不依赖第三方底图网络，也不启动真实桌面服务。
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:1421)/, (route) =>
    route.abort(),
  );
  await page.goto("/");
}

test("底图错误定位到字段，删除和撤销保留键盘操作位置", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "地图", exact: true }).click();
  await page.getByRole("button", { name: "添加底图", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加底图", exact: true });
  const name = dialog.getByLabel("新底图名称", { exact: true });
  const url = dialog.getByLabel("XYZ 瓦片地址", { exact: true });
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAccessibleDescription("请输入底图名称。");
  await name.fill("项目底图");
  await expect(name).not.toHaveAttribute("aria-invalid");
  await name.press("Enter");
  await expect(url).toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(url).toHaveAccessibleDescription(/HTTP\(S\)/);
  await expect(name).toHaveValue("项目底图");
  await page.screenshot({
    path: "output/ui-unification/current/field-validation.png",
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "删除 OpenStreetMap", exact: true })
    .click();
  const undo = page.getByRole("button", { name: "撤销", exact: true });
  await expect(undo).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "编辑 OpenStreetMap", exact: true }),
  ).toBeFocused();
});

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 960]) {
    test(`公共控件、浮层和短窗口保持一致 ${theme} ${width}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 640 });
      await setup(page, theme);
      await page.locator("input[type=file]").setInputFiles({
        name: "测绘项目_连续区域边界与长名称.geojson",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [114.2, 30.5],
                      [114.3, 30.5],
                      [114.3, 30.6],
                      [114.2, 30.6],
                      [114.2, 30.5],
                    ],
                  ],
                },
                properties: { 名称: "项目边界", 编号: "001", 面积: 3200 },
              },
              {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [114.3, 30.5],
                      [114.38, 30.5],
                      [114.38, 30.6],
                      [114.3, 30.6],
                      [114.3, 30.5],
                    ],
                  ],
                },
                properties: { 名称: "相邻区域", 编号: "002", 面积: 2600 },
              },
            ],
          }),
        ),
      });
      const submit = page.getByRole("button", { name: "导入", exact: true });
      await expect(submit).toBeEnabled();
      const primary = await submit.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, color: style.color };
      });
      // 验证真实渲染的主按钮文字对比度，而不是只验证变量存在。
      const ratio = await submit.evaluate((element) => {
        const luminance = (color: string) => {
          const rgb = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const style = getComputedStyle(element);
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({
        path: `output/ui-unification/current/import-${theme}-${width}.png`,
      });
      await submit.click();
      await page.locator(".layer-text").first().dblclick();
      await page
        .getByRole("button", { name: "展开属性表", exact: true })
        .click();
      await page.getByRole("button", { name: "工具", exact: true }).click();
      await page.getByPlaceholder("搜索工具…").fill("缓冲区");
      await page.getByRole("button", { name: "缓冲区", exact: true }).click();
      const run = page.getByRole("button", { name: "运行分析", exact: true });
      await expect(run).toBeEnabled();
      await expect(run).toHaveCSS("background-color", primary.background);
      await expect(run).toHaveCSS("color", primary.color);
      await expect(run).toHaveCSS("border-radius", "4px");
      const sidebar = page.locator(".right-sidebar");
      await expect(sidebar).toHaveCSS(
        "background-color",
        await page
          .locator(".layers-panel")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      const box = (await run.boundingBox())!;
      expect(box.y).toBeGreaterThan(44);
      expect(box.y + box.height).toBeLessThanOrEqual(
        page.viewportSize()!.height,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.waitForTimeout(350); // 等待地图定位的 250ms 动画结束再留图。
      await page.screenshot({
        path: `output/ui-unification/current/workspace-${theme}-${width}.png`,
      });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "地图", exact: true }).click();
      await page.screenshot({
        path: `output/ui-unification/current/settings-${theme}-${width}.png`,
      });
      expect(errors).toEqual([]);
    });
  }
}
