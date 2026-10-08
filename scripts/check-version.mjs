import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const packageVersion = JSON.parse(read("package.json")).version;
const tauriVersion = JSON.parse(read("src-tauri/tauri.conf.json")).version;
const cargoPackage = read("src-tauri/Cargo.toml")
  .split("[package]")[1]
  ?.split(/^\[/m)[0];
const cargoVersion = cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lockedVersion = read("src-tauri/Cargo.lock")
  .split("[[package]]")
  .find((entry) => /^name\s*=\s*"zgis"$/m.test(entry))
  ?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const parsed =
  typeof packageVersion === "string" ? packageVersion.match(semver) : null;
const validPrerelease = !parsed?.[4]
  ?.split(".")
  .some((part) => /^0\d+$/.test(part));
if (
  !parsed ||
  !validPrerelease ||
  packageVersion !== tauriVersion ||
  packageVersion !== cargoVersion ||
  packageVersion !== lockedVersion
)
  throw new Error(
    "package.json、Cargo.toml、Cargo.lock 和 tauri.conf.json 版本必须一致且符合 SemVer。",
  );
const tag = process.argv[2] ?? "";
if (tag && tag !== `v${packageVersion}`)
  throw new Error(`发布标签须为 v${packageVersion}。`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${packageVersion}\nprerelease=${Boolean(parsed[4])}\n`, "utf8");
console.log(
  `PASS: ${fileURLToPath(root)} version ${packageVersion}${tag ? ` / ${tag}` : ""}`,
);
