import { test, expect } from "@playwright/test";
import {
  installDesktopMock,
  openDatabaseManager,
  addTestSource,
} from "./desktop.mock";

for (const engine of ["PostGIS", "Mysql"] as const) {
  test(`${engine} manager dialog traps focus, closes with Escape and restores focus`, async ({
    page,
  }) => {
    await installDesktopMock(page);
    await page.goto("/");
    await openDatabaseManager(page, engine);
    const manager = page.getByRole("region", {
      name: `${engine} 数据源管理`,
      exact: true,
    });
    await expect(
      manager.getByRole("button", { name: "返回地图" }),
    ).toBeFocused();
    const add = manager.getByRole("button", {
      name: "新增数据源",
      exact: true,
    });
    await add.click();
    const dialog = page.getByRole("dialog", { name: `新增 ${engine} 数据源` });
    await expect(dialog).toHaveJSProperty("open", true);
    await expect(
      dialog.getByLabel("数据源名称", { exact: true }),
    ).toBeFocused();
    await dialog.getByLabel("TLS", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(manager).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(manager).toBeHidden();
    await expect(
      page.locator(".app-header summary").filter({ hasText: /^数据$/ }),
    ).toBeFocused();
    await openDatabaseManager(page, engine);
    await manager
      .getByRole("button", { name: "返回地图", exact: true })
      .click();
    await expect(
      page.locator(".app-header summary").filter({ hasText: /^数据$/ }),
    ).toBeFocused();
  });

  test(`${engine} connection dialog focuses password after asynchronous loading`, async ({
    page,
  }) => {
    await installDesktopMock(page);
    await page.goto("/");
    await openDatabaseManager(page, engine);
    await addTestSource(page, "连接焦点测试", engine);
    const manager = page.getByRole("region", {
      name: `${engine} 数据源管理`,
      exact: true,
    });
    const settings = manager.getByRole("button", {
      name: "连接设置",
      exact: true,
    });
    await settings.click();
    const dialog = page.getByRole("dialog", {
      name: "连接数据源",
      exact: true,
    });
    await expect(dialog.getByLabel("密码", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
  });
}

test("narrow database preview keeps long names and controls inside viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await installDesktopMock(page);
  await page.goto("/");
  await openDatabaseManager(page);
  const longTable = "very_long_table_name_for_spatial_dataset_".repeat(5);
  await page.evaluate((table) => {
    window.__ZG_TEST__.catalogs["connect_database-1"] = {
      schemas: ["public"],
      tables: [
        {
          schema: "public",
          table,
          columns: [],
          keyColumns: ["id"],
          geometryColumns: [{ name: "geom", type: "Point", srid: 4326 }],
        },
      ],
    };
  }, longTable);
  await addTestSource(page, "用于窄窗口验证的很长的数据源名称".repeat(3));
  const manager = page.getByRole("region", {
    name: "PostGIS 数据源管理",
    exact: true,
  });
  await manager.locator(".pg-table").filter({ hasText: longTable }).click();
  await expect(
    manager.getByRole("region", { name: "数据预览记录" }),
  ).toBeVisible();
  await manager.getByLabel("搜索数据表").focus();
  await page.keyboard.press("Escape");
  await expect(manager).toBeVisible();
  for (const label of ["返回地图", "添加到地图", "刷新预览"]) {
    const box = await manager
      .getByRole("button", { name: label, exact: true })
      .boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(960);
    expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  }
  await manager
    .getByRole("button", { name: "新增数据源", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新增 PostGIS 数据源" });
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  await expect(
    dialog.getByRole("button", { name: "取消", exact: true }),
  ).toBeInViewport();
});
