import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { snapshotLayers } = await server.ssrLoadModule("/src/workspace.ts");
  const { searchFeatures } = await server.ssrLoadModule("/src/attributeSearch.ts");
  const { makeLayer } = await server.ssrLoadModule("/src/domain/index.ts");
  const features = Array.from({ length: 10000 }, (_, n) => ({ id: String(n), geometry: { type: "Point", coordinates: [100 + n / 100000, 30, n] }, properties: { name: `feature-${n}`, details: { value: n, description: "synthetic GIS benchmark" } } }));
  const layer = makeLayer("benchmark", features, "geojson");
  const template = JSON.parse(snapshotLayers([layer]))[0];
  function measure(action) {
    const samples = [];
    for (let i = 0; i < 20; i++) { const start = performance.now(); action(i); samples.push(performance.now() - start); }
    samples.sort((a,b) => a-b);
    return { medianMs: samples[10], p95Ms: samples[19] };
  }
  const baselineSnapshot = measure(() => JSON.stringify([{ ...template, features: features.map(({ id, geometry, properties, sourceFeatureId }) => ({ id, geometry, properties, sourceFeatureId })) }]));
  const cachedSnapshot = measure(() => snapshotLayers([layer]));
  const stringify = value => typeof value === "object" ? JSON.stringify(value) : String(value);
  const baselineSearch = measure(i => features.filter(f => Object.values(f.properties).some(v => stringify(v).toLowerCase().includes(`feature-${i}`))));
  searchFeatures(features, "warmup");
  const cachedSearch = measure(i => searchFeatures(features, `feature-${i}`));
  const report = { createdAt: new Date().toISOString(), input: { features: features.length, iterations: 20, dimensions: "XYZ" }, scope: "Synthetic Node/Vite module benchmark; unchanged-layer serialization and repeated attribute searches; excludes IPC, disk and WebView rendering", baselineSnapshot, cachedSnapshot, baselineSearch, cachedSearch };
  await mkdir("output/performance-20261011", { recursive: true });
  await writeFile("output/performance-20261011/frontend.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await server.close(); }
