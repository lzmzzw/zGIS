import { test, expect } from "@playwright/test";

test("custom XYZ services share settings order, selection and restart state", async ({
  page,
}) => {
  await page.goto("/");
  const tiles: string[] = [];
  await page.route("https://custom.example.com/**", async (route) => {
    tiles.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page.getByRole("button", { name: "添加底图", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "添加底图", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加", exact: true })
    .click();
  await expect(
    page.getByText("请输入底图名称。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("新底图名称").fill("自定义测试底图");
  await page
    .getByLabel("XYZ 瓦片地址")
    .fill("https://custom.example.com/{z}/{x}/{y}.png");
  await page.getByLabel("底图来源说明").fill("测试服务来源");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加", exact: true })
    .click();
  for (let index = 0; index < 3; index++)
    await page
      .getByRole("button", { name: "上移 自定义测试底图", exact: true })
      .click();
  await expect(page.locator(".basemap-service-list li").first()).toContainText(
    "自定义测试底图",
  );
  await page.getByLabel("底图类型").selectOption({ label: "自定义测试底图" });
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(page.getByRole("radio").first()).toHaveAttribute(
    "aria-label",
    "自定义测试底图",
  );
  await expect(
    page.getByRole("radio", { name: "自定义测试底图", exact: true }),
  ).toBeChecked();
  await expect(page.getByText("测试服务来源", { exact: true })).toBeVisible();
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.reload();
  await page.getByRole("button", { name: "底图", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "自定义测试底图", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "地图", exact: true })
    .click();
  await page
    .getByRole("button", { name: "删除 自定义测试底图", exact: true })
    .click();
  await expect(page.locator(".basemap-service-list li")).toHaveCount(3);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".basemap-service-list li").first()).toContainText(
    "自定义测试底图",
  );
});
