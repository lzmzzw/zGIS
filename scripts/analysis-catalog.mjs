// 从 Rust 注册表导出前端静态目录；--check 只核对，不修改文件。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL(
  "../src/generated/analysis-catalog.json",
  import.meta.url,
);
const args = [
  "run",
  "--quiet",
  "--locked",
  "--manifest-path",
  "crates/spatial-core/Cargo.toml",
  "--example",
  "tool_catalog",
];
const result =
  process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", `cargo ${args.join(" ")}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      })
    : spawnSync("cargo", args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
if (result.error || result.status !== 0) {
  console.error(result.error?.message ?? result.stderr);
  process.exit(1);
}
const catalog = JSON.parse(result.stdout);
if (
  !Array.isArray(catalog) ||
  !catalog.length ||
  catalog.some((spec) => typeof spec.id !== "string")
)
  throw new Error("Rust analysis catalog is invalid");
const content = `${JSON.stringify(catalog, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8").replaceAll("\r\n", "\n") !== content)
    throw new Error(
      "Analysis catalog is stale; run pnpm analysis:generate and review the diff.",
    );
  console.log(`Analysis catalog verified: ${catalog.length} registered tools.`);
} else {
  mkdirSync(new URL("../src/generated/", import.meta.url), { recursive: true });
  writeFileSync(output, content);
  console.log(
    `Analysis catalog generated: ${catalog.length} registered tools.`,
  );
}
