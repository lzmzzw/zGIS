import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const lock = readFileSync(
  new URL("../crates/spatial-wasm/Cargo.lock", import.meta.url),
  "utf8",
);
const version = lock.match(/name = "wasm-bindgen"\r?\nversion = "([^"]+)"/)[1];
const options = { cwd: root, encoding: "utf8", shell: false };
const current = spawnSync("wasm-bindgen", ["--version"], options);
if (
  current.status === 0 &&
  current.stdout.trim() === `wasm-bindgen ${version}`
) {
  console.log(`wasm-bindgen ${version} 已安装`);
} else {
  const result = spawnSync(
    "cargo",
    ["install", "wasm-bindgen-cli", "--version", version, "--locked"],
    { ...options, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
