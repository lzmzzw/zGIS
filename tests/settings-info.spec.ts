import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

const category = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name, exact: true });
async function setup(page: Page) {
  await installDesktopMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
}
test("settings remove the basemap total, shorten MCP and stop fetching audit records", async ({
  page,
}) => {
  await setup(page);
  await category(page, "地图").click();
  await expect(page.locator(".basemap-settings-heading h3")).toHaveText(
    "底图服务",
  );
  await expect(page.locator(".basemap-settings-heading .count")).toHaveCount(0);
  await category(page, "MCP").click();
  await expect(
    page.getByRole("heading", { name: "MCP", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "空间分析 MCP", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/最近工具调用|尚无工具调用/)).toHaveCount(0);
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.filter(
        (call) => call.command === "gis_mcp_audit",
      ),
    ),
  ).toHaveLength(0);
});
test("about shows runtime version, repository and GPL, and opens only fixed system-browser links", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.__ZG_TEST__.appVersion = "0.2.3";
  });
  await category(page, "关于").click();
  const about = page.locator(".settings-about");
  await expect(about.locator(".about-settings-card")).toHaveCount(4);
  await expect(about).toContainText("v0.2.3");
  await expect(about).toContainText("github.com/lzmzzw/zGIS");
  await expect(about).toContainText("GPL 3.0");
  for (const text of ["格式", "来源坐标系", "高程", "工作副本", "EPSG:4326"])
    await expect(about.getByText(text, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await page.getByRole("button", { name: "查看开源协议", exact: true }).click();
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls
        .filter((call) => call.command === "open_project_link")
        .map((call) => call.args),
    ),
  ).toEqual([{ target: "github" }, { target: "license" }]);
  await page.evaluate(() => {
    window.__ZG_TEST__.linkError = "private-token-error";
  });
  await page.getByRole("button", { name: "打开 GitHub", exact: true }).click();
  await expect(about.getByRole("alert")).toHaveText("打开链接失败，请重试。");
  await expect(about).not.toContainText("private-token-error");
});
test("update checks distinguish unpublished, current and newer releases and recover from errors", async ({
  page,
}) => {
  await setup(page);
  await category(page, "关于").click();
  const check = page.getByRole("button", { name: "检查更新", exact: true });
  const status = page.locator(".settings-about").getByRole("status");
  await check.click();
  await expect(status).toHaveText("暂无可用的发布版本");
  await page.evaluate(() => {
    window.__ZG_TEST__.updateResult = {
      currentVersion: "0.1.0",
      status: "current",
      latestVersion: "0.1.0",
    };
  });
  await check.click();
  await expect(status).toHaveText("当前已是最新版本");
  await page.evaluate(() => {
    window.__ZG_TEST__.updateResult = {
      currentVersion: "0.1.0",
      status: "available",
      latestVersion: "0.2.0",
    };
  });
  await check.click();
  await expect(status).toHaveText("发现新版本 v0.2.0");
  await page.getByRole("button", { name: "查看更新", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls
          .filter((call) => call.command === "open_project_link")
          .at(-1)?.args,
    ),
  ).toEqual({ target: "releases" });
  await page.evaluate(() => {
    window.__ZG_TEST__.updateError = "private-network-error";
  });
  await check.click();
  await expect(status).toHaveText("检查失败，请重试");
  await expect(
    page.getByRole("button", { name: "查看更新", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".settings-about")).not.toContainText(
    "private-network-error",
  );
  await page.evaluate(() => {
    window.__ZG_TEST__.updateError = "";
  });
  await check.click();
  await expect(status).toHaveText("发现新版本 v0.2.0");
});
test("checking disables repeat clicks and late responses do not affect a remounted about page", async ({
  page,
}) => {
  await setup(page);
  await category(page, "关于").click();
  await page.evaluate(() => {
    window.__ZG_TEST__.updateDelay = 700;
    window.__ZG_TEST__.updateResult = {
      currentVersion: "0.1.0",
      status: "available",
      latestVersion: "9.9.9",
    };
  });
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "检查中…", exact: true }),
  ).toBeDisabled();
  await category(page, "地图").click();
  await category(page, "关于").click();
  await expect(page.locator(".settings-about").getByRole("status")).toHaveText(
    "未检查",
  );
  await page.waitForTimeout(850);
  await expect(page.locator(".settings-about").getByRole("status")).toHaveText(
    "未检查",
  );
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.filter(
        (call) => call.command === "check_app_update",
      ),
    ),
  ).toHaveLength(1);
});
test("browser about uses safe external links and does not pretend to perform native updates", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await category(page, "关于").click();
  const github = page.getByRole("link", { name: "打开 GitHub", exact: true });
  await expect(github).toHaveAttribute(
    "href",
    "https://github.com/lzmzzw/zGIS",
  );
  await expect(github).toHaveAttribute("target", "_blank");
  await expect(github).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page.getByRole("link", { name: "查看开源协议", exact: true }),
  ).toHaveAttribute("href", "https://www.gnu.org/licenses/gpl-3.0.html");
  await expect(
    page.getByRole("link", { name: "查看发布页", exact: true }),
  ).toHaveAttribute("href", "https://github.com/lzmzzw/zGIS/releases");
  await expect(
    page.getByRole("button", { name: "检查更新", exact: true }),
  ).toHaveCount(0);
});
