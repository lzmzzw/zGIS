import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = "crates/spatial-wasm/Cargo.toml";
const version = readFileSync(path.join(root, manifest), "utf8").match(
  /wasm-bindgen\s*=\s*"=([^"]+)"/,
)[1];
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr ||
        result.stdout ||
        `${command} 执行失败，请安装 Rust wasm32 target 和 wasm-bindgen-cli ${version}`,
    );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}
const cli = run("wasm-bindgen", ["--version"]);
if (cli !== `wasm-bindgen ${version}`)
  throw new Error(`wasm-bindgen CLI 版本不匹配：需要 ${version}，当前 ${cli}`);
run("cargo", [
  "build",
  "--manifest-path",
  manifest,
  "--target",
  "wasm32-unknown-unknown",
  "--release",
  "--locked",
]);
mkdirSync(path.join(root, "src/web/wasm"), { recursive: true });
run("wasm-bindgen", [
  "crates/spatial-wasm/target/wasm32-unknown-unknown/release/spatial_wasm.wasm",
  "--target",
  "web",
  "--no-typescript",
  "--out-dir",
  "src/web/wasm",
]);
