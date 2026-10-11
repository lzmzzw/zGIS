// 只发现 MCP 工具，不创建聊天、不发送提示或发起模型推理。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const child = spawn("codex", ["--disable", "apps", "--disable", "plugins", "app-server", "--stdio"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error("Codex MCP discovery request failed"));
  else request.resolve(message.result);
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex MCP discovery timed out")); }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await rpc("initialize", { clientInfo: { name: "zgis-mcp-smoke", version: "1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const inventory = await rpc("mcpServerStatus/list", { serverName: "zgis", detail: "toolsAndAuthOnly" });
  const server = inventory.data.find(server => server.name === "zgis");
  assert.ok(server, "Codex configuration must include zgis");
  assert.ok(server.toolsError === null, "Codex must authenticate using the configured header helper");
  assert.ok(Object.keys(server.tools).length >= 30, "Codex must discover the zGIS analysis and cache tools");
  for (const name of ["list_results", "release_result"]) assert.ok(Object.keys(server.tools).some(key => key.endsWith(name)), `Missing ${name}`);
  console.log("PASS: Codex reads its persisted configuration, authenticates with the fixed keyring token and discovers the zGIS analysis and cache tools; no model inference");
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  lines.close(); child.stdin.end(); child.kill();
}
