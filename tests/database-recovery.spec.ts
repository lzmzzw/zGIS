import { test, expect, type Browser, type Page } from "@playwright/test";
import type { DatabaseSource } from "../src/bridge";
import type { GeoFeature, SchemaChange } from "../src/domain";
import {
  installDesktopMock,
  loadDatabaseTestLayer,
  openDatabaseManager,
} from "./desktop.mock";

const source: DatabaseSource = {
  id: "original-source",
  name: "原数据库",
  host: "original.invalid",
  port: 5432,
  database: "test",
  user: "tester",
  sslMode: "prefer",
};
const otherSource: DatabaseSource = {
  ...source,
  id: "other-source",
  name: "同名表的其它数据库",
  host: "other.invalid",
};
const columns = [
  {
    name: "id",
    type: "bigint",
    nullable: false,
    generated: true,
    hasDefault: true,
  },
  { name: "name", type: "text", nullable: true },
  { name: "geom", type: "geometry", nullable: true },
];
const feature = (
  key: number,
  name: string,
  baseline = `baseline-${key}`,
): GeoFeature => ({
  id: `db-${key}`,
  geometry: { type: "Point", coordinates: [116 + key / 100, 40] },
  properties: { name },
  dbKey: [key],
  baseline,
});
const original = [feature(1, "original one"), feature(2, "original two")];
function snapshot(
  local = original,
  options: {
    dirty?: boolean;
    uncertain?: boolean;
    schemaChanges?: SchemaChange[];
  } = {},
) {
  return JSON.stringify({
    version: 2,
    layers: [
      {
        id: "database-layer",
        name: "public.roads",
        visible: true,
        color: "#5479b6",
        sourceKind: "postgis",
        crs: "EPSG:4326",
        dirty: options.dirty ?? false,
        features: local.map(({ id, geometry, properties }) => ({
          id,
          geometry,
          properties,
        })),
        db: {
          engine: "postgis",
          sourceId: source.id,
          schema: "public",
          table: "roads",
          geometryColumn: "geom",
          geometryKind: "geometry",
          srid: 4326,
          keyColumns: ["id"],
          columns,
        },
        dbBaseline: original,
        dbReadLimit: 10000,
        dbCommitUncertain: options.uncertain ?? false,
        schemaChanges: options.schemaChanges ?? [],
      },
    ],
    tree: [{ kind: "layer", id: "database-layer" }],
  });
}
async function setup(page: Page, raw: string, remote = original, error = "") {
  await installDesktopMock(page, raw, {
    databaseSources: [otherSource, source],
    passwords: { "postgis/original-source": "test-only-password" },
    features: remote,
    databaseConnectError: error,
  });
  await page.goto("/");
  await expect(
    page.locator('.tree-row[data-source-kind="database"]'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.calls.filter(
            (call) => call.command === "connect_database",
          ).length,
      ),
    )
    .toBe(1);
}
async function table(page: Page) {
  const expand = page.getByRole("button", { name: "展开属性表", exact: true });
  if (await expand.count()) await expand.click();
  return page.locator(".attribute-panel tbody");
}
async function editName(page: Page, value: string) {
  await table(page);
  await page.locator(".attribute-panel tbody tr").first().click();
  await page.locator('td[data-field="name"]').first().dblclick();
  await page.getByLabel("属性 name", { exact: true }).fill(value);
  await page.keyboard.press("Enter");
}
async function noFileSave(page: Page) {
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some((call) =>
        [
          "save_file",
          "save_shapefile_folder",
          "save_shapefile_source",
          "export_shapefile",
        ].includes(call.command),
      ),
    ),
  ).toBe(false);
  await expect(
    page.getByRole("dialog", { name: "保存图层", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.tree-row[data-source-kind="file"]')).toHaveCount(
    0,
  );
}
async function reopen(
  browser: Browser,
  raw: string,
  sources: DatabaseSource[],
  features: GeoFeature[],
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installDesktopMock(page, raw, {
    databaseSources: sources,
    features,
    passwords: Object.fromEntries(
      sources.map((item) => [`postgis/${item.id}`, "test-only-password"]),
    ),
  });
  await page.goto("http://127.0.0.1:1421");
  return { context, page };
}

test("数据库图层真实保存恢复副本后重启仍为数据库，自动连接原源并刷新原表", async ({
  page,
  browser,
}) => {
  await installDesktopMock(page);
  await page.goto("/");
  await loadDatabaseTestLayer(page);
  await page.getByRole("button", { name: "载入", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(window.__ZG_TEST__.snapshot?.includes("dbBaseline")),
      ),
    )
    .toBe(true);
  const saved = await page.evaluate(() => ({
    raw: window.__ZG_TEST__.snapshot!,
    sources: window.__ZG_TEST__.databaseSources,
    features: window.__ZG_TEST__.features,
  }));
  const raw = JSON.parse(saved.raw);
  expect(raw.layers[0].db).toMatchObject({
    engine: "postgis",
    sourceId: saved.sources[0].id,
    schema: "public",
    table: "roads",
  });
  expect(raw.layers[0].db).not.toHaveProperty("connectionId");
  expect(raw.layers[0].db).not.toHaveProperty("host");
  expect(raw.layers[0].db).not.toHaveProperty("password");
  expect(raw.layers[0].features[0]).not.toHaveProperty("dbKey");
  expect(raw.layers[0].features[0]).not.toHaveProperty("baseline");
  expect(raw.layers[0].dbBaseline[0]).toMatchObject({
    dbKey: [1],
    baseline: "baseline-1",
  });
  const remote = saved.features.map((item) => ({
    ...item,
    properties: { name: "remote latest" },
    baseline: "remote-latest-baseline",
  }));
  const restarted = await reopen(browser, saved.raw, saved.sources, remote);
  try {
    await expect(
      restarted.page.locator('.tree-row[data-source-kind="database"]'),
    ).toHaveCount(1);
    await expect(await table(restarted.page)).toContainText("remote latest");
    const calls = await restarted.page.evaluate(() => window.__ZG_TEST__.calls);
    expect(
      calls.filter((call) => call.command === "connect_database"),
    ).toHaveLength(1);
    expect(
      calls.find((call) => call.command === "load_database_source_password")!
        .args,
    ).toEqual({ engine: "postgis", sourceId: saved.sources[0].id });
    expect(
      calls.find((call) => call.command === "query_layer")!.args,
    ).toMatchObject({
      schema: "public",
      table: "roads",
      geometryColumn: "geom",
    });
    await noFileSave(restarted.page);
  } finally {
    await restarted.context.close();
  }
});

test("重启恢复本地编辑，合并其它远端记录变化，原基线提交只包含本地变化", async ({
  page,
}) => {
  await setup(
    page,
    snapshot([feature(1, "local edit"), original[1]], { dirty: true }),
    [original[0], feature(2, "remote updated two", "remote-baseline-2")],
  );
  const body = await table(page);
  await expect(body).toContainText("local edit");
  await expect(body).toContainText("remote updated two");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("button", { name: "保存编辑", exact: true }),
  ).toBeDisabled();
  const calls = await page.evaluate(() => window.__ZG_TEST__.calls);
  const commit = calls.find((call) => call.command === "commit_changes")!;
  expect(commit.args.changes).toEqual([
    expect.objectContaining({
      kind: "update",
      dbKey: [1],
      baseline: "baseline-1",
      properties: { name: "local edit" },
    }),
  ]);
  expect(
    calls.filter((call) => call.command === "query_layer").length,
  ).toBeGreaterThanOrEqual(2);
  const connection = calls.find((call) => call.command === "connect_database")!;
  expect((connection.args.config as { host: string }).host).toBe(
    "original.invalid",
  );
  expect(
    calls.filter((call) => call.command === "connect_database"),
  ).toHaveLength(1);
  await noFileSave(page);
});

test("相同记录同时被本地和远端修改，恢复保留本地编辑且拒绝提交", async ({
  page,
}) => {
  await setup(
    page,
    snapshot([feature(1, "local edit"), original[1]], { dirty: true }),
    [feature(1, "remote conflicting edit", "remote-baseline-1"), original[1]],
  );
  await expect(await table(page)).toContainText("local edit");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText(/冲突|变化|核对/);
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) => call.command === "commit_changes",
      ),
    ),
  ).toBe(false);
  await expect(
    page.getByRole("button", { name: "退出编辑", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".layer-text")).toContainText("*");
  await noFileSave(page);
});

test("逐条同步冲突选择数据库版本，采用远端内容且无待提交修改", async ({
  page,
}) => {
  const remote = [
    feature(1, "remote selected", "remote-baseline-selected"),
    original[1],
  ];
  await setup(
    page,
    snapshot([feature(1, "local conflicting"), original[1]], { dirty: true }),
    remote,
  );
  await expect(await table(page)).toContainText("local conflicting");
  await page.getByRole("button", { name: "处理同步冲突", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "数据库同步冲突",
    exact: true,
  });
  await expect(dialog).toContainText("local conflicting");
  await expect(dialog).toContainText("remote selected");
  await page.screenshot({
    path: "output/database-recovery/conflict-version-choice.png",
  });
  await expect(
    dialog.getByRole("button", { name: "同步所选版本", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("冲突版本 1", { exact: true }).selectOption("remote");
  await dialog
    .getByRole("button", { name: "同步所选版本", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".attribute-panel tbody")).toContainText(
    "remote selected",
  );
  await expect(page.locator(".attribute-panel tbody")).not.toContainText(
    "local conflicting",
  );
  await expect(page.locator(".layer-text")).not.toContainText("*");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存编辑", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) => call.command === "commit_changes",
      ),
    ),
  ).toBe(false);
  await noFileSave(page);
});

test("逐条同步冲突分别选本地和数据库版本，同步仅提交保留的本地变化", async ({
  page,
}) => {
  const remote = [
    feature(
      1,
      "remote original for resolution",
      "remote-baseline-for-resolution",
    ),
    feature(2, "remote selected two", "remote-selected-baseline-two"),
  ];
  await setup(
    page,
    snapshot(
      [feature(1, "local selected"), feature(2, "local discarded two")],
      { dirty: true },
    ),
    remote,
  );
  await page.getByRole("button", { name: "处理同步冲突", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "数据库同步冲突",
    exact: true,
  });
  await dialog.getByLabel("冲突版本 1", { exact: true }).selectOption("local");
  await expect(
    dialog.getByRole("button", { name: "同步所选版本", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("冲突版本 2", { exact: true }).selectOption("remote");
  await dialog
    .getByRole("button", { name: "同步所选版本", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(await table(page)).toContainText("local selected");
  await expect(page.locator(".attribute-panel tbody")).toContainText(
    "remote selected two",
  );
  await expect(page.locator(".attribute-panel tbody")).not.toContainText(
    "local discarded two",
  );
  await expect(page.locator(".layer-text")).not.toContainText("*");
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "commit_changes",
        ).length,
    ),
  ).toBe(1);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存编辑", exact: true }),
  ).toBeDisabled();
  const commit = await page.evaluate(() =>
    window.__ZG_TEST__.calls.find((call) => call.command === "commit_changes"),
  );
  expect(commit!.args.changes).toEqual([
    expect.objectContaining({
      kind: "update",
      dbKey: [1],
      baseline: "remote-baseline-for-resolution",
      properties: { name: "local selected" },
    }),
  ]);
  await noFileSave(page);
});

test("选择冲突版本后远端再次变化，刷新冲突并要求重新选择", async ({ page }) => {
  await setup(
    page,
    snapshot([feature(1, "local unchanged choice"), original[1]], {
      dirty: true,
    }),
    [feature(1, "remote before choice", "remote-before-choice"), original[1]],
  );
  await page.getByRole("button", { name: "处理同步冲突", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "数据库同步冲突",
    exact: true,
  });
  await dialog.getByLabel("冲突版本 1", { exact: true }).selectOption("local");
  await page.evaluate(
    (remote) => {
      window.__ZG_TEST__.features = remote;
    },
    [
      feature(1, "remote changed while choosing", "remote-newer-choice"),
      original[1],
    ],
  );
  await dialog
    .getByRole("button", { name: "同步所选版本", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("remote changed while choosing");
  await expect(dialog.getByLabel("冲突版本 1", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    dialog.getByRole("button", { name: "同步所选版本", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) => call.command === "commit_changes",
      ),
    ),
  ).toBe(false);
  await dialog.getByLabel("冲突版本 1", { exact: true }).selectOption("remote");
  await dialog
    .getByRole("button", { name: "同步所选版本", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(await table(page)).toContainText(
    "remote changed while choosing",
  );
  await noFileSave(page);
});

test("自动连接失败保留数据库来源与本地编辑，保存时重试原源并提交", async ({
  page,
}) => {
  await setup(
    page,
    snapshot([feature(1, "local retry edit"), original[1]], { dirty: true }),
    original,
    "test connection offline",
  );
  await expect(page.getByRole("alert")).toContainText(/失败.*重连/);
  await expect(await table(page)).toContainText("local retry edit");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.evaluate(() => {
    window.__ZG_TEST__.databaseConnectError = "";
  });
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("button", { name: "保存编辑", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "connect_database",
        ).length,
    ),
  ).toBe(2);
  expect(
    await page.evaluate(
      () =>
        window.__ZG_TEST__.calls.filter(
          (call) => call.command === "commit_changes",
        ).length,
    ),
  ).toBe(1);
  await noFileSave(page);
});

test("重连后编辑期间发生远端修改，保存前重新核对并拒绝覆盖", async ({
  page,
}) => {
  await setup(page, snapshot());
  await expect(await table(page)).toContainText("original one");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await editName(page, "local new edit");
  await page.evaluate(
    (remote) => {
      window.__ZG_TEST__.features = remote;
    },
    [feature(1, "remote new edit", "remote-new-baseline"), original[1]],
  );
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText(/冲突|变化|核对/);
  await expect(page.locator(".attribute-panel tbody")).toContainText(
    "local new edit",
  );
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) => call.command === "commit_changes",
      ),
    ),
  ).toBe(false);
  await noFileSave(page);
});

test("Mysql 恢复按原源自动连接、刷新和提交，不调用 PostGIS 或文件保存", async ({
  page,
}) => {
  const raw = JSON.parse(
    snapshot([feature(1, "mysql local edit"), original[1]], { dirty: true }),
  );
  raw.layers[0].sourceKind = "mysql";
  raw.layers[0].db.engine = "mysql";
  raw.layers[0].db.schema = "test";
  await installDesktopMock(page, JSON.stringify(raw), {
    mysqlSources: [otherSource, source],
    passwords: { "mysql/original-source": "test-only-password" },
    features: original,
  });
  await page.goto("/");
  await expect(
    page.locator('.tree-row[data-source-kind="database"]'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.calls.filter(
            (call) => call.command === "query_mysql_geometry",
          ).length,
      ),
    )
    .toBe(1);
  await expect(await table(page)).toContainText("mysql local edit");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("button", { name: "保存编辑", exact: true }),
  ).toBeDisabled();
  const calls = await page.evaluate(() => window.__ZG_TEST__.calls);
  expect(
    calls.filter((call) => call.command === "connect_mysql_database"),
  ).toHaveLength(1);
  expect(
    calls.find((call) => call.command === "load_database_source_password")!
      .args,
  ).toEqual({ engine: "mysql", sourceId: "original-source" });
  expect(
    calls.find((call) => call.command === "commit_mysql_changes")!.args.changes,
  ).toEqual([
    expect.objectContaining({
      kind: "update",
      dbKey: [1],
      baseline: "baseline-1",
      properties: { name: "mysql local edit" },
    }),
  ]);
  expect(
    calls.some((call) =>
      ["connect_database", "query_layer", "commit_changes"].includes(
        call.command,
      ),
    ),
  ).toBe(false);
  await noFileSave(page);
});

test("原源不存在时保留数据库和草稿，不连接列表中其它源", async ({ page }) => {
  await installDesktopMock(
    page,
    snapshot([feature(1, "missing source local"), original[1]], {
      dirty: true,
    }),
    { databaseSources: [otherSource], features: original },
  );
  await page.goto("/");
  await expect(
    page.locator('.tree-row[data-source-kind="database"]'),
  ).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("原数据源不存在");
  await expect(await table(page)).toContainText("missing source local");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("原数据源不存在");
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some((call) =>
        ["connect_database", "commit_changes"].includes(call.command),
      ),
    ),
  ).toBe(false);
  await noFileSave(page);
});

test("共享原源的一个表刷新失败，不断开其它图层的连接与刷新", async ({
  page,
}) => {
  const raw = JSON.parse(snapshot());
  const missing = structuredClone(raw.layers[0]);
  missing.id = "missing-table-layer";
  missing.name = "public.missing_table";
  missing.db.table = "missing_table";
  raw.layers.unshift(missing);
  raw.tree.unshift({ kind: "layer", id: missing.id });
  const remote = [
    feature(1, "shared connection remote one", "shared-remote-one"),
    original[1],
  ];
  await installDesktopMock(page, JSON.stringify(raw), {
    databaseSources: [source],
    passwords: { "postgis/original-source": "test-only-password" },
    features: remote,
  });
  await page.goto("/");
  await expect(
    page.locator('.tree-row[data-source-kind="database"]'),
  ).toHaveCount(2);
  await expect(page.getByRole("alert")).toContainText("原表不存在");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__ZG_TEST__.calls.filter(
            (call) => call.command === "query_layer",
          ).length,
      ),
    )
    .toBe(1);
  await page
    .locator(".layer-text")
    .filter({ hasText: /^public.roads$/ })
    .click();
  await expect(await table(page)).toContainText("shared connection remote one");
  const calls = await page.evaluate(() => window.__ZG_TEST__.calls);
  expect(
    calls.filter((call) => call.command === "connect_database"),
  ).toHaveLength(1);
  expect(calls.some((call) => call.command === "disconnect_database")).toBe(
    false,
  );
  await noFileSave(page);
});

test("恢复正在编辑的数据库会话刷新后不保存退出，保留远端最新记录", async ({
  page,
}) => {
  const raw = JSON.parse(
    snapshot([feature(1, "discard local edit"), original[1]], { dirty: true }),
  );
  raw.version = 3;
  raw.session = {
    layerId: "database-layer",
    tool: "select",
    snapping: true,
    history: {
      undo: [original],
      redo: [],
      baseline: { features: original, dirty: false },
    },
  };
  await setup(page, JSON.stringify(raw), [
    original[0],
    feature(2, "remote updated during restart", "remote-restart-two"),
  ]);
  await expect(await table(page)).toContainText("discard local edit");
  await expect(page.locator(".attribute-panel tbody")).toContainText(
    "remote updated during restart",
  );
  await page.getByRole("button", { name: "退出编辑", exact: true }).click();
  await page
    .getByRole("dialog", { name: "退出编辑", exact: true })
    .getByRole("button", { name: "不保存退出", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "编辑", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".attribute-panel tbody")).toContainText(
    "original one",
  );
  await expect(page.locator(".attribute-panel tbody")).toContainText(
    "remote updated during restart",
  );
  await expect(page.locator(".attribute-panel tbody")).not.toContainText(
    "discard local edit",
  );
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) => call.command === "commit_changes",
      ),
    ),
  ).toBe(false);
  await noFileSave(page);
});

test("恢复图层依旧引用原源 ID，连接失败时数据源管理也不能删除原源", async ({
  page,
}) => {
  await setup(page, snapshot(), original, "test connection offline");
  await expect(page.getByRole("alert")).toContainText("重连");
  await openDatabaseManager(page);
  const manager = page.getByRole("region", {
    name: "PostGIS 数据源管理",
    exact: true,
  });
  await manager.locator(".pg-source").filter({ hasText: "原数据库" }).click();
  await manager
    .getByRole("button", { name: "删除数据源", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "删除数据源", exact: true });
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "请先移除引用此数据源的图层",
  );
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.databaseSources.map((item) => item.id),
    ),
  ).toContain("original-source");
  expect(
    await page.evaluate(() =>
      window.__ZG_TEST__.calls.some(
        (call) =>
          call.command === "save_database_sources" ||
          call.command === "delete_database_source_password",
      ),
    ),
  ).toBe(false);
});

test("恢复字段修改经原表核验后提交，提交结果不确定状态跨重启禁止重复提交", async ({
  page,
  browser,
}) => {
  const local = original.map((item) => ({
    ...item,
    properties: { ...item.properties, extra: "" },
  }));
  await setup(
    page,
    snapshot(local, {
      dirty: true,
      schemaChanges: [{ kind: "add", name: "extra" }],
    }),
  );
  await table(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.evaluate(() => {
    window.__ZG_TEST__.commitError = "字段结构已提交，记录结果待核对";
  });
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("alert")).toContainText("结果待核对");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          window.__ZG_TEST__.snapshot &&
          JSON.parse(window.__ZG_TEST__.snapshot).layers[0].dbCommitUncertain,
        ),
      ),
    )
    .toBe(true);
  const commit = await page.evaluate(() =>
    window.__ZG_TEST__.calls.find((call) => call.command === "commit_changes"),
  );
  expect(commit!.args.schemaChanges).toEqual([{ kind: "add", name: "extra" }]);
  const raw = await page.evaluate(() => window.__ZG_TEST__.snapshot!);
  const restarted = await reopen(browser, raw, [source], original);
  try {
    await expect(
      restarted.page.locator('.tree-row[data-source-kind="database"]'),
    ).toHaveCount(1);
    await expect(
      restarted.page.getByRole("button", { name: "保存编辑", exact: true }),
    ).toBeDisabled();
    await restarted.page.keyboard.press("Control+s");
    expect(
      await restarted.page.evaluate(() =>
        window.__ZG_TEST__.calls.some(
          (call) => call.command === "commit_changes",
        ),
      ),
    ).toBe(false);
    await noFileSave(restarted.page);
  } finally {
    await restarted.context.close();
  }
});
