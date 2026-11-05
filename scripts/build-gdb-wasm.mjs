import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureSources } from "./gdal-sources.mjs";
import { filesBelow, repository, safeRelativePath, sha256 } from "./gdal-runtime.mjs";

const args = process.argv.slice(2);
const baseVersion = "gdal-3.13.3-proj-9.8.1-r1";
const publicRoot = path.join(repository, "public/gdb-runtime");
const manifestPath = path.join(publicRoot, "manifest.json");
const sourceFiles = ["scripts/build-gdb-wasm.mjs", "scripts/gdal-profile.mjs", "scripts/gdal-sources.mjs", "config/gdal-runtime.lock.json", "crates/gdb-wasm/Cargo.toml", "crates/gdb-wasm/Cargo.lock", "crates/gdb-wasm/src/lib.rs", "src-tauri/src/gdb_contract.rs", "src-tauri/src/gdb_native.rs"];
function sourceDigest() {
  return sha256(Buffer.from(sourceFiles.map((file) => `${file}:${sha256(fs.readFileSync(path.join(repository, file)))}`).join("\n")));
}
// Assets are immutable: an interrupted deploy must leave the prior cached
// manifest usable, even when a reader/build fix changes the generated runtime.
const version = `${baseVersion}-${sourceDigest().slice(0, 12)}`;
const allowed = new Set(["--check", "--force"]);
if (args.some((arg) => !allowed.has(arg))) throw new Error("Usage: node scripts/build-gdb-wasm.mjs [--check] [--force]");

function verifyExisting() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version || manifest.sourceDigest !== sourceDigest() || !Array.isArray(manifest.files)) throw new Error("GDB WASM runtime manifest is missing or stale");
  verifyArtifacts(manifest, path.join(publicRoot, version));
  return manifest;
}
function verifyArtifacts(manifest, directory) {
  const seen = new Set();
  for (const entry of manifest.files) {
    safeRelativePath(entry.name);
    if (seen.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid GDB WASM manifest entry");
    seen.add(entry.name);
    const bytes = fs.readFileSync(path.join(directory, entry.name));
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error(`GDB WASM artifact verification failed: ${entry.name}`);
  }
  if (!["gdb-runtime.js", "gdb-runtime.wasm", "proj/proj.db"].every((name) => seen.has(name))) throw new Error("GDB WASM runtime is incomplete");
}

function run(command, parameters, options = {}) {
  const result = spawnSync(command, parameters, { stdio: "inherit", shell: false, windowsHide: true, ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? result.error?.message})`);
}
function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
function executable(directory, name) {
  const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  return candidates.map((file) => path.join(directory, file)).find((file) => fs.existsSync(file));
}

try {
  if (!args.includes("--force")) {
    try {
      const manifest = verifyExisting();
      console.log(`GDB WASM runtime verified: ${manifest.version}, ${manifest.files.length} files`);
      process.exit(0);
    } catch (error) { if (args.includes("--check")) throw error; }
  }
  const sources = ensureSources();
  const emsdk = path.resolve(process.env.EMSDK ?? path.join(repository, "output/emsdk-download/emsdk-4.0.19"));
  const emscripten = path.join(emsdk, "upstream/emscripten");
  if (!fs.existsSync(path.join(emscripten, "emcc.py"))) throw new Error("Emscripten SDK is not installed; activate emsdk 4.0.19 or set EMSDK");
  const pythonDirectories = fs.existsSync(path.join(emsdk, "python")) ? fs.readdirSync(path.join(emsdk, "python"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(emsdk, "python", entry.name)) : [];
  const python = process.env.EMSDK_PYTHON ?? pythonDirectories.flatMap((directory) => [executable(directory, "python"), executable(path.join(directory, "bin"), "python3")]).find(Boolean) ?? (process.platform === "win32" ? "python" : "python3");
  const environment = { ...process.env, EMSDK: emsdk, EMSDK_PYTHON: python, EM_CONFIG: process.env.EM_CONFIG ?? path.join(emsdk, ".emscripten"), PATH: [emscripten, path.join(emsdk, "upstream/bin"), process.env.PATH ?? ""].join(path.delimiter) };
  const buildRoot = path.join(repository, "output/gdal-build/wasm32-emscripten");
  const install = path.join(buildRoot, "install");
  const visualStudioCmake = process.env.VSINSTALLDIR ? path.join(process.env.VSINSTALLDIR, "Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe") : "";
  const cmake = process.env.GDB_CMAKE ?? (fs.existsSync(visualStudioCmake) ? visualStudioCmake : "cmake");
  const visualStudioNinja = process.env.VSINSTALLDIR ? path.join(process.env.VSINSTALLDIR, "Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe") : "";
  const generator = ["-G", "Ninja", ...(fs.existsSync(visualStudioNinja) ? [`-DCMAKE_MAKE_PROGRAM=${visualStudioNinja}`] : [])];
  const toolchain = path.join(emscripten, "cmake/Modules/Platform/Emscripten.cmake");
  const defaults = [`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`, `-DEMSCRIPTEN_ROOT_PATH=${emscripten}`, "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_INSTALL_PREFIX=${install}`, "-DCMAKE_POSITION_INDEPENDENT_CODE=ON", "-DCMAKE_C_FLAGS=-O2", "-DCMAKE_CXX_FLAGS=-O2 -fexceptions -sDISABLE_EXCEPTION_CATCHING=0"];
  const configureBuild = (name, source, options) => {
    const build = path.join(buildRoot, name);
    // CMake's generated try_compile files treat Windows backslashes as escapes.
    run(cmake, ["-S", source, "-B", build, ...generator, ...defaults, ...options].map((argument) => argument.replaceAll("\\", "/")), { env: environment });
    run(cmake, ["--build", build, "--parallel", String(Math.max(1, Math.min(8, Number(process.env.CMAKE_BUILD_PARALLEL_LEVEL) || 4)))], { env: environment });
    run(cmake, ["--install", build], { env: environment });
  };
  fs.mkdirSync(buildRoot, { recursive: true });
  // A tiny dedicated cross-build avoids a WASM sqlite shell; PROJ's database is produced by a host sqlite shell.
  const sqliteBuild = path.join(buildRoot, "sqlite-source");
  fs.mkdirSync(sqliteBuild, { recursive: true });
  fs.writeFileSync(path.join(sqliteBuild, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.16)\nproject(zgis_sqlite_wasm C)\nadd_library(sqlite3 STATIC "${sources.sqlite.replaceAll("\\", "/")}/sqlite3.c")\ntarget_compile_definitions(sqlite3 PRIVATE SQLITE_THREADSAFE=0 SQLITE_OMIT_LOAD_EXTENSION SQLITE_ENABLE_COLUMN_METADATA)\nset_target_properties(sqlite3 PROPERTIES PUBLIC_HEADER "${sources.sqlite.replaceAll("\\", "/")}/sqlite3.h")\ninstall(TARGETS sqlite3 ARCHIVE DESTINATION lib PUBLIC_HEADER DESTINATION include)\n`);
  configureBuild("sqlite", sqliteBuild, []);
  const sqlite = path.join(install, "lib/libsqlite3.a");
  const hostTarget = process.platform === "win32" ? "windows-x64" : "macos-arm64";
  const hostInstall = path.join(repository, "output/gdal-build", hostTarget, "install");
  const hostSqlite = process.env.GDB_SQLITE_EXECUTABLE ?? executable(path.join(hostInstall, "bin"), "sqlite3");
  if (!hostSqlite || !fs.existsSync(hostSqlite)) throw new Error("Build the native GDAL runtime first, or set GDB_SQLITE_EXECUTABLE to a host sqlite3 executable");
  configureBuild("proj", sources.proj, ["-DBUILD_SHARED_LIBS=OFF", "-DBUILD_TESTING=OFF", "-DBUILD_APPS=OFF", "-DBUILD_EXAMPLES=OFF", "-DENABLE_CURL=OFF", "-DENABLE_TIFF=OFF", "-DEMBED_PROJ_DATA_PATH=OFF", "-DEMBED_RESOURCE_FILES=OFF", `-DSQLite3_INCLUDE_DIR=${path.join(install, "include")}`, `-DSQLite3_LIBRARY=${sqlite}`, `-DEXE_SQLITE3=${hostSqlite}`]);
  configureBuild("gdal", sources.gdal, [
    // GDAL's bundled zlib must use off_t from unistd like its CPL callers;
    // Emscripten off_t is 64-bit whereas the zlib fallback `long` is 32-bit.
    "-DCMAKE_C_FLAGS=-O2 -DHAVE_UNISTD_H",
    "-DBUILD_SHARED_LIBS=OFF", "-DBUILD_TESTING=OFF", "-DBUILD_APPS=OFF", "-DBUILD_PYTHON_BINDINGS=OFF", "-DBUILD_JAVA_BINDINGS=OFF", "-DBUILD_CSHARP_BINDINGS=OFF",
    "-DENABLE_GNM=OFF", "-DENABLE_PAM=OFF", "-DGDAL_ENABLE_ALGORITHMS=OFF", "-DGDAL_ENABLE_PLUGINS=OFF", "-DGDAL_ENABLE_PLUGINS_NO_DEPS=OFF",
    "-DGDAL_BUILD_OPTIONAL_DRIVERS=OFF", "-DOGR_BUILD_OPTIONAL_DRIVERS=OFF", "-DOGR_ENABLE_DRIVER_OPENFILEGDB=ON", "-DOGR_ENABLE_DRIVER_GEOJSON=OFF", "-DOGR_ENABLE_DRIVER_SHAPE=OFF", "-DOGR_ENABLE_DRIVER_JSONFG=OFF", "-DOGR_ENABLE_DRIVER_VRT=OFF", "-DGDAL_ENABLE_DRIVER_VRT=OFF", "-DGDAL_ENABLE_DRIVER_GTIFF=OFF",
    "-DGDAL_USE_EXTERNAL_LIBS=OFF", "-DGDAL_USE_INTERNAL_LIBS=OFF", "-DGDAL_USE_ZLIB_INTERNAL=ON", "-DGDAL_USE_JSONC_INTERNAL=ON", "-DGDAL_USE_CURL=OFF", "-DGDAL_USE_GEOS=OFF", "-DGDAL_USE_TIFF=OFF", "-DGDAL_USE_GEOTIFF=OFF", "-DGDAL_USE_SQLITE3=OFF", "-DGDAL_USE_ICONV=OFF",
    "-DEMBED_RESOURCE_FILES=OFF", `-DCMAKE_PREFIX_PATH=${install}`, `-DPROJ_DIR=${path.join(install, "lib/cmake/proj")}`, `-DSQLite3_INCLUDE_DIR=${path.join(install, "include")}`, `-DSQLite3_LIBRARY=${sqlite}`,
  ]);
  const userCargo = process.platform === "win32" ? path.join(process.env.USERPROFILE ?? "", ".cargo/bin/cargo.exe") : "";
  run(fs.existsSync(userCargo) ? userCargo : "cargo", [`+${process.env.GDB_RUST_TOOLCHAIN ?? "1.96.0"}`, "build", "--manifest-path", "crates/gdb-wasm/Cargo.toml", "--release", "--target", "wasm32-unknown-emscripten", "--locked"], { cwd: repository, env: environment });
  // Keep staging outside Vite's public watcher, which holds directory handles
  // on Windows and can prevent the final rename after a long compilation.
  const staging = path.join(buildRoot, `${version}.preparing`);
  if (path.dirname(staging) !== buildRoot || !path.basename(staging).endsWith(".preparing")) throw new Error("Invalid WASM staging directory");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const runtimeMethods = ["FS", "cwrap", "UTF8ToString", "stringToUTF8", "lengthBytesUTF8"];
  const exports = ["_zgis_gdb_execute", "_zgis_gdb_free", "_malloc", "_free"];
  run(python, [path.join(emscripten, "emcc.py"), "-O2", "--profiling-funcs", "-fexceptions", "-sDISABLE_EXCEPTION_CATCHING=0", "--no-entry", "-Wl,--start-group", path.join(repository, "crates/gdb-wasm/target/wasm32-unknown-emscripten/release/libgdb_wasm.a"), path.join(install, "lib/libgdal.a"), path.join(install, "lib/libproj.a"), sqlite, "-Wl,--end-group", "-lstdc++", "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sEXPORT_NAME=createGdbModule", "-sENVIRONMENT=web,worker,node", "-sFILESYSTEM=1", "-sFORCE_FILESYSTEM=1", "-sALLOW_MEMORY_GROWTH=1", "-sMAXIMUM_MEMORY=2147483648", "-sSTACK_SIZE=8388608", `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports)}`, `-sEXPORTED_RUNTIME_METHODS=${JSON.stringify(runtimeMethods)}`, "-o", path.join(staging, "gdb-runtime.js")], { env: environment });
  copyFile(path.join(install, "share/proj/proj.db"), path.join(staging, "proj/proj.db"));
  fs.cpSync(path.join(install, "share/gdal"), path.join(staging, "data"), { recursive: true, dereference: true });
  copyFile(path.join(sources.proj, "COPYING"), path.join(staging, "licenses/PROJ.COPYING"));
  copyFile(path.join(sources.gdal, "LICENSE.TXT"), path.join(staging, "licenses/GDAL.LICENSE.TXT"));
  fs.writeFileSync(path.join(staging, "licenses/SQLite.txt"), "SQLite 3.50.4 is in the public domain. https://www.sqlite.org/copyright.html\n");
  const manifest = { schema: 1, version, sourceDigest: sourceDigest(), gdalVersion: sources.lock.version, profile: sources.lock.profile, sources: Object.fromEntries(Object.entries(sources.lock.sources).map(([name, source]) => [name, { version: source.version, sha256: source.sha256 }])), files: filesBelow(staging).map((name) => { const bytes = fs.readFileSync(path.join(staging, name)); return { name, size: bytes.length, sha256: sha256(bytes) }; }) };
  const destination = path.join(publicRoot, version);
  fs.mkdirSync(publicRoot, { recursive: true });
  // Copy immutable content first. Directory renames can be denied by Windows
  // scanners/watchers; the manifest is published only after every hash passes.
  fs.cpSync(staging, destination, { recursive: true, dereference: true });
  verifyArtifacts(manifest, destination);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  verifyExisting();
  console.log(`Built ${version}: ${manifest.files.length} hashed files; Web loads these only when GDB is requested`);
} catch (error) {
  console.error(`GDB WASM build failed: ${error.message}`);
  process.exitCode = 1;
}
