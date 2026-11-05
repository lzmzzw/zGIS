import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repository = fileURLToPath(new URL("../", import.meta.url));
export const runtimeRoot = path.join(repository, "src-tauri/resources/gdal");
export const lockPath = path.join(repository, "config/gdal-runtime.lock.json");
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const recipeFingerprint = () => sha256(Buffer.concat(["scripts/prepare-gdal.mjs", "scripts/gdal-sources.mjs", "scripts/gdal-profile.mjs", "scripts/gdal-sqlite/CMakeLists.txt", "config/gdal-runtime.lock.json"].map((name) => fs.readFileSync(path.join(repository, name)))));

export function targetName(value) {
  const target = value ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? `${process.platform}-${process.arch}`;
  if (["windows-x64", "win32-x64", "x86_64-pc-windows-msvc"].includes(target)) return "windows-x64";
  if (["macos-arm64", "darwin-arm64", "aarch64-apple-darwin"].includes(target)) return "macos-arm64";
  throw new Error(`Unsupported bundled GDAL target: ${target}`);
}

export function safeRelativePath(name) {
  if (!name || name.includes("\\") || name.includes(":")) throw new Error(`Unsafe runtime entry: ${name}`);
  const parts = name.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe runtime entry: ${name}`);
  return name;
}

export function assertArchitecture(bytes, target, filename) {
  if (target === "windows-x64") {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
    if (bytes.length < offset + 6 || bytes.readUInt16LE(0) !== 0x5a4d ||
        bytes.readUInt32LE(offset) !== 0x00004550 || bytes.readUInt16LE(offset + 4) !== 0x8664)
      throw new Error(`Expected Windows x64 PE native library: ${filename}`);
  } else if (target === "macos-arm64") {
    if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== 0x0100000c)
      throw new Error(`Expected macOS ARM64 Mach-O native library: ${filename}`);
  } else throw new Error(`Unsupported native architecture: ${target}`);
}

export function filesBelow(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected runtime symlink: ${relative}`);
    return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), relative) : [relative];
  }).sort();
}

export function verifyRuntime(directory, expectedTarget, lock = JSON.parse(fs.readFileSync(lockPath, "utf8"))) {
  const target = targetName(expectedTarget);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "runtime-manifest.json"), "utf8"));
  const specification = lock.targets[target];
  if (!specification || manifest.schema !== 2 || manifest.target !== target || manifest.version !== lock.version ||
      manifest.profile !== lock.profile || manifest.recipe !== recipeFingerprint() || manifest.library !== specification.library || JSON.stringify(manifest.drivers) !== JSON.stringify(lock.drivers) ||
      JSON.stringify(manifest.sources) !== JSON.stringify(Object.fromEntries(Object.entries(lock.sources).map(([name, source]) => [name, { version: source.version, sha256: source.sha256 }]))))
    throw new Error("Bundled GDAL runtime manifest does not match the pinned source profile and target");
  const recorded = Object.keys(manifest.files ?? {}).sort();
  const actual = filesBelow(directory).filter((name) => name !== "runtime-manifest.json");
  if (JSON.stringify(recorded) !== JSON.stringify(actual)) throw new Error("Bundled GDAL runtime files differ from manifest");
  for (const name of recorded) {
    safeRelativePath(name);
    const bytes = fs.readFileSync(path.join(directory, name));
    if (sha256(bytes) !== manifest.files[name]) throw new Error(`Bundled GDAL file checksum mismatch: ${name}`);
    if (name.startsWith("native/") && /\.(dll|dylib)$/i.test(name)) assertArchitecture(bytes, target, name);
  }
  for (const required of [manifest.library, "data/LICENSE.TXT", "proj/proj.db", "licenses/PROJ.COPYING", "licenses/SQLite.txt"])
    if (!recorded.includes(required)) throw new Error(`Missing bundled GDAL resource: ${required}`);
  return { target, version: manifest.version, files: recorded.length, bytes: recorded.reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0) };
}
