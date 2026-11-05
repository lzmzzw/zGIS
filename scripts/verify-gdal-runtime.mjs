import { runtimeRoot, targetName, verifyRuntime } from "./gdal-runtime.mjs";
const args = process.argv.slice(2);
const targetIndex = args.indexOf("--target");
const rootIndex = args.indexOf("--root");
try {
  const result = verifyRuntime(rootIndex < 0 ? runtimeRoot : args[rootIndex + 1], targetName(targetIndex < 0 ? undefined : args[targetIndex + 1]));
  console.log(`GDAL ${result.version}: ${result.target}, ${result.files} verified files, ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
} catch (error) {
  console.error(`GDAL runtime verification failed: ${error.message}`);
  process.exitCode = 1;
}
