import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { ensureSources } from "./gdal-sources.mjs";
import { filesBelow, recipeFingerprint, repository, runtimeRoot, sha256, targetName, verifyRuntime } from "./gdal-runtime.mjs";

const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
}
function execute(command, parameters, options = {}) {
  const normalized = parameters.map((parameter) => parameter.startsWith("-D") ? parameter.replaceAll("\\", "/") : parameter);
  const result = spawnSync(command, normalized, { stdio: "inherit", shell: false, windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.message})`);
}
function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

try {
  const target = targetName(argument("--target"));
  if (target !== targetName()) throw new Error("Build the native GDAL runtime on its target operating system and architecture");
  const output = path.resolve(argument("--root") ?? runtimeRoot);
  const generatedRoot = path.join(repository, "output") + path.sep;
  if (output !== runtimeRoot && !output.startsWith(generatedRoot)) throw new Error("GDAL output must be the repository runtime or a task directory under output/");
  try {
    const current = verifyRuntime(output, target);
    console.log(`Bundled GDAL ${current.version} already verified for ${target}`);
    process.exit(0);
  } catch { /* Build missing/stale generated resources from pinned source archives. */ }
  // Direct `tauri build` also works from an ordinary PowerShell, without a preloaded MSVC environment.
  if (process.platform === "win32" && !process.env.VCINSTALLDIR) {
    execute("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "& { param($root, $script, $target, $output) . (Join-Path $root 'scripts/msvc-environment.ps1'); & node $script --target $target --root $output; exit $LASTEXITCODE }", repository, import.meta.filename, target, output]);
    process.exit(0);
  }
  const sources = ensureSources();
  const windows = target === "windows-x64";
  if (windows) {
    process.env.VSLANG = "1033";
    // Some desktop hosts omit this standard environment value; CMake otherwise skips x64 CPU feature checks.
    process.env.PROCESSOR_ARCHITECTURE = "AMD64";
  }
  let buildRepository = repository;
  if (windows && /[^\x20-\x7e]/.test(repository)) {
    // MSVC link response files use the system code page. An ASCII junction avoids corrupting Unicode source paths.
    const junction = path.join(os.tmpdir(), `zgis-gdal-${sha256(Buffer.from(repository)).slice(0, 12)}`);
    if (!fs.existsSync(junction)) fs.symlinkSync(repository, junction, "junction");
    if (fs.realpathSync(junction).toLowerCase() !== fs.realpathSync(repository).toLowerCase()) throw new Error("GDAL build junction points to an unexpected directory");
    if (/[^\x20-\x7e]/.test(junction)) throw new Error("GDAL Windows build requires an ASCII temporary directory");
    buildRepository = junction;
  }
  const sourcePath = (directory) => path.join(buildRepository, path.relative(repository, directory));
  const buildRoot = path.join(buildRepository, "output/gdal-build", target);
  const install = path.join(buildRoot, "install");
  const visualStudioCmake = process.env.VSINSTALLDIR ? path.join(process.env.VSINSTALLDIR, "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe") : "";
  const cmake = windows && fs.existsSync(visualStudioCmake) ? visualStudioCmake : "cmake";
  const visualStudioNinja = process.env.VSINSTALLDIR ? path.join(process.env.VSINSTALLDIR, "Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe") : "";
  const generator = windows && fs.existsSync(visualStudioNinja) ? ["-G", "Ninja", `-DCMAKE_MAKE_PROGRAM=${visualStudioNinja}`] : windows ? ["-G", "NMake Makefiles"] : ["-G", "Unix Makefiles"];
  const defaults = ["-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${install}`, "-DCMAKE_POSITION_INDEPENDENT_CODE=ON", ...(windows ? ["-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"] : ["-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0"])];
  const sqliteLibrary = path.join(install, "lib", windows ? "sqlite3.lib" : "libsqlite3.a");
  const sqliteExecutable = path.join(install, "bin", windows ? "sqlite3.exe" : "sqlite3");
  const configureBuild = (name, source, options) => {
    const build = path.join(buildRoot, name);
    execute(cmake, ["--fresh", "-S", source, "-B", build, ...generator, ...defaults, ...options]);
    execute(cmake, ["--build", build, "--config", "Release", "--parallel", String(Math.max(1, Math.min(8, Number(process.env.CMAKE_BUILD_PARALLEL_LEVEL) || 4)))]);
    execute(cmake, ["--install", build, "--config", "Release"]);
  };
  configureBuild("sqlite", path.join(buildRepository, "scripts/gdal-sqlite"), [`-DSQLITE_SOURCE=${sourcePath(sources.sqlite)}`]);
  configureBuild("proj", sourcePath(sources.proj), ["-DBUILD_SHARED_LIBS=OFF", "-DBUILD_TESTING=OFF", "-DBUILD_APPS=OFF", "-DBUILD_EXAMPLES=OFF", "-DENABLE_CURL=OFF", "-DENABLE_TIFF=OFF", "-DEMBED_PROJ_DATA_PATH=OFF", "-DEMBED_RESOURCE_FILES=OFF", `-DSQLite3_INCLUDE_DIR=${path.join(install, "include")}`, `-DSQLite3_LIBRARY=${sqliteLibrary}`, `-DEXE_SQLITE3=${sqliteExecutable}`]);
  configureBuild("gdal", sourcePath(sources.gdal), [
    "-DBUILD_SHARED_LIBS=ON", "-DBUILD_TESTING=OFF", "-DBUILD_APPS=OFF", "-DBUILD_PYTHON_BINDINGS=OFF", "-DBUILD_JAVA_BINDINGS=OFF", "-DBUILD_CSHARP_BINDINGS=OFF",
    "-DENABLE_GNM=OFF", "-DENABLE_PAM=OFF", "-DGDAL_ENABLE_ALGORITHMS=OFF", "-DGDAL_ENABLE_PLUGINS=OFF", "-DGDAL_ENABLE_PLUGINS_NO_DEPS=OFF",
    "-DGDAL_BUILD_OPTIONAL_DRIVERS=OFF", "-DOGR_BUILD_OPTIONAL_DRIVERS=OFF", "-DOGR_ENABLE_DRIVER_OPENFILEGDB=ON", "-DOGR_ENABLE_DRIVER_GEOJSON=OFF", "-DOGR_ENABLE_DRIVER_SHAPE=OFF", "-DOGR_ENABLE_DRIVER_JSONFG=OFF", "-DOGR_ENABLE_DRIVER_VRT=OFF", "-DGDAL_ENABLE_DRIVER_VRT=OFF", "-DGDAL_ENABLE_DRIVER_GTIFF=OFF",
    "-DGDAL_USE_EXTERNAL_LIBS=OFF", "-DGDAL_USE_INTERNAL_LIBS=OFF", "-DGDAL_USE_ZLIB_INTERNAL=ON", "-DGDAL_USE_JSONC_INTERNAL=ON", "-DGDAL_USE_CURL=OFF", "-DGDAL_USE_GEOS=OFF", "-DGDAL_USE_TIFF=OFF", "-DGDAL_USE_GEOTIFF=OFF", "-DGDAL_USE_SQLITE3=OFF",
    "-DEMBED_RESOURCE_FILES=OFF", "-DGDAL_LIB_OUTPUT_NAME=gdal", `-DCMAKE_PREFIX_PATH=${install}`, `-DPROJ_DIR=${path.join(install, "lib/cmake/proj")}`, `-DSQLite3_INCLUDE_DIR=${path.join(install, "include")}`, `-DSQLite3_LIBRARY=${sqliteLibrary}`,
  ]);
  const staging = `${output}.preparing`;
  if (path.dirname(staging) !== path.dirname(output) || !path.basename(staging).endsWith(".preparing")) throw new Error("Invalid GDAL staging directory");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "native"), { recursive: true });
  copyFile(path.join(repository, "src-tauri/resources/gdal/README.md"), path.join(staging, "README.md"));
  const library = sources.lock.targets[target].library;
  // Copy actual file contents, not a symlink to the build tree.
  copyFile(path.join(install, windows ? "bin/gdal.dll" : "lib/libgdal.dylib"), path.join(staging, library));
  fs.cpSync(path.join(install, "share/gdal"), path.join(staging, "data"), { recursive: true, dereference: true });
  copyFile(path.join(install, "share/proj/proj.db"), path.join(staging, "proj/proj.db"));
  copyFile(path.join(sources.proj, "COPYING"), path.join(staging, "licenses/PROJ.COPYING"));
  fs.writeFileSync(path.join(staging, "licenses/SQLite.txt"), "SQLite 3.50.4 is in the public domain.\nSource: https://www.sqlite.org/copyright.html\n");
  if (!windows) execute("codesign", ["--force", "--sign", "-", "--timestamp=none", path.join(staging, library)]);
  const manifest = {
    schema: 2, profile: sources.lock.profile, recipe: recipeFingerprint(), target, version: sources.lock.version, library,
    drivers: sources.lock.drivers,
    sources: Object.fromEntries(Object.entries(sources.lock.sources).map(([name, source]) => [name, { version: source.version, sha256: source.sha256 }])),
    files: Object.fromEntries(filesBelow(staging).map((name) => [name, sha256(fs.readFileSync(path.join(staging, name)))])),
  };
  fs.writeFileSync(path.join(staging, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = verifyRuntime(staging, target, sources.lock);
  // Tauri's resource watcher can hold this directory open on Windows. Publish generated files with the manifest last.
  fs.mkdirSync(output, { recursive: true });
  let previousFiles = [];
  try { previousFiles = Object.keys(JSON.parse(fs.readFileSync(path.join(output, "runtime-manifest.json"), "utf8")).files ?? {}); } catch { /* first build */ }
  for (const name of filesBelow(staging).filter((name) => name !== "runtime-manifest.json")) copyFile(path.join(staging, name), path.join(output, name));
  for (const name of previousFiles.filter((name) => !Object.hasOwn(manifest.files, name))) {
    if (name === "README.md") continue;
    if (path.isAbsolute(name) || name.includes("..") || name.includes(":")) throw new Error("Invalid previous GDAL manifest entry");
    fs.rmSync(path.join(output, name), { force: true });
  }
  copyFile(path.join(staging, "runtime-manifest.json"), path.join(output, "runtime-manifest.json"));
  verifyRuntime(output, target, sources.lock);
  fs.rmSync(staging, { recursive: true });
  console.log(`Built GDAL ${result.version}: ${target}, ${result.files} verified files, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
} catch (error) {
  console.error(`GDAL preparation failed: ${error.message}`);
  process.exitCode = 1;
}
