import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// 平台构建只保存产物；所有平台成功后才校验并生成统一校验文件。
const [mode, directory] = process.argv.slice(2);
const root = resolve(directory ?? "release-assets");
const exactlyOne = (paths, label) => {
  if (paths.length !== 1)
    throw new Error(`${label} 应有且仅有一个，实际 ${paths.length} 个。`);
  return paths[0];
};
const filesIn = (directory, suffix) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(directory, name));

if (mode === "windows" || mode === "macos") {
  mkdirSync(root, { recursive: true });
  const target =
    mode === "windows" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin";
  const bundle = resolve("src-tauri", "target", target, "release", "bundle");
  if (mode === "windows") {
    const installer = exactlyOne(
      filesIn(join(bundle, "nsis"), "-setup.exe"),
      "Windows NSIS 安装包",
    );
    copyFileSync(installer, join(root, basename(installer)));
  } else {
    const dmg = exactlyOne(filesIn(join(bundle, "dmg"), ".dmg"), "macOS DMG");
    copyFileSync(dmg, join(root, basename(dmg)));
    const app = exactlyOne(filesIn(join(bundle, "macos"), ".app"), "macOS app");
    const version = JSON.parse(readFileSync("package.json", "utf8")).version;
    const archive = join(root, `zGIS_${version}_aarch64.app.tar.gz`);
    const result = spawnSync(
      "tar",
      ["-czf", archive, "-C", join(bundle, "macos"), basename(app)],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`macOS app 压缩失败：${result.status}`);
  }
} else if (mode === "checksums") {
  const assets = readdirSync(root).sort();
  exactlyOne(
    assets.filter((name) => name.endsWith("-setup.exe")),
    "Windows NSIS 安装包",
  );
  exactlyOne(
    assets.filter((name) => name.endsWith(".dmg")),
    "macOS DMG",
  );
  exactlyOne(
    assets.filter((name) => name.endsWith("_aarch64.app.tar.gz")),
    "macOS ARM64 app 压缩包",
  );
  if (assets.length !== 3) throw new Error("发布目录含非预期产物。");
  const checksums = assets.map((name) => {
    const path = join(root, name);
    if (!statSync(path).isFile() || statSync(path).size === 0)
      throw new Error(`产物为空或不是文件：${name}`);
    return `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}`;
  });
  writeFileSync(
    join(root, "SHA256SUMS.txt"),
    `${checksums.join("\n")}\n`,
    "utf8",
  );
} else {
  throw new Error(
    "用法：node scripts/release-assets.mjs windows|macos|checksums [产物目录]",
  );
}
