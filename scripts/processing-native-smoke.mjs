// Isolated native analysis verification; never connects to the user's MCP or recovery.
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const executable = resolve(
  process.argv[2] ?? "src-tauri/target/release/zgis.exe",
);
const output = resolve(process.argv[3] ?? "output/processing-native");
const runName = String(Date.now());
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, "report.json"),
  JSON.stringify({ success: false, runName, executable }),
);
const child = spawn(executable, [], {
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9228",
    WEBVIEW2_USER_DATA_FOLDER: resolve(output, `webview-${runName}`),
  },
});
let browser;
const errors = [];
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
      break;
    } catch (reason) {
      if (attempt === 59) throw reason;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".app");
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"),
    ),
    "com.personal.zgis.processing-smoke",
    "Refuse production identity",
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(async () => {
    localStorage.removeItem("zgis.editRecovery");
    await window.__TAURI_INTERNALS__.invoke("save_recovery", {
      content: JSON.stringify({ version: 3, layers: [], tree: [] }),
    });
  });
  await page.reload();
  const ipcChecks = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("gis_workspace_sync", { layers: [], activeLayerId: null });
    await invoke("gis_workspace_sync", {
      layers: [], activeLayerId: null, incremental: true, removedLayerIds: [],
    });
    await invoke("gis_results_ack", { resultIds: ["native-unknown-result"] });
    const jobId = `native-cancel-${Date.now()}`;
    const accepted = await invoke("gis_cancel_analysis", { jobId });
    let cancelled = "";
    try {
      await invoke("gis_run_analysis", {
        operation: "centroid", parameters: {}, jobId,
        source: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [116, 40] } }],
      });
    } catch (error) { cancelled = String(error); }
    return { accepted, cancelled };
  });
  assert.equal(ipcChecks.accepted, true);
  assert.match(ipcChecks.cancelled, /取消|CANCELLED/);
  const expansionIpc = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const point = (id, value) => ({ type: "Feature", id, properties: { group: "A", value }, geometry: { type: "Point", coordinates: [116, 40, 18] } });
    const source = [point("number", 2), point("text", "2")];
    const run = (operation, parameters, source, target) => invoke("gis_run_analysis", { operation, parameters, source, ...(target ? { target } : {}) });
    const clean = await run("clean_geometries", {}, [source[0], { ...source[1], geometry: null }]);
    const filtered = await run("extract_by_attribute", { condition: { field: "value", op: "eq", value: 2 } }, source);
    const statistics = await run("field_statistics", { groupBy: "group", metrics: [
      { name: "records", op: "count_all" }, { name: "total", op: "sum", field: "value" }, { name: "average", op: "mean", field: "value" },
    ] }, [point("a", 2), point("b", 4), point("c", null)]);
    const joinSource = [
      { ...point("source", 0), properties: { total: 99 } },
      { ...point("unmatched", 0), properties: { total_: 88 }, geometry: { type: "Point", coordinates: [117, 40, 23] } },
    ];
    const joinTarget = [point("a", 2), point("b", 4), {
      ...point("multi", 6), geometry: { type: "MultiPoint", coordinates: [[116, 40, 8], [116, 40, 9]] },
    }];
    const joined = await run("spatial_join", { predicate: "intersects", aggregations: [
      { name: "records", op: "count_all" }, { name: "total", op: "sum", field: "value" },
    ] }, joinSource, joinTarget);
    const legacyJoined = await run("spatial_join", { predicate: "intersects" }, joinSource, joinTarget);
    return { clean, filtered, statistics, joined, legacyJoined };
  });
  assert.equal(expansionIpc.clean.features.length, 1);
  assert.equal(expansionIpc.clean.analysis.removedCount, 1);
  assert.equal(expansionIpc.filtered.features.length, 1);
  assert.equal(expansionIpc.filtered.features[0].id, "number");
  assert.deepEqual(expansionIpc.filtered.features[0].geometry.coordinates, [116, 40, 18]);
  assert.equal(expansionIpc.statistics.type, "table");
  assert.equal(expansionIpc.statistics.inputCount, 3);
  assert.equal(expansionIpc.statistics.groupCount, 1);
  assert.deepEqual(expansionIpc.statistics.rows[0].group, { type: "string", value: "A" });
  assert.deepEqual(expansionIpc.statistics.rows[0].values, { records: 3, total: 6, average: 3 });
  assert.deepEqual(expansionIpc.statistics.rows[0].counts.total, { validCount: 2, nullCount: 1, missingCount: 0 });
  assert.equal(expansionIpc.joined.analysis.aggregationFields.total, "total__");
  assert.equal(expansionIpc.joined.features[0].properties.records, 3);
  assert.equal(expansionIpc.joined.features[0].properties.total__, 12);
  assert.equal(expansionIpc.joined.features[0].properties.total, 99);
  assert.equal(expansionIpc.joined.features[1].properties.records, 0);
  assert.equal(expansionIpc.joined.features[1].properties.total__, null);
  assert.deepEqual(expansionIpc.joined.features[1].geometry.coordinates, [117, 40, 23]);
  assert.equal(expansionIpc.legacyJoined.features[0].properties.records, undefined);
  assert.equal(expansionIpc.legacyJoined.features[0].properties.total__, undefined);
  const square = (x) => ({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x, 40, 10],
          [x + 0.01, 40, 20],
          [x + 0.01, 40.01, 30],
          [x, 40.01, 40],
          [x, 40, 10],
        ],
      ],
    },
    properties: { name: `square-${x}`, group: "甲" },
  });
  await page.locator("input[type=file]").setInputFiles([
    {
      name: "native-a.geojson",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ type: "FeatureCollection", features: [square(116)] }),
      ),
    },
    {
      name: "native-b.geojson",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          type: "FeatureCollection",
          features: [square(116.005)],
        }),
      ),
    },
  ]);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".layer-text")).toHaveCount(2);
  const catalog = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("gis_mcp_tool_catalog"),
  );
  assert.equal(catalog.length, 33);
  for (const name of ["list_results", "release_result", "clean_geometries", "extract_by_attribute", "field_statistics"]) {
    assert.ok(catalog.some(tool => tool.name === name), `Missing ${name}`);
  }
  assert.ok(catalog.some((tool) => tool.name === "intersection"));
  await page.getByRole("button", { name: "工具", exact: true }).click();
  const checkDock = async () => {
    const side = await page.locator(".right-sidebar").boundingBox();
    for (const selector of [
      ".map-column",
      ".map-surface",
      ".attribute-panel",
    ]) {
      const content = await page.locator(selector).boundingBox();
      assert.ok(
        content.x + content.width <= side.x + 1,
        `${selector} covered by dock`,
      );
    }
  };
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  const toolboxResize = page.getByRole("separator", {
    name: "调整工具侧栏宽度",
  });
  await toolboxResize.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await expect(toolboxResize).toHaveAttribute("aria-valuenow", "340");
  await checkDock();
  await page.getByRole("button", { name: "Codex Agent", exact: true }).click();
  const agentResize = page.getByRole("separator", {
    name: "调整Agent侧栏宽度",
  });
  const agentBox = await agentResize.boundingBox();
  await page.mouse.move(agentBox.x + 2, agentBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(agentBox.x - 48, agentBox.y + 100);
  await page.mouse.up();
  await checkDock();
  const agentWidth = await agentResize.getAttribute("aria-valuenow");
  await page.screenshot({ path: resolve(output, "agent-dock-native.png") });
  await page.getByRole("button", { name: "隐藏助手侧栏" }).click();
  await page.getByRole("button", { name: "Codex Agent", exact: true }).click();
  await expect(agentResize).toHaveAttribute("aria-valuenow", agentWidth);
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await expect(toolboxResize).toHaveAttribute("aria-valuenow", agentWidth);
  await checkDock();
  const toolbox = page.locator(".processing-toolbox");
  const selectTool = async (name) => {
    const option = toolbox
      .locator(".processing-tool-option")
      .getByText(name, { exact: true });
    if (!(await option.isVisible()))
      await option
        .locator(
          'xpath=ancestor::div[contains(@class,"processing-tool-group")]',
        )
        .locator(".processing-group-toggle")
        .click();
    if ((await option.locator("..").getAttribute("aria-pressed")) !== "true")
      await option.click();
  };
  await expect(toolbox.locator(".processing-form")).toHaveCount(0);
  await expect(toolbox.locator(".processing-help")).toHaveCount(0);
  assert.ok(
    Math.abs(
      (await toolbox.locator(".processing-browser").boundingBox()).height -
        288,
    ) < 0.1,
  );
  await selectTool("缓冲区");
  await toolbox.getByLabel("缓冲距离（米）").fill("125");
  await toolbox.getByRole("button", { name: "缓冲区", exact: true }).click();
  await expect(toolbox.locator(".processing-form")).toHaveCount(0);
  await expect(toolbox.locator(".processing-help")).toHaveCount(0);
  await selectTool("缓冲区");
  await expect(toolbox.getByLabel("缓冲距离（米）")).toHaveValue("125");
  assert.ok(
    Math.abs(
      (await toolbox.locator(".processing-browser").boundingBox()).height -
        288,
    ) < 0.1,
  );
  const snapshot = () =>
    page.evaluate(async () =>
      JSON.parse(await window.__TAURI_INTERNALS__.invoke("load_recovery")),
    );
  async function analyze(tool, name) {
    await selectTool(tool);
    await toolbox.getByLabel("结果图层名称").fill(name);
    await toolbox
      .getByRole("button", { name: "运行分析", exact: true })
      .click();
    await expect(toolbox.getByRole("status")).toContainText("分析完成");
    await expect
      .poll(async () =>
        (await snapshot()).layers.some((layer) => layer.displayName === name),
      )
      .toBe(true);
    return (await snapshot()).layers.find(
      (layer) => layer.displayName === name,
    );
  }
  await selectTool("相交");
  await toolbox
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "native-a.geojson" });
  await toolbox
    .getByLabel("目标图层", { exact: true })
    .selectOption({ label: "native-b.geojson" });
  const intersection = await analyze("相交", "native-intersection");
  assert.equal(intersection.features.length, 1);
  assert.equal(intersection.features[0].geometry.type, "MultiPolygon");
  assert.equal(intersection.features[0].properties.name, "square-116");
  assert.equal(
    intersection.features[0].properties.target_name,
    "square-116.005",
  );
  const overlayVertices = intersection.features[0].geometry.coordinates.flat(2);
  assert.ok(overlayVertices.every((c) => c.length === 3));
  assert.ok(
    overlayVertices.some(
      (c) =>
        Math.abs(c[0] - 116.01) < 1e-10 &&
        Math.abs(c[1] - 40) < 1e-10 &&
        c[2] === 20,
    ),
  );
  assert.ok(overlayVertices.some((c) => c[2] === 0));
  const xs = intersection.features[0].geometry.coordinates
    .flat(2)
    .map((coordinate) => coordinate[0]);
  assert.ok(Math.abs(Math.min(...xs) - 116.005) < 1e-10);
  assert.ok(Math.abs(Math.max(...xs) - 116.01) < 1e-10);
  const centroid = await analyze("质心", "native-centroid");
  assert.equal(centroid.features[0].geometry.type, "Point");
  assert.equal(centroid.features[0].geometry.coordinates[2], 0);
  assert.ok(
    Math.abs(centroid.features[0].geometry.coordinates[0] - 116.0075) < 1e-8,
  );
  await selectTool("缓冲区");
  await toolbox
    .getByLabel("输入图层", { exact: true })
    .selectOption({ label: "native-centroid" });
  await toolbox.getByLabel("缓冲距离（米）").fill("100");
  const buffer = await analyze("缓冲区", "native-buffer");
  assert.equal(buffer.features[0].geometry.type, "MultiPolygon");
  assert.ok(
    buffer.features[0].geometry.coordinates
      .flat(2)
      .every((c) => c.length === 3 && c[2] === 0),
  );
  const measured = await analyze("添加几何属性", "native-area");
  assert.ok(
    Math.abs(measured.features[0].properties._zgis_area_m2 - Math.PI * 10000) <
      500,
  );
  await selectTool("拓扑检查");
  await toolbox.getByRole("button", { name: "运行分析", exact: true }).click();
  await expect(toolbox.getByLabel("分析结果")).toContainText("未发现");
  await selectTool("剔除空或无效几何");
  await toolbox.getByLabel("输入图层", { exact: true }).selectOption({ label: "native-a.geojson" });
  const cleaned = await analyze("剔除空或无效几何", "native-clean");
  assert.equal(cleaned.features.length, 1);
  assert.deepEqual(cleaned.features[0].geometry, square(116).geometry);
  await selectTool("按属性条件提取");
  await toolbox.getByLabel("输入图层", { exact: true }).selectOption({ label: "native-a.geojson" });
  await toolbox.getByLabel("条件字段", { exact: true }).selectOption("group");
  await toolbox.getByLabel("比较值", { exact: true }).fill("甲");
  const extracted = await analyze("按属性条件提取", "native-filtered");
  assert.deepEqual(extracted.features[0].geometry, square(116).geometry);
  assert.equal(extracted.features[0].properties.group, "甲");

  // 真实桌面样式弹窗；颜色/标注只进入恢复配置，不修改原始业务属性。
  await page.getByRole("button", { name: "native-a.geojson样式", exact: true }).click();
  const styleDialog = page.getByRole("dialog", { name: "图层样式：native-a.geojson", exact: true });
  await styleDialog.getByLabel("着色方式", { exact: true }).selectOption("unique");
  await styleDialog.getByLabel("分类字段", { exact: true }).selectOption("group");
  await styleDialog.getByLabel("类别 1 颜色", { exact: true }).fill("#c95842");
  await styleDialog.getByLabel("显示标注", { exact: true }).check();
  await styleDialog.getByLabel("标注字段", { exact: true }).selectOption("name");
  await styleDialog.getByLabel("标注字号", { exact: true }).fill("18");
  await styleDialog.getByLabel("标注描边宽度", { exact: true }).fill("4");
  await page.screenshot({ path: resolve(output, "layer-display-dialog-native.png") });
  await styleDialog.getByRole("button", { name: "应用样式", exact: true }).click();
  await expect.poll(async () => (await snapshot()).layers.find(layer => layer.name === "native-a.geojson")?.labels?.fontSize).toBe(18);
  const display = (await snapshot()).layers.find(layer => layer.name === "native-a.geojson");
  assert.equal(display.categorizedStyle.field, "group");
  assert.equal(display.categorizedStyle.categories[0].color, "#c95842");
  assert.equal(display.labels.field, "name");
  assert.equal(display.labels.haloWidth, 4);
  await page.screenshot({ path: resolve(output, "layer-display-native.png") });

  await page.locator("input[type=file]").setInputFiles({
    name: "native-duplicates.geojson", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ type: "FeatureCollection", features: [square(116), square(116)] })),
  });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await selectTool("拓扑检查");
  await toolbox.getByLabel("输入图层", { exact: true }).selectOption({ label: "native-duplicates.geojson" });
  await toolbox.getByRole("button", { name: "运行分析", exact: true }).click();
  await toolbox.getByRole("button", { name: "定位问题", exact: true }).first().click();
  await expect(page.locator('.attribute-panel tr[aria-selected="true"]')).toHaveCount(1);
  await page.screenshot({ path: resolve(output, "topology-location-native.png") });
  const content = await snapshot();
  assert.deepEqual(
    content.layers.find((layer) => layer.name === "native-a.geojson")
      .features[0].geometry,
    square(116).geometry,
  );
  assert.equal(content.layers.length, 9);
  await page.reload();
  await expect(page.locator(".layer-text")).toHaveCount(9);
  const restoredDisplay = (await snapshot()).layers.find(layer => layer.name === "native-a.geojson");
  assert.deepEqual(restoredDisplay.categorizedStyle, display.categorizedStyle);
  assert.deepEqual(restoredDisplay.labels, display.labels);
  await page.getByRole("button", { name: "native-a.geojson样式", exact: true }).click();
  await expect(page.getByLabel("分类字段", { exact: true })).toHaveValue("group");
  await expect(page.getByLabel("显示标注", { exact: true })).toBeChecked();
  await expect(page.getByLabel("标注字号", { exact: true })).toHaveValue("18");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.deepEqual(
    (await snapshot()).layers.find(
      (layer) => layer.displayName === "native-intersection",
    ).features,
    intersection.features,
  );
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await selectTool("质心");
  await page.screenshot({ path: resolve(output, "toolbox-native.png") });
  assert.deepEqual(errors, []);
  const closed = page.waitForEvent("close");
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await closed;
  writeFileSync(
    resolve(output, "report.json"),
    JSON.stringify(
      {
        success: true,
        runName,
        executable,
        identifier: "com.personal.zgis.processing-smoke",
        checks: [
          "native full/delta workspace sync, idempotent result ack and pre-start analysis cancellation",
          "native toolbox intersection and both-side attributes",
          "centroid-buffer-measure chain",
          "topology report",
          "source preservation",
          "33 tool native catalog including cache lifecycle, cleaning, attribute extraction and field statistics",
          "native IPC cleaning count, strict typed extraction, XYZ and grouped statistics",
          "optional spatial aggregation, globally collision-safe fields, MultiPoint counted once, unmatched null and legacy default",
          "native toolbox cleaning and attribute extraction preserve source geometry",
          "real desktop categorized style and label dialog with persisted configuration after reload",
          "topology issue locate selects a source row",
          "normal snapshot exit",
          "XYZ overlay preserves source vertex Z and fills unknown Z with zero",
          "XYZ centroid-buffer chain and recovery snapshot",
          "fixed tree and tool deselection hide configuration and help, retain drafts",
          "docked agent and toolbox do not cover map or attribute table",
          "shared sidebar width, native pointer drag and keyboard resize",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: native processing toolbox, real geometry overlay and chained analysis, source preservation",
  );
} finally {
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const cleanup = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      cleanup.on("exit", resolve);
      cleanup.on("error", resolve);
    });
  }
  await browser?.close().catch(() => {});
}
