import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { resolve, extname, sep } from "node:path";

// 只提供实际构建产物；无 SPA fallback，避免掩盖静态路径和资源缺失。
const root = resolve("dist-web");
const mime = {
  ".html": "text/html;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (!pathname.startsWith("/zgis/")) throw new Error("not found");
    const path = resolve(root, pathname.slice(6) || "index.html");
    if (!path.startsWith(root + sep) || !statSync(path).isFile())
      throw new Error("not found");
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}).listen(14841, "127.0.0.1", () =>
  console.log("Web static test: http://127.0.0.1:14841/zgis/"),
);
