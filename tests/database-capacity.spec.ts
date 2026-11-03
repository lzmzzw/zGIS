import { expect, test } from "@playwright/test";
import { addTestSource, installDesktopMock, openDatabaseManager } from "./desktop.mock";

for (const engine of ["PostGIS", "Mysql"] as const) {
  test(`${engine} accepts a bounded 100,000-row load and rejects larger requests`, async ({ page }) => {
    await installDesktopMock(page);
    await page.goto("/");
    await openDatabaseManager(page, engine);
    await addTestSource(page, "容量验证", engine);
    const manager = page.getByRole("region", { name: `${engine} 数据源管理`, exact: true });
    await manager.locator(".pg-table").filter({ hasText: /^roads$/ }).click();
    await manager.getByRole("button", { name: "添加到地图", exact: true }).click();
    const limit = page.getByLabel("最多读取记录", { exact: true });
    const load = page.getByRole("button", { name: "载入", exact: true });
    await expect(limit).toHaveAttribute("max", "100000");
    await limit.fill("100001");
    await expect(load).toBeDisabled();
    await limit.fill("0");
    await expect(load).toBeDisabled();
    await limit.fill("100000");
    await expect(load).toBeEnabled();
    await load.click();
    const command = engine === "Mysql" ? "query_mysql_geometry" : "query_layer";
    await expect.poll(() => page.evaluate((name) => window.__ZG_TEST__.calls.filter(call => call.command === name).at(-1)?.args.limit, command)).toBe(100000);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}
