import { createServer } from "vite";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const path = `output/large-file-performance-${Date.now()}`;
await mkdir(path, { recursive: true });
const baselineRef = process.argv[2] ?? "068db957b3ed219ced94799d9ce10cdfbfe9a97a";
const revision = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`], { encoding:"utf8" }).trim();
const baselineSource = execFileSync("git", ["show", `${revision}:src/domain/index.ts`], { encoding:"utf8" });
const sourceSha256 = Object.fromEntries(await Promise.all(["src/domain/index.ts", "src/losslessJson.ts", "src/fileLimits.ts", "src/workers/csvPreview.ts", "scripts/large-file-performance.mjs"].map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
await writeFile(`${path}/baseline-domain.ts`, baselineSource);
const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const baseline = await server.ssrLoadModule(`/${path}/baseline-domain.ts`);
  const current = await server.ssrLoadModule("/src/domain/index.ts");
  const preview = await server.ssrLoadModule("/src/workers/csvPreview.ts");
  const count = 100000;
  const record = '{"type":"Feature","id":"record-1","geometry":{"type":"Point","coordinates":[116,39,12]},"properties":{"id":9007199254740993,"description":"synthetic benchmark"}}';
  const text = '{"type":"FeatureCollection","features":[' + Array(count).fill(record).join(",") + "]}";
  const bytes = new TextEncoder().encode(text);
  const files = [{ name: "benchmark.geojson", bytes }];
  const samples = { baseline:[], current:[] };
  for (let i=0; i<3; i++) {
    for (const [name, module] of i % 2 ? [["current",current],["baseline",baseline]] : [["baseline",baseline],["current",current]]) {
      global.gc?.();
      const started = performance.now();
      const layers = await module.importFiles(files);
      samples[name].push(performance.now()-started);
      if(layers[0].features.length!==count || layers[0].features.at(-1).properties.id!=="9007199254740993") throw new Error("result mismatch");
    }
  }
  const csvBytes = new TextEncoder().encode("x,y,note\n"+"116,39,synthetic\n".repeat(count));
  const csvSample = preview.csvPreviewInput({name:"benchmark.csv",bytes:csvBytes});
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const report={createdAt:new Date().toISOString(),baselineRevision:revision,sourceSha256,input:{features:count,geojsonBytes:bytes.byteLength,geometry:"XYZ Point",properties:"unsafe integer retained as text",iterationsPerVariant:3},scope:"Node/Vite importFiles module benchmark; includes byte decoding and domain parsing; excludes Worker transfer, IPC, OpenLayers rendering, recovery persistence and disk",samplesMs:samples,medianMs:{baseline:median(samples.baseline),current:median(samples.current)},csvPreview:{inputBytes:csvBytes.byteLength,transferredSampleBytes:csvSample.file.bytes.length,rows:5}};
  await writeFile(`${path}/import.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await server.close(); }
