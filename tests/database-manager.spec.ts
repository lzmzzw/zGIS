import { test, expect, type Page } from "@playwright/test";
import {
  installDesktopMock,
  openDatabaseManager,
  addTestSource,
} from "./desktop.mock";

const manager = (page: Page, engine = "PostGIS") =>
  page.getByRole("region", { name: `${engine} 数据源管理`, exact: true });
const table = (page: Page, name: string, engine = "PostGIS") =>
  manager(page, engine)
    .locator(".pg-table")
    .filter({ hasText: new RegExp(`^${name}(普通表)?$`) });
async function setup(page: Page, engine: "PostGIS" | "Mysql" = "PostGIS") {
  await installDesktopMock(page);
  await page.goto("/");
  await openDatabaseManager(page, engine);
}

test("data menu contains exactly two managers and their empty pages preserve map navigation", async ({
  page,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page
    .locator(".app-header summary")
    .filter({ hasText: /^数据$/ })
    .click();
  await expect(page.locator(".header-menu[open] button")).toHaveText([
    "Mysql 数据源",
    "PostGIS 数据源",
  ]);
  await page.keyboard.press("Escape");
  for (const engine of ["Mysql", "PostGIS"] as const) {
    await openDatabaseManager(page, engine);
    await expect(manager(page, engine)).toBeVisible();
    await expect(manager(page, engine).locator(".pg-source")).toHaveCount(0);
    await manager(page, engine)
      .getByRole("button", { name: "新增数据源", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("端口", { exact: true })).toHaveValue(
      engine === "Mysql" ? "3306" : "5432",
    );
    await expect(dialog.getByLabel("TLS", { exact: true })).toHaveValue(
      "require",
    );
    await expect(
      dialog.getByRole("button", { name: "添加并连接", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await manager(page, engine)
      .getByRole("button", { name: "返回地图", exact: true })
      .click();
    await expect(
      page.getByLabel("地理数据地图", { exact: true }),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some((c) => c.command.startsWith("connect_")),
    ),
  ).toBe(false);
});

for (const engine of ["PostGIS", "Mysql"] as const) {
  test(`${engine} password storage failures preserve source and saved credentials for retry`, async ({
    page,
  }) => {
    await setup(page, engine);
    await addTestSource(page, "密码失败测试", engine);
    const panel = manager(page, engine),
      dialog = page.getByRole("dialog", { name: "连接数据源", exact: true });
    const source = await page.evaluate(
      (engine) =>
        (engine === "Mysql"
          ? window.__ZG_TEST__.mysqlSources
          : window.__ZG_TEST__.databaseSources)[0],
      engine,
    );
    const passwordKey = `${engine === "Mysql" ? "mysql" : "postgis"}/${source.id}`;
    expect(
      await page.evaluate(
        (key) => window.__ZG_TEST__.storedDatabasePasswords[key],
        passwordKey,
      ),
    ).toBe("test-only-password");
    await page.evaluate(
      () => (window.__ZG_TEST__.passwordLoadError = "密码读取失败"),
    );
    await panel.getByRole("button", { name: "连接设置", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("密码读取失败");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.evaluate(() => (window.__ZG_TEST__.passwordLoadError = ""));
    await panel.getByRole("button", { name: "连接设置", exact: true }).click();
    await expect(dialog.getByLabel("密码", { exact: true })).toHaveValue(
      "test-only-password",
    );
    await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await dialog
      .getByLabel("密码", { exact: true })
      .fill("replacement-test-password");
    await page.evaluate(
      () => (window.__ZG_TEST__.passwordSaveError = "密码保存失败"),
    );
    await dialog.getByRole("button", { name: "连接", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("密码保存失败");
    expect(
      await page.evaluate(
        (key) => window.__ZG_TEST__.storedDatabasePasswords[key],
        passwordKey,
      ),
    ).toBe("test-only-password");
    await expect(panel.locator(".pg-source")).toContainText("已连接");
    await page.evaluate(() => (window.__ZG_TEST__.passwordSaveError = ""));
    await dialog.getByRole("button", { name: "连接", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        (key) => window.__ZG_TEST__.storedDatabasePasswords[key],
        passwordKey,
      ),
    ).toBe("replacement-test-password");
    await panel
      .getByRole("button", { name: "删除数据源", exact: true })
      .click();
    await page.evaluate(
      () => (window.__ZG_TEST__.passwordDeleteError = "密码删除失败"),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "密码删除失败",
    );
    await expect(panel.locator(".pg-source")).toHaveCount(1);
    expect(
      await page.evaluate(
        (engine) =>
          (engine === "Mysql"
            ? window.__ZG_TEST__.mysqlSources
            : window.__ZG_TEST__.databaseSources
          ).length,
        engine,
      ),
    ).toBe(1);
    expect(
      await page.evaluate(
        (key) => window.__ZG_TEST__.storedDatabasePasswords[key],
        passwordKey,
      ),
    ).toBe("replacement-test-password");
    await page.evaluate(() => (window.__ZG_TEST__.passwordDeleteError = ""));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(panel.locator(".pg-source")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.__ZG_TEST__.storedDatabasePasswords),
    ).toEqual({});
  });
  test(`${engine} stored source passwords are remembered with explicit show/hide and separate persistence`, async ({
    page,
  }) => {
    const engineKey = engine === "Mysql" ? "mysql" : "postgis";
    const source = {
      id: "saved-source",
      name: "已保存源",
      host: "test.invalid",
      port: engine === "Mysql" ? 3306 : 5432,
      database: "test",
      user: "tester",
      sslMode: "require",
    };
    await installDesktopMock(page, null, {
      [engine === "Mysql" ? "mysqlSources" : "databaseSources"]: [source],
      passwords: { [`${engineKey}/saved-source`]: "remembered-test-password" },
    });
    await page.goto("/");
    await openDatabaseManager(page, engine);
    await manager(page, engine)
      .getByRole("button", { name: "连接数据源", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "连接数据源",
      exact: true,
    });
    await expect(dialog.getByLabel("密码", { exact: true })).toHaveValue(
      "remembered-test-password",
    );
    await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await dialog.getByRole("button", { name: "显示密码", exact: true }).click();
    await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute(
      "type",
      "text",
    );
    await dialog.getByRole("button", { name: "隐藏密码", exact: true }).click();
    await expect(dialog.getByLabel("密码", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await dialog.getByRole("button", { name: "连接", exact: true }).click();
    await expect(manager(page, engine).locator(".pg-source")).toContainText(
      "已连接",
    );
    const calls = await page.evaluate(() => window.__ZG_TEST__.calls);
    expect(
      calls.find(
        (c) =>
          c.command ===
          (engine === "Mysql" ? "connect_mysql_database" : "connect_database"),
      )?.args.config,
    ).toEqual(
      expect.objectContaining({ password: "remembered-test-password" }),
    );
    expect(
      calls.find((c) => c.command === "save_database_source_password")?.args,
    ).toEqual({
      engine: engineKey,
      sourceId: "saved-source",
      password: "remembered-test-password",
    });
    expect(
      JSON.stringify(
        await page.evaluate(
          (engine) =>
            engine === "Mysql"
              ? window.__ZG_TEST__.mysqlSources
              : window.__ZG_TEST__.databaseSources,
          engine,
        ),
      ),
    ).not.toContain("password");
    await manager(page, engine)
      .getByRole("button", { name: "删除数据源", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(manager(page, engine).locator(".pg-source")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.__ZG_TEST__.storedDatabasePasswords),
    ).toEqual({});
  });
  test(`${engine} keeps passwords out of plain source config and browses spatial/ordinary tables`, async ({
    page,
  }) => {
    await setup(page, engine);
    await addTestSource(page, "目录测试", engine);
    const panel = manager(page, engine);
    await expect(panel.locator(".pg-source")).toContainText("目录测试");
    const saved = await page.evaluate(
      (engine) =>
        window.__ZG_TEST__.calls.find(
          (c) =>
            c.command ===
            (engine === "Mysql"
              ? "save_mysql_sources"
              : "save_database_sources"),
        )?.args.sources,
      engine,
    );
    expect(saved).toEqual([
      expect.objectContaining({
        name: "目录测试",
        host: "test.invalid",
        database: "test",
        user: "tester",
        sslMode: "require",
        port: engine === "Mysql" ? 3306 : 5432,
      }),
    ]);
    expect(JSON.stringify(saved)).not.toContain("password");
    if (engine === "Mysql")
      await expect(panel.locator(".pg-schema")).toHaveCount(0);
    else {
      await expect(panel.locator(".pg-schema")).toHaveText([
        "public4",
        "archive1",
        "empty0",
      ]);
      await panel
        .locator(".pg-schema")
        .filter({ hasText: /^empty0$/ })
        .click();
      await expect(panel).toContainText("此筛选下没有数据表");
      await panel
        .locator(".pg-schema")
        .filter({ hasText: /^public4$/ })
        .click();
    }
    await expect(table(page, "counts", engine)).toHaveCount(0);
    await panel.getByRole("button", { name: "全部表", exact: true }).click();
    await table(page, "counts", engine).click();
    await expect(
      panel.getByRole("button", { name: "添加到地图", exact: true }),
    ).toBeDisabled();
    await expect(panel.getByLabel("预览条数", { exact: true })).toHaveValue(
      "20",
    );
    await expect(panel.locator("tbody tr")).toHaveCount(20);
    await expect(panel.locator("tbody tr").first()).toContainText(
      "9007199254740993",
    );
    await expect(panel.locator("tbody tr").nth(1)).toContainText("NULL");
    await panel.getByLabel("预览条数", { exact: true }).selectOption("10");
    await expect(panel.locator("tbody tr")).toHaveCount(10);
    await page.screenshot({
      path: `output/playwright/${engine.toLowerCase()}-manager.png`,
    });
    await panel
      .getByRole("button", { name: "仅含 geometry", exact: true })
      .click();
    await expect(table(page, "counts", engine)).toHaveCount(0);
    await table(page, "dual_geom", engine).click();
    await expect(panel.getByLabel("几何列", { exact: true })).toHaveValue(
      "geom",
    );
    await panel.getByLabel("几何列", { exact: true }).selectOption("boundary");
    await expect(panel.locator(".pg-meta")).toContainText(
      "MultiPolygon · EPSG:4490",
    );
    await panel.getByLabel("搜索数据表", { exact: true }).fill("dual");
    await expect(panel.locator(".pg-table")).toHaveCount(1);
    await table(page, "dual_geom", engine).click();
    await panel.getByRole("button", { name: "返回地图", exact: true }).click();
    await openDatabaseManager(page, engine);
    await expect(panel.getByLabel("搜索数据表", { exact: true })).toHaveValue(
      "dual",
    );
    await expect(panel.locator("tbody tr")).toHaveCount(10);
  });

  test(`${engine} source save failures retain dialog and list; deletion is persistent and disconnects`, async ({
    page,
  }) => {
    await setup(page, engine);
    await page.evaluate(
      () => (window.__ZG_TEST__.sourceSaveError = "配置保存失败"),
    );
    await addTestSource(page, "保留源", engine);
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "配置保存失败",
    );
    await expect(manager(page, engine).locator(".pg-source")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (engine) =>
            window.__ZG_TEST__.calls.filter(
              (c) =>
                c.command ===
                (engine === "Mysql"
                  ? "disconnect_mysql_database"
                  : "disconnect_database"),
            ).length,
          engine,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(() => window.__ZG_TEST__.storedDatabasePasswords),
    ).toEqual({});
    await page.evaluate(() => (window.__ZG_TEST__.sourceSaveError = ""));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "添加并连接", exact: true })
      .click();
    await expect(manager(page, engine).locator(".pg-source")).toHaveCount(1);
    await manager(page, engine)
      .getByRole("button", { name: "删除数据源", exact: true })
      .click();
    await page.evaluate(
      () => (window.__ZG_TEST__.sourceSaveError = "删除保存失败"),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      "删除保存失败",
    );
    await expect(manager(page, engine).locator(".pg-source")).toHaveCount(1);
    await page.evaluate(() => (window.__ZG_TEST__.sourceSaveError = ""));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect(manager(page, engine).locator(".pg-source")).toHaveCount(0);
    expect(
      await page.evaluate(
        (engine) =>
          engine === "Mysql"
            ? window.__ZG_TEST__.mysqlSources
            : window.__ZG_TEST__.databaseSources,
        engine,
      ),
    ).toEqual([]);
  });

  test(`${engine} previews can retry and rapid table/source changes discard stale results`, async ({
    page,
  }) => {
    await setup(page, engine);
    await addTestSource(page, "第一源", engine);
    const panel = manager(page, engine);
    await page.evaluate(() => (window.__ZG_TEST__.previewError = "预览失败"));
    await table(page, "roads", engine).click();
    await expect(panel.getByRole("alert")).toContainText("预览失败");
    await page.evaluate(() => {
      window.__ZG_TEST__.previewError = "";
      window.__ZG_TEST__.previewDelays.roads = 500;
    });
    await panel.getByRole("button", { name: "重试预览", exact: true }).click();
    await table(page, "readonly", engine).click();
    await expect(panel.locator("tbody tr").first()).toContainText("/readonly");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__ZG_TEST__.previewCompletions.filter((t) => t === "roads")
              .length,
        ),
      )
      .toBe(2);
    await expect(panel.locator("tbody tr").first()).toContainText("/readonly");
    await addTestSource(page, "第二源", engine);
    await table(page, "roads", engine).click();
    await panel.locator(".pg-source").filter({ hasText: "第一源" }).click();
    if (engine === "PostGIS")
      await panel
        .locator(".pg-schema")
        .filter({ hasText: /^public4$/ })
        .click();
    await table(page, "readonly", engine).click();
    await expect(panel.locator("tbody tr").first()).toContainText(
      "connect_" +
        (engine === "Mysql" ? "mysql_database" : "database") +
        "-1/readonly",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__ZG_TEST__.previewCompletions.filter((t) => t === "roads")
              .length,
        ),
      )
      .toBe(3);
    await expect(panel.locator("tbody tr").first()).toContainText(
      "-1/readonly",
    );
  });
}

test("PostGIS data source deletion is blocked while a loaded layer retains its connection", async ({
  page,
}) => {
  await setup(page);
  await addTestSource(page);
  await table(page, "roads").click();
  await manager(page)
    .getByRole("button", { name: "添加到地图", exact: true })
    .click();
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await openDatabaseManager(page);
  await manager(page)
    .getByRole("button", { name: "删除数据源", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "请先移除引用此数据源的图层",
  );
  await expect(manager(page).locator(".pg-source")).toHaveCount(1);
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (c) => c.command === "save_database_sources",
        ).length,
    ),
  ).toBe(1);
});

test("Mysql geometry loads its database source with the selected geometry column", async ({
  page,
}) => {
  await setup(page, "Mysql");
  await addTestSource(page, "MySQL加载", "Mysql");
  await table(page, "dual_geom", "Mysql").click();
  await manager(page, "Mysql")
    .getByLabel("几何列", { exact: true })
    .selectOption("boundary");
  await manager(page, "Mysql")
    .getByRole("button", { name: "添加到地图", exact: true })
    .click();
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await expect(page.locator(".tree-row")).toContainText("dual_geom");
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.find(
          (c) => c.command === "query_mysql_geometry",
        )?.args,
    ),
  ).toEqual(
    expect.objectContaining({
      connectionId: "connect_mysql_database-1",
      schema: "test",
      table: "dual_geom",
      geometryColumn: "boundary",
      srid: 4490,
      limit: 10000,
    }),
  );
  await expect(page.getByLabel("地理数据地图", { exact: true })).toBeVisible();
});

for (const theme of ['dark', 'light'] as const) {
  test(`manager narrow layout and password dialog stay usable (${theme})`, async ({ page }) => {
    await page.setViewportSize({width:960,height:720});
    await installDesktopMock(page); await page.goto('/');
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByLabel('主题',{exact:true}).selectOption(theme);
    await page.getByRole('button',{name:'返回地图',exact:true}).click();
    for (const engine of ['PostGIS','Mysql'] as const) {
      await openDatabaseManager(page,engine); await addTestSource(page,'布局测试',engine);
      await table(page,'roads',engine).click();
      await expect(manager(page,engine).locator('.pg-preview-scroll table')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:`output/playwright/${engine.toLowerCase()}-manager-${theme}-960.png`});
      await manager(page,engine).getByRole('button',{name:'连接设置',exact:true}).click();
      const dialog=page.getByRole('dialog');
      await expect(dialog.getByRole('button',{name:'显示密码',exact:true})).toBeEnabled();
      await page.screenshot({path:`output/playwright/${engine.toLowerCase()}-password-${theme}-960.png`});
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
      await manager(page,engine).getByRole('button',{name:'返回地图',exact:true}).click();
    }
  });
}
