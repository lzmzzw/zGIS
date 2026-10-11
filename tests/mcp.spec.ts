import { test, expect } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";
import { CITY_TEST_FILENAME, importCityFixture } from "./data-fixtures";

test("MCP controls, snapshot isolation and generated layers keep source intact", async ({ page }) => {
  await installDesktopMock(page);
  await page.goto("/");
  await importCityFixture(page);
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_workspace_sync").at(-1)?.args.layers)).toHaveLength(1);
  const snapshot = await page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_workspace_sync").at(-1)?.args);
  const source = (snapshot!.layers as { id: string; name: string; features: unknown[] }[])[0];
  expect(source.name).toBe(CITY_TEST_FILENAME);
  expect(source.features).toHaveLength(4);
  expect(JSON.stringify(snapshot)).not.toContain("connectionId");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: "启用 MCP", exact: true }).click();
  await expect(page.getByLabel("MCP 访问令牌")).toHaveAttribute("type", "password");
  await expect(page.getByRole("main", {name:"后台设置"})).toContainText("http://127.0.0.1:9999/mcp");
  await expect(page.getByRole("button", { name: "选择可读文件…", exact: true })).toHaveCount(0);
  await page.getByText("连接配置", {exact:true}).click();
  await expect(page.locator(".settings-disclosure[open] .settings-disclosure-content")).toContainText("Agent 负责授权");
  await page.getByRole("button", { name: "返回地图", exact: true }).click();
  await page.evaluate(() => window.__ZG_TEST__.analysisResults.push({ id: "result-1", name: "空间筛选结果", features: [{ type: "Feature", id: "selected", geometry: { type: "Point", coordinates: [116, 40] }, properties: { name: "结果" } }] }));
  await expect(page.locator(".layer-row")).toHaveCount(2);
  await expect(page.locator(".layer-text").filter({ hasText: "空间筛选结果" })).toContainText("*");
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.mcpLayers)).toHaveLength(2);
  const final = await page.evaluate(() => window.__ZG_TEST__.mcpLayers);
  expect(final[0].features).toEqual(source.features);
  await page.getByRole("button", { name: "Codex Agent", exact: true }).click();
  await expect(page.getByLabel("Codex 空间分析助手")).toBeVisible();
  await page.getByTitle("隐藏侧栏，保留会话").click();
  await expect(page.getByLabel("Codex 空间分析助手")).toHaveCount(0);
});


test("publication retries failed backup without duplicate layers and acks only durable snapshots", async ({ page }) => {
  await installDesktopMock(page);
  await page.goto("/");
  await page.evaluate(() => {
    window.__ZG_TEST__.backupError = "disk full";
    window.__ZG_TEST__.analysisResults.push({ id: "retry-result", name: "重试结果", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [116, 40, 9] }, properties: {} }] });
  });
  await expect(page.locator(".layer-row")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_results_drain").length)).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_results_ack").length)).toBe(0);
  await page.evaluate(() => { window.__ZG_TEST__.backupError = ""; });
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.analysisResults.length)).toBe(0);
  await expect(page.locator(".layer-row")).toHaveCount(1);
  const snapshot = await page.evaluate(() => window.__ZG_TEST__.snapshot);
  expect(JSON.parse(snapshot!).layers[0].id).toBe("mcp-publication-retry-result");
});

test("a restored publication is acknowledged again without adding another layer", async ({ page }) => {
  const feature = { id: "restored-feature", geometry: { type: "Point", coordinates: [116, 40, 9] }, properties: {} };
  await installDesktopMock(page, JSON.stringify({ version: 3, layers: [{ id: "mcp-publication-replayed", name: "已恢复结果", features: [feature], dirty: true }], tree: [{ kind: "layer", id: "mcp-publication-replayed" }] }));
  await page.goto("/");
  await expect(page.locator(".layer-row")).toHaveCount(1);
  await page.evaluate(feature => { window.__ZG_TEST__.analysisResults.push({ id: "replayed", name: "已恢复结果", features: [{ ...feature, type: "Feature" }] }); }, feature);
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_results_ack").length)).toBe(1);
  await expect(page.locator(".layer-row")).toHaveCount(1);
});

test("active layer changes send empty deltas and failed content synchronization retries", async ({ page }) => {
  const layers = ["甲", "乙"].map((name, index) => ({ id: `layer-${index}`, name, features: [{ id: `f-${index}`, geometry: { type: "Point", coordinates: [116 + index, 40] }, properties: { name } }] }));
  await installDesktopMock(page, JSON.stringify({ version: 3, layers, tree: layers.map(layer => ({ kind: "layer", id: layer.id })) }));
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.mcpLayers.length)).toBe(2);
  await page.locator(".layer-text").filter({ hasText: "乙" }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window.__ZG_TEST__;
    return state.mcpLayers.find(layer => layer.id === state.mcpActiveLayerId)?.name;
  })).toBe("乙");
  const activeDelta = await page.evaluate(() => window.__ZG_TEST__.calls.filter(call => call.command === "gis_workspace_sync").at(-1)?.args);
  expect(activeDelta?.incremental).toBe(true);
  expect(activeDelta?.layers).toEqual([]);
  expect(activeDelta?.removedLayerIds).toEqual([]);

  await page.evaluate(() => { window.__ZG_TEST__.mcpSyncError = "temporary sync failure"; });
  await importCityFixture(page);
  await expect(page.getByText("空间分析图层同步失败：temporary sync failure", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__ZG_TEST__.mcpLayers.length)).toBe(2);
  await page.evaluate(() => { window.__ZG_TEST__.mcpSyncError = ""; });
  await expect.poll(() => page.evaluate(() => window.__ZG_TEST__.mcpLayers.length)).toBe(3);
  const retry = await page.evaluate(() => window.__ZG_TEST__.calls.filter(call => call.command === "gis_workspace_sync").at(-1)?.args);
  expect(retry?.incremental).toBe(true);
  expect(retry?.layers).toHaveLength(1);
  expect((retry?.layers as { name: string }[])[0].name).toBe(CITY_TEST_FILENAME);
});
