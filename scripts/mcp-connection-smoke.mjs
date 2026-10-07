import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { resolve } from "node:path";

const run = promisify(execFile);
export async function mcpConnectionSmoke(page) {
  const status = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("gis_mcp_status"));
  const setEnabled = (enabled) => page.evaluate(enabled => window.__TAURI_INTERNALS__.invoke("gis_mcp_set_enabled", { enabled }), enabled);
  let current = await status();
  assert.equal(current.enabled, true, "MCP must start before any UI interaction");
  assert.equal(current.endpoint, "http://127.0.0.1:9420/mcp");
  assert.equal(current.startupError, null);
  const helperPath = current.headersHelper.match(/-File "([^"]+)"$/)?.[1];
  assert.ok(helperPath, "Installed authentication helper must be discoverable");
  async function headers() {
    try {
      const result = await run("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath], { windowsHide: true });
      return JSON.parse(result.stdout);
    } catch (error) {
      const safeError = String(error.stderr ?? "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[0-9a-f-]{36}/gi, "[identifier]").slice(0, 500);
      throw new Error(`Installed MCP authentication helper failed (${error.code ?? "parse"}): ${safeError}`);
    }
  }
  const initialHeaders = await headers();
  assert.ok(initialHeaders.Authorization === `Bearer ${current.token}`, "Keyring credential must match the running service");
  const rpc = async (method, params, auth = initialHeaders) => {
    const response = await fetch(current.endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "install-smoke", version: "1" } });
  assert.match(initialized.instructions, /访问权限由调用 Agent 判断/);
  assert.equal((await rpc("tools/list")).tools.length, 14);
  const loaded = await rpc("tools/call", { name: "load_vector_file", arguments: { path: resolve("output/smoke/fixtures/native.geojson") } });
  assert.equal(loaded.isError, false, "External file loads without zGIS authorization dialogs");
  await setEnabled(false);
  await setEnabled(true);
  assert.equal((await status()).enabled, true, "Immediate same-port restart must not race listener shutdown");
  await setEnabled(false);
  assert.ok((await headers()).Authorization === initialHeaders.Authorization, "Stopping MCP must retain the fixed credential");
  // Exercise a real port conflict, then release it and retry through the same IPC.
  const blocker = createServer();
  await new Promise((done, reject) => { blocker.once("error", reject); blocker.listen(9420, "127.0.0.1", done); });
  try {
    let rejected = false;
    try { await setEnabled(true); } catch { rejected = true; }
    assert.equal(rejected, true);
    const failed = await status();
    assert.equal(failed.enabled, false);
    assert.match(failed.startupError, /9420/);
  } finally { await new Promise(done => blocker.close(done)); }
  await setEnabled(true);
  current = await status();
  const nextHeaders = await headers();
  assert.ok(nextHeaders.Authorization === initialHeaders.Authorization, "Restart must reuse the fixed credential");
  assert.equal((await fetch(current.endpoint, { method: "POST", headers: {}, body: "{}" })).status, 401);
  assert.equal((await rpc("tools/list", {}, nextHeaders)).tools.length, 14);
  console.log("PASS: default MCP startup, installed keyring authentication helper, external-file direct load, fixed credential across stop/restart and visible port-conflict recovery");
}
