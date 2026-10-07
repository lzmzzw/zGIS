import { test, expect, type Page } from "@playwright/test";
import { installDesktopMock } from "./desktop.mock";

async function settings(page: Page) {
  await installDesktopMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "MCP", exact: true }).click();
}

test("catalog loads while stopped, groups every tool including unknown additions and retains collapse", async ({ page }) => {
  await settings(page);
  const names = ["list_layers", "describe_layer", "read_features", "load_vector_file", "read_result", "publish_result", "spatial_query", "spatial_join", "nearest", "topology_check", "buffer", "clip", "dissolve", "layer_summary", "future_tool"];
  await page.evaluate(names => { window.__ZG_TEST__.mcpTools = names.map(name => ({ name, description: `说明 ${name}`, inputSchema: {} })); }, names);
  const toggle = page.getByRole("button", { name: /工具详情/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_mcp_tool_catalog"))).toHaveLength(0);
  await toggle.click();
  await expect(toggle).toContainText("15 个工具");
  await expect(page.locator(".mcp-tool-item")).toHaveCount(15);
  const firstTool = page.locator(".mcp-tool-item").first();
  await expect(firstTool.locator("p")).toBeHidden();
  await firstTool.locator("summary").click();
  await expect(firstTool.locator("p")).toHaveText("说明 list_layers");
  await expect(firstTool.locator("p")).toBeVisible();
  expect(await page.locator(".mcp-tool-item code").allTextContents()).toEqual(expect.arrayContaining(names));
  await expect(page.getByRole("region", { name: "其他工具" })).toContainText("future_tool");
  await expect(page.getByRole("button", { name: "启用 MCP", exact: true })).toBeVisible();
  await page.screenshot({ path: "output/smoke/mcp-tool-catalog.png" });
  await toggle.click();
  await expect(page.locator(".mcp-tool-item")).toHaveCount(0);
  await toggle.click();
  await expect(page.locator(".mcp-tool-item")).toHaveCount(15);
  expect(await page.evaluate(() => window.__ZG_TEST__.calls.filter(c => c.command === "gis_mcp_tool_catalog"))).toHaveLength(1);
});

test("failed catalog retries and reports an empty result", async ({ page }) => {
  await settings(page);
  await page.evaluate(() => { window.__ZG_TEST__.mcpToolsError = "catalog unavailable"; });
  await page.getByRole("button", { name: /工具详情/ }).click();
  await expect(page.getByRole("alert")).toContainText("catalog unavailable");
  await page.evaluate(() => { window.__ZG_TEST__.mcpToolsError = ""; });
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator("#mcp-tools-details")).toContainText("当前 MCP 未提供工具");
  await expect(page.getByRole("button", { name: /工具详情/ })).toContainText("0 个工具");
});
