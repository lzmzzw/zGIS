import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export async function settingsInfoSmoke(page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const category = (name) =>
    page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name, exact: true });
  await category("地图").click();
  await expect(page.locator(".basemap-settings-heading h3")).toHaveText(
    "底图服务",
  );
  await expect(page.locator(".basemap-settings-heading .count")).toHaveCount(0);
  await category("MCP").click();
  await expect(
    page.getByRole("heading", { name: "MCP", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/最近工具调用|尚无工具调用/)).toHaveCount(0);
  await category("关于").click();
  const about = page.locator(".settings-about");
  await expect(about.locator(".about-settings-card")).toHaveCount(4);
  await expect(about).toContainText(`v${version}`);
  await expect(about).toContainText("github.com/lzmzzw/zGIS");
  await expect(about).toContainText("GPL 3.0");
  for (const removed of ["格式", "来源坐标系", "高程", "工作副本"])
    await expect(about.getByText(removed, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  // 公网不可用或无发行版时应显示真实状态，不将失败当作“已是最新”。
  await expect(about.getByRole("status")).toHaveText(
    /^(暂无可用的发布版本|当前已是最新版本|发现新版本 v.+|检查失败，请重试)$/,
    { timeout: 15000 },
  );
  await expect(
    page.getByRole("button", { name: "检查更新", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "output/desktop/settings-about-installed.png",
  });
  // 验证原生链接边界，不在自动化中打开用户浏览器。
  const rejected = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("open_project_link", {
        target: "https://invalid.example",
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  console.log(
    "PASS: native concise settings/about, runtime version, real release check and fixed-link boundary",
  );
}
