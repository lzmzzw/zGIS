import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync } from "fflate";

const [executableArg, runtimeArg, fixturesArg] = process.argv.slice(2);
if (!executableArg || !runtimeArg || !fixturesArg) throw new Error("usage: node scripts/gdb-worker-smoke.mjs <zgis-exe> <runtime-root> <fixtures-root>");
const executable = path.resolve(executableArg), runtime = path.resolve(runtimeArg), fixtures = path.resolve(fixturesArg);
const database = path.join(fixtures, "兼容性样本.gdb");
function filesBelow(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(root, entry.name);
    return entry.isDirectory() ? filesBelow(filename) : [filename];
  }).sort();
}
function snapshot() {
  return filesBelow(database).map(file => [path.relative(database, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
}
const original = snapshot();
function call(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--gdb-worker", runtime], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", diagnostics = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("GDB smoke timed out")); }, 30000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", chunk => { output += chunk; if (output.length > 110 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    child.on("close", code => {
      clearTimeout(timer);
      try { assert.ok(output, `worker exited ${code}: ${diagnostics}`); resolve(JSON.parse(output)); }
      catch (error) { reject(new Error(`${error.message}; stderr=${diagnostics.slice(0, 1000)}; stdout=${output.slice(0, 1000)}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
const run = (operation, extra = {}, source = database) => call({ operation, path: source, ...extra });
const catalog = await run("catalog");
assert.equal(catalog.ok, true, JSON.stringify(catalog));
const layers = catalog.result.layers;
const byName = name => { const layer = layers.find(l => l.name === name); assert.ok(layer, name); return layer; };
assert.ok(layers.length >= 11);
assert.equal(byName("points").sourceCrs, "EPSG:4326");
assert.ok(byName("points").fields.some(f => f.name === "name" && f.alias === "中文名称"));
assert.equal(byName("projected").sourceCrs, "EPSG:3857");
assert.equal(byName("projected").group, "survey");
assert.equal(byName("measured").supported, false);
// OpenFileGDB may declare a curved layer as MultiLineString; reject actual curves when reading.
assert.ok(byName("curve"));
assert.equal(byName("unknown_crs").supported, false);

async function read(layerName, extra = {}, source = database) {
  return run("read", { layerName, limit: 10000, ...extra }, source);
}
const points = await read("points");
assert.equal(points.ok, true, JSON.stringify(points));
assert.equal(points.result.features.length, 3);
assert.equal(points.result.truncated, false);
assert.equal(points.result.features[0].properties.big, "9007199254740993");
assert.equal(points.result.features[0].properties.nullable, null);
assert.equal(points.result.features[1].properties.nullable, "");
assert.equal(points.result.features[2].geometry, null);
assert.equal(typeof points.result.features[0].sourceFeatureId, "string");
const limited = await read("points", { limit: 1, fields: ["name"] });
assert.equal(limited.ok, true, JSON.stringify(limited));
assert.equal(limited.result.loadedCount, 1);
assert.equal(limited.result.truncated, true);
assert.deepEqual(Object.keys(limited.result.features[0].properties), ["name"]);
const bounds = await read("points", { bounds: [115.9, 38.9, 116.1, 39.1] });
assert.equal(bounds.ok, true, JSON.stringify(bounds));
assert.equal(bounds.result.features.length, 1);
const xyz = await read("xyz");
assert.equal(xyz.ok, true, JSON.stringify(xyz));
assert.deepEqual(xyz.result.features[0].geometry.coordinates, [116, 39, 123.5]);
const projected = await read("projected");
assert.equal(projected.ok, true, JSON.stringify(projected));
assert.ok(Math.abs(projected.result.features[0].geometry.coordinates[0] - 116) < 1e-8);
assert.ok(Math.abs(projected.result.features[0].geometry.coordinates[1] - 39) < 1e-8);
const cgcsStrict = await read("cgcs");
assert.equal(cgcsStrict.ok, false, "CGCS2000 approximation must be explicit");
const cgcs = await read("cgcs", { allowApproximateDatum: true });
assert.equal(cgcs.ok, true, JSON.stringify(cgcs));
assert.ok(Math.abs(cgcs.result.features[0].geometry.coordinates[0] - 114) < 1e-8);
assert.ok(cgcs.result.warnings.length > 0);
const multipoint = await read("multipoint");
assert.equal(multipoint.ok, true, JSON.stringify(multipoint));
assert.equal(multipoint.result.features[0].geometry.type, "MultiPoint");
assert.deepEqual(multipoint.result.features[0].geometry.coordinates, [[116, 39], [117, 40]]);
const polygon = await read("polygon");
assert.equal(polygon.ok, true, JSON.stringify(polygon));
const polygonGeometry = polygon.result.features[0].geometry;
assert.equal(polygonGeometry.type === "MultiPolygon" ? polygonGeometry.coordinates[0].length : polygonGeometry.coordinates.length, 2);
assert.equal((await read("empty")).ok, true);
for (const layer of ["measured", "curve", "unknown_crs", "does_not_exist"]) assert.equal((await read(layer)).ok, false, layer);
assert.equal((await read("binary")).ok, false);
assert.equal((await read("binary", { fields: ["name"] })).ok, true);
assert.equal((await read("points", { limit: 100001 })).ok, false);
assert.equal((await read("points", { fields: ["missing"] })).ok, false);
assert.equal((await read("points", { bounds: [170, -10, -170, 10] })).ok, false);
const zip = path.join(fixtures, "兼容性样本.gdb.zip");
fs.writeFileSync(zip, zipSync(Object.fromEntries(filesBelow(database).map(file => ["兼容性样本.gdb/" + path.relative(database, file).replaceAll("\\", "/"), fs.readFileSync(file)]))));
assert.equal((await run("catalog", {}, zip)).ok, true);
const zipped = await read("points", { fields: ["name"], limit: 1 }, zip);
assert.equal(zipped.ok, true, JSON.stringify(zipped));
assert.equal(zipped.result.features[0].properties.name, "中文 1");
assert.deepEqual(snapshot(), original, "Read-only source file hashes must remain unchanged");
fs.writeFileSync(path.join(fixtures, "worker-report.json"), JSON.stringify({ passed: true, layers: layers.length, checks: ["directory", "zip", "schema", "group", "integer64", "null-empty", "xyz", "projection", "explicit-cgcs", "holes", "multipoint", "field-filter", "bbox", "limit", "unsupported", "source-hashes"] }, null, 2));
console.log("PASS: real GDAL GDB worker directory/ZIP, CRS, fields, geometry, limits and unchanged source hashes");
