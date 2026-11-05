import { renameSync, existsSync, readdirSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { safeRelativePath, sha256 } from "./gdal-runtime.mjs";

// Web 入口与桌面入口分离；产物使用通用 index.html 和相对资源路径。
if (existsSync("dist-web/web.html"))
  renameSync("dist-web/web.html", "dist-web/index.html");
const html = readFileSync("dist-web/index.html", "utf8");
if (/\b(?:src|href)=["']\/(?!\/)/.test(html))
  throw new Error("Web HTML 含根目录绝对资源路径，不能部署到子目录。");
const files = readdirSync("dist-web/assets");
if (!files.some((file) => file.endsWith(".wasm")))
  throw new Error("Web 产物缺少空间分析 WASM。");
// 不允许桌面数据库、Agent 或终端入口进入静态 JS 依赖图。
for (const file of files.filter((file) => file.endsWith(".js"))) {
  const content = readFileSync(join("dist-web/assets", file), "utf8");
  for (const marker of [
    "connect_database",
    "connect_mysql_database",
    "codex_agent_start",
    "gis_mcp_set_enabled",
    "__TAURI_INTERNALS__",
  ])
    if (content.includes(marker))
      throw new Error(`Web 产物混入桌面入口：${marker}`);
}
// Publish only the immutable version referenced by the validated manifest;
// source caches, older versions and failed staging directories remain local.
const runtime = "public/gdb-runtime";
const manifestBytes = readFileSync(join(runtime, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (!/^[a-zA-Z0-9._-]{1,100}$/.test(manifest.version) || !Array.isArray(manifest.files))
  throw new Error("Invalid GDB runtime manifest");
for (const file of manifest.files) {
  safeRelativePath(file.name);
  const source = join(runtime, manifest.version, file.name);
  const bytes = readFileSync(source);
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
    throw new Error(`GDB runtime integrity failure: ${file.name}`);
  const destination = join("dist-web/gdb-runtime", manifest.version, file.name);
  mkdirSync(join(destination, ".."), { recursive: true });
  copyFileSync(source, destination);
}
copyFileSync(join(runtime, "manifest.json"), "dist-web/gdb-runtime/manifest.json");
console.log("PASS: Web 静态入口、WASM 与桌面能力隔离检查通过。");
