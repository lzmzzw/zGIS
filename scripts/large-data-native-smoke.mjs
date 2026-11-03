// 原生大文件验收：只运行隔离 identifier，不接触正式工作区或生产 MCP。
import { chromium, expect as playwrightExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const identifier = "com.personal.zgis.processing-smoke";
const expect = playwrightExpect.configure({ timeout: 120_000 });
const executable = resolve(process.argv[2] ?? "src-tauri/target/debug/zgis.exe");
const output = resolve(process.argv[3] ?? "output/performance-20261103/native-large-files");
const port = 9233;
const runName = new Date().toISOString().replace(/[:.]/g, "-");
const runOutput = resolve(output, runName);
const binarySample = resolve(runOutput, "native-large-50000.geojson");
const importNoteBytes = Number(process.env.ZGIS_NATIVE_NOTE_BYTES ?? 2200);
const diagnosticSkipLargeJournal = process.env.ZGIS_NATIVE_SKIP_LARGE_JOURNAL === "1";
const diagnosticSkipBackupIpc = process.env.ZGIS_NATIVE_SKIP_BACKUP_IPC === "1";
assert.ok(Number.isInteger(importNoteBytes) && importNoteBytes > 0 && importNoteBytes <= 2200);
const sample = importNoteBytes === 2200 ? binarySample : resolve(runOutput, `native-50000-note-${importNoteBytes}.geojson`);
const count = 50_000;
const marker = `native-last-${count - 1}`;
const checks = [];
const errors = [];
const report = { success: false, runName, executable, identifier, output: runOutput, checks, errors };
report.diagnosticSkipLargeJournal = diagnosticSkipLargeJournal;
report.diagnosticSkipBackupIpc = diagnosticSkipBackupIpc;
let child;
let browser;
let page;
let memoryMonitor;
let cleanupStarted = false;
const events = [];
const memorySamples = [];
report.events = events;
const saveReport = () => {
  writeFileSync(resolve(runOutput, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
};
const delay = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
function event(name, details = {}) {
  const record = { event: name, at: new Date().toISOString(), elapsedMs: performance.now(), cleanup: cleanupStarted, ...details };
  events.push(record);
  appendFileSync(resolve(runOutput, "events.jsonl"), `${JSON.stringify(record)}\n`);
}
function stage(name, details) {
  checks.push({ name, ...details });
  saveReport();
  console.log(`PASS ${name}${details?.elapsedMs ? ` (${details.elapsedMs.toFixed(1)} ms)` : ""}`);
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function generateFixture(path, noteBytes) {
  const file = createWriteStream(path, { flags: "wx" });
  file.write('{"type":"FeatureCollection","features":[');
  const note = "N".repeat(noteBytes);
  for (let index = 0; index < count; index++) {
    const feature = {
      type: "Feature", id: `native-${index}`,
      properties: { name: index === count - 1 ? marker : `native-row-${index}`, note, sequence: index },
      geometry: { type: "Point", coordinates: [116 + (index % 1000) * 0.00001, 40 + Math.floor(index / 1000) * 0.00001] },
    };
    if (!file.write(`${index ? "," : ""}${JSON.stringify(feature)}`)) await once(file, "drain");
  }
  file.end("]}");
  await once(file, "finish");
  return { path, bytes: statSync(path).size, features: count, noteAsciiBytesPerFeature: noteBytes, sha256: await hashFile(path) };
}
async function verifySavedFixture(path, savedName) {
  // 只读取本次运行自己生成的来源文件；完整内容留在 Node 侧，不经 IPC 回传。
  const bytes = statSync(path).size;
  if (importNoteBytes === 2200) assert.ok(bytes > 100 * 1024 * 1024, "Saved GeoJSON must retain its full >100 MiB content");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.type, "FeatureCollection");
  assert.equal(saved.features.length, count);
  const expectedNote = "N".repeat(importNoteBytes);
  for (let index = 0; index < count; index++) {
    const feature = saved.features[index];
    assert.equal(feature.type, "Feature");
    assert.equal(feature.properties.sequence, index, `Saved record order changed at ${index}`);
    assert.equal(feature.properties.name, index === count - 1 ? savedName : `native-row-${index}`, `Unexpected saved name at ${index}`);
    assert.equal(feature.properties.note, expectedNote, `Saved long attribute changed at ${index}`);
    assert.equal(feature.geometry.type, "Point");
    assert.deepEqual(feature.geometry.coordinates, [116 + (index % 1000) * 0.00001, 40 + Math.floor(index / 1000) * 0.00001], `Saved geometry changed at ${index}`);
  }
  return {
    path, bytes, sha256: await hashFile(path), features: saved.features.length,
    validatedEveryRecord: true, noteAsciiBytesPerFeature: importNoteBytes,
    firstName: saved.features[0].properties.name, lastName: saved.features.at(-1).properties.name,
  };
}
function sampleOwnedProcessMemory() {
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  const script = `
$ErrorActionPreference = 'Stop'
$smokeRoot = ${child.pid}
$smokeStarted = (Get-Process -Id $smokeRoot).StartTime.Ticks
for ($sampleIndex = 0; $sampleIndex -lt 600; $sampleIndex++) {
  $rootProcess = Get-Process -Id $smokeRoot -ErrorAction SilentlyContinue
  if (-not $rootProcess -or $rootProcess.StartTime.Ticks -ne $smokeStarted) { break }
  $inventory = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
  $ownedIds = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ownedIds.Add($smokeRoot)
  do {
    $added = $false
    foreach ($item in $inventory) {
      if ($ownedIds.Contains([int]$item.ParentProcessId) -and $ownedIds.Add([int]$item.ProcessId)) { $added = $true }
    }
  } while ($added)
  $samples = @(foreach ($ownedId in $ownedIds) {
    $process = Get-Process -Id $ownedId -ErrorAction SilentlyContinue
    if ($process) { [pscustomobject]@{ pid=$process.Id; name=$process.ProcessName; privateBytes=$process.PrivateMemorySize64; workingSetBytes=$process.WorkingSet64 } }
  })
  [pscustomobject]@{ at=[DateTime]::UtcNow.ToString('o'); rootPid=$smokeRoot; processes=$samples } | ConvertTo-Json -Depth 4 -Compress
  Start-Sleep -Milliseconds 1000
}`;
  memoryMonitor = spawn("pwsh", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  report.windowsMemoryLog = resolve(runOutput, "windows-memory.jsonl");
  let buffered = "";
  memoryMonitor.stdout.on("data", chunk => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        memorySamples.push(sample);
        appendFileSync(report.windowsMemoryLog, `${JSON.stringify(sample)}\n`);
        const totalPrivate = sample.processes.reduce((sum, item) => sum + item.privateBytes, 0);
        const totalWorkingSet = sample.processes.reduce((sum, item) => sum + item.workingSetBytes, 0);
        report.windowsMemoryPeak = {
          privateBytes: Math.max(report.windowsMemoryPeak?.privateBytes ?? 0, totalPrivate),
          workingSetBytes: Math.max(report.windowsMemoryPeak?.workingSetBytes ?? 0, totalWorkingSet),
          scope: "Sampled descendants of this script's zGIS PID only; working set may count shared pages repeatedly; not a whole-machine peak",
          samples: memorySamples.length,
        };
      } catch { event("memory-monitor-invalid-json"); }
    }
  });
  memoryMonitor.stderr.on("data", () => { report.windowsMemoryMonitorHadStderr = true; });
  memoryMonitor.on("error", error => { event("memory-monitor-error", { code: error.code }); });
}
function observeInvocations() {
  const install = () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals?.invoke) { setTimeout(install, 0); return; }
    if (internals.invoke.__largeSmokeObserved) return;
    const original = internals.invoke;
    const context = performance.timeOrigin;
    let sequence = 0;
    const emit = data => { void window.__nativeLargeInvokeEvent(data).catch(() => {}); };
    const descriptor = Object.getOwnPropertyDescriptor(internals, "invoke");
    if (!descriptor?.writable && !descriptor?.configurable) {
      emit({ context, phase: "observer-unavailable", reason: "invoke-property-is-non-writable-and-non-configurable", writable: Boolean(descriptor?.writable), configurable: Boolean(descriptor?.configurable) });
      return;
    }
    internals.invoke = function (command) {
      const safeCommand = typeof command === "string" && /^[a-zA-Z0-9_:|.-]{1,128}$/.test(command) ? command : "[invalid-command-name]";
      const id = ++sequence;
      const started = performance.now();
      emit({ context, id, phase: "begin", command: safeCommand });
      let pending;
      try { pending = original.apply(this, arguments); }
      catch (error) { emit({ context, id, phase: "end", command: safeCommand, ok: false, durationMs: performance.now() - started }); throw error; }
      return Promise.resolve(pending).then(result => {
        emit({ context, id, phase: "end", command: safeCommand, ok: true, durationMs: performance.now() - started });
        return result;
      }, error => {
        emit({ context, id, phase: "end", command: safeCommand, ok: false, durationMs: performance.now() - started });
        throw error;
      });
    };
    internals.invoke.__largeSmokeObserved = true;
    emit({ context, phase: "observer-installed" });
  };
  install();
}
function observeRecoveryJournal({ skipLarge }) {
  const original = Storage.prototype.setItem;
  if (original.__largeSmokeObserved) return;
  const context = performance.timeOrigin;
  const emit = data => { void window.__nativeLargeJournalEvent({ context, ...data }).catch(() => {}); };
  const wrapped = function (key, value) {
    if (key !== "zgis.editRecovery") return original.apply(this, arguments);
    const chars = typeof value === "string" ? value.length : 0;
    emit({ phase: "begin", chars });
    if (skipLarge && chars > 2 * 1024 * 1024) { emit({ phase: "diagnostic-skipped", chars }); return; }
    const started = performance.now();
    try {
      const result = original.apply(this, arguments);
      emit({ phase: "end", chars, ok: true, durationMs: performance.now() - started });
      return result;
    } catch (error) {
      emit({ phase: "end", chars, ok: false, durationMs: performance.now() - started });
      throw error;
    }
  };
  wrapped.__largeSmokeObserved = true;
  Storage.prototype.setItem = wrapped;
  emit({ phase: "observer-installed", installed: Storage.prototype.setItem === wrapped, diagnosticSkipLarge: skipLarge });
}
function observeIpcFetch({ skipBackup }) {
  const original = window.fetch;
  if (original.__largeSmokeObserved) return;
  const context = performance.timeOrigin;
  let sequence = 0;
  const emit = data => { void window.__nativeLargeFetchEvent({ context, ...data }).catch(() => {}); };
  const wrapped = function (resource) {
    let url;
    try { url = new URL(resource instanceof Request ? resource.url : String(resource), location.href); } catch { return original.apply(this, arguments); }
    if (url.protocol !== "ipc:" && url.hostname !== "ipc.localhost") return original.apply(this, arguments);
    let command;
    try { command = decodeURIComponent(url.pathname.replace(/^\//, "")); } catch { command = "[invalid-command-name]"; }
    if (!/^[a-zA-Z0-9_:|.-]{1,128}$/.test(command)) command = "[invalid-command-name]";
    const id = ++sequence;
    const started = performance.now();
    emit({ id, phase: "begin", command });
    if (skipBackup && command === "save_recovery") {
      emit({ id, phase: "diagnostic-skipped", command });
      return Promise.resolve(new Response("null", { status: 200, headers: { "Tauri-Response": "ok", "content-type": "application/json" } }));
    }
    return original.apply(this, arguments).then(response => {
      // 只观察 fetch Promise 完成，不读取或替换 body/headers/content。
      emit({ id, phase: "response", command, status: response.status, durationMs: performance.now() - started });
      return response;
    }, error => {
      emit({ id, phase: "error", command, durationMs: performance.now() - started });
      throw error;
    });
  };
  wrapped.__largeSmokeObserved = true;
  window.fetch = wrapped;
  emit({ phase: "observer-installed", installed: window.fetch === wrapped, diagnosticSkipBackup: skipBackup });
}
async function nativeFileDialog(path) {
  const helper = spawn("pwsh", ["-NoProfile", "-File", resolve("scripts/native-dialog.ps1"), "-AppPid", String(child.pid), "-FilePath", path], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let message = "";
  helper.stdout.on("data", chunk => { message += chunk; });
  helper.stderr.on("data", chunk => { message += chunk; });
  const [code] = await once(helper, "exit");
  assert.equal(code, 0, `Native dialog helper failed: ${message.trim()}`);
}
async function heapSample() {
  return page.evaluate(() => performance.memory ? {
    usedBytes: performance.memory.usedJSHeapSize,
    totalBytes: performance.memory.totalJSHeapSize,
    limitBytes: performance.memory.jsHeapSizeLimit,
    scope: "Sampled WebView JS heap; excludes Rust, native buffers and GPU; not a peak measurement",
  } : null);
}

try {
  // 启动前检查内嵌身份；运行后再通过本实例 IPC 复核。
  const executableBytes = readFileSync(executable);
  assert.ok(executableBytes.includes(Buffer.from(identifier)), "Refuse executable without the isolated smoke identifier");
  report.executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
  report.executableBytes = executableBytes.length;
  report.scriptPath = fileURLToPath(import.meta.url);
  report.scriptSha256 = await hashFile(report.scriptPath);
  const probe = createServer();
  probe.listen(port, "127.0.0.1");
  await once(probe, "listening");
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  mkdirSync(runOutput, { recursive: true });
  saveReport();

  // 只清理本脚本遗留的隔离原生状态，保留原文件供失败分析。
  // 避免前次异常后自动恢复先于 CDP 接管而耗尽 WebView 内存。
  const recoveryPath = resolve(process.env.LOCALAPPDATA, identifier, "recovery.json");
  if (existsSync(recoveryPath)) {
    const actualRecovery = realpathSync(recoveryPath);
    assert.equal(basename(dirname(actualRecovery)), identifier, "Refuse recovery outside isolated app identity");
    const head = Buffer.alloc(8192);
    const recoveryFile = openSync(actualRecovery, "r");
    const read = readSync(recoveryFile, head, 0, head.length, 0);
    closeSync(recoveryFile);
    const text = head.subarray(0, read).toString("utf8");
    assert.ok(text.includes('"name":"native-large-50000.geojson"') || /"name":"native-50000-note-\d+\.geojson"/.test(text) || /"layers"\s*:\s*\[\s*\]/.test(text), "Refuse resetting unrelated isolated test recovery");
    const backup = resolve(runOutput, "previous-isolated-recovery.json");
    copyFileSync(actualRecovery, backup);
    report.previousIsolatedRecovery = { path: backup, bytes: statSync(backup).size };
    writeFileSync(actualRecovery, JSON.stringify({ version: 3, layers: [], tree: [] }));
    stage("Previous recovery from this smoke is preserved; isolated app starts from an empty test baseline");
  }

  const generatedAt = performance.now();
  report.binaryInput = await generateFixture(binarySample, 2200);
  const sampleBytes = report.binaryInput.bytes;
  assert.ok(sampleBytes > 100 * 1024 * 1024);
  assert.ok(sampleBytes < 256 * 1024 * 1024);
  report.input = importNoteBytes === 2200 ? report.binaryInput : await generateFixture(sample, importNoteBytes);
  stage("Synthetic GeoJSON contains 50,000 real point records and exceeds the former 100 MiB limit", { elapsedMs: performance.now() - generatedAt, bytes: sampleBytes });

  child = spawn(executable, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: resolve(runOutput, "webview"),
    },
  });
  report.processId = child.pid;
  child.on("exit", (code, signal) => { event("child-exit", { code, signal }); });
  sampleOwnedProcessMemory();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Isolated zGIS exited with ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
      break;
    } catch (reason) {
      if (attempt === 99) throw reason;
      await delay(200);
    }
  }
  page = browser.contexts()[0].pages()[0];
  browser.on("disconnected", () => { event("browser-disconnected"); });
  page.setDefaultTimeout(120_000);
  await page.waitForSelector(".app");
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "warning" && message.text().includes("IPC custom protocol failed, Tauri will now use the postMessage interface instead")) event("ipc-custom-protocol-fallback-warning");
  });
  page.on("close", () => { event("page-close"); });
  page.on("crash", () => { report.rendererCrashed = true; event("page-crash"); });
  page.on("worker", worker => {
    event("worker-created");
    worker.on("close", () => { event("worker-closed"); });
  });
  await page.exposeBinding("__nativeLargeInvokeEvent", (_source, data) => { event("invoke", data); });
  await page.exposeBinding("__nativeLargeJournalEvent", (_source, data) => { event("recovery-journal", data); });
  await page.exposeBinding("__nativeLargeFetchEvent", (_source, data) => { event("ipc-fetch", data); });
  await page.addInitScript(observeInvocations);
  await page.evaluate(observeInvocations);
  await page.addInitScript(observeRecoveryJournal, { skipLarge: diagnosticSkipLargeJournal });
  await page.evaluate(observeRecoveryJournal, { skipLarge: diagnosticSkipLargeJournal });
  await page.addInitScript(observeIpcFetch, { skipBackup: diagnosticSkipBackupIpc });
  await page.evaluate(observeIpcFetch, { skipBackup: diagnosticSkipBackupIpc });
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:app|identifier")), identifier, "Refuse production identity");
  report.pageUrl = page.url();
  const isolatedMcp = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const before = await invoke("gis_mcp_status");
    const after = await invoke("gis_mcp_set_enabled", { enabled: false });
    // token/endpoint 不返回、不记录；此命令仅控制已核验身份的本实例。
    return { enabledBefore: before.enabled, disabledAfter: !after.enabled };
  });
  assert.equal(isolatedMcp.disabledAfter, true);
  stage("Isolated native identity and WebView profile verified; only this instance MCP disabled", isolatedMcp);
  await page.evaluate(async () => {
    localStorage.removeItem("zgis.editRecovery");
    localStorage.setItem("zgis.locale", "zh-CN");
    await window.__TAURI_INTERNALS__.invoke("save_recovery", { content: JSON.stringify({ version: 3, layers: [], tree: [] }) });
  });
  await page.reload();
  await page.waitForSelector(".app");
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeEnabled({ timeout: 120_000 });
  report.heapBeforeLoad = await heapSample();

  const openRequest = page.evaluate(async () => {
    const started = performance.now();
    const files = await window.__TAURI_INTERNALS__.invoke("open_files");
    return files.map(file => ({ ...file, hasBytes: Object.hasOwn(file, "bytes"), elapsedMs: performance.now() - started }));
  });
  await nativeFileDialog(binarySample);
  const files = await openRequest;
  assert.equal(files.length, 1);
  assert.equal(files[0].hasBytes, false);
  assert.equal(files[0].size, sampleBytes);
  const binary = await page.evaluate(async (sourceId) => {
    const started = performance.now();
    const raw = await window.__TAURI_INTERNALS__.invoke("read_open_file", { sourceId });
    const bytes = new Uint8Array(raw);
    const head = new TextDecoder().decode(bytes.subarray(0, 40));
    const tail = new TextDecoder().decode(bytes.subarray(-4));
    return { isArrayBuffer: raw instanceof ArrayBuffer, byteLength: bytes.byteLength, head, tail, elapsedMs: performance.now() - started };
  }, files[0].sourceId);
  assert.equal(binary.isArrayBuffer, true);
  assert.equal(binary.byteLength, sampleBytes);
  assert.ok(binary.head.startsWith('{"type":"FeatureCollection","features":['));
  assert.ok(binary.tail.endsWith("]}"));
  stage("Native file dialog returns metadata; binary IPC returns every byte above 100 MiB", { openMetadataMs: files[0].elapsedMs, ...binary });

  // 独立二进制测试不应让旧 ArrayBuffer 持有测试后续导入的额外内存。
  await page.reload();
  await expect(page.getByRole("button", { name: "设置", exact: true })).toBeEnabled({ timeout: 120_000 });
  report.heapAfterBinaryReload = await heapSample();

  await page.exposeBinding("__nativeLargeWorkerEvent", (_source, event) => {
    report.workerEvents ??= [];
    report.workerEvents.push({ ...event, at: new Date().toISOString() });
    events.push({ event: "worker-message", ...event, at: new Date().toISOString(), elapsedMs: performance.now(), cleanup: cleanupStarted });
    appendFileSync(resolve(runOutput, "events.jsonl"), `${JSON.stringify(events.at(-1))}\n`);
    saveReport();
  });
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        void window.__nativeLargeWorkerEvent({ phase: "created" });
        this.addEventListener("message", ({ data }) => {
          void window.__nativeLargeWorkerEvent({ phase: data.error ? "error" : "result", features: data.layers?.[0]?.features?.length, error: data.error });
        });
        this.addEventListener("error", (error) => { void window.__nativeLargeWorkerEvent({ phase: "worker-error", message: error.message }); });
      }
    };
  });

  const importStarted = performance.now();
  const menu = page.locator(".app-header .header-menu").filter({ has: page.locator("summary", { hasText: /^文件$/ }) });
  await menu.locator("summary").click();
  const chooseInput = nativeFileDialog(sample);
  await menu.getByRole("button", { name: "打开", exact: true }).click();
  await chooseInput;
  await expect(page.getByRole("dialog", { name: "文件导入", exact: true })).toBeVisible({ timeout: 120_000 });
  stage("Real native file menu displays import configuration", { bytes: report.input.bytes, elapsedMs: performance.now() - importStarted });
  await page.getByRole("button", { name: "导入", exact: true }).click();
  event("import-click-completed");
  stage("Import button accepted; awaiting real Worker result and layer display", { elapsedMs: performance.now() - importStarted });
  await expect(page.locator(".layer-text")).toHaveCount(1, { timeout: 180_000 });
  event("layer-count-one-confirmed");
  event("dialog-count-check-begin");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  event("dialog-count-zero-confirmed");
  await expect(page.locator(".map-surface")).toHaveAttribute("aria-busy", "false");
  event("map-sync-finished");
  const importedMs = performance.now() - importStarted;
  await page.getByRole("button", { name: "展开属性表", exact: true }).click();
  await expect(page.locator(".attribute-panel .count")).toHaveText(String(count));
  const searchStarted = performance.now();
  await page.getByRole("textbox", { name: "搜索属性", exact: true }).fill(marker);
  await expect(page.locator(".attribute-panel tbody tr")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.locator(".attribute-panel tbody tr")).toContainText(marker);
  stage("Real file menu imports 50,000 records and attribute search finds the final record", { importElapsedMs: importedMs, lastRecordSearchMs: performance.now() - searchStarted });
  report.heapAfterLoad = await heapSample();
  await page.screenshot({ path: resolve(runOutput, "import-last-record.png") });

  if (!diagnosticSkipBackupIpc) {
  const recoveryStarted = performance.now();
  let recovery;
  for (let attempt = 0; attempt < 30; attempt++) {
    recovery = await page.evaluate(async () => {
      const response = await window.__TAURI_INTERNALS__.invoke("load_recovery");
      const nativeBinary = response instanceof ArrayBuffer;
      const raw = nativeBinary ? new TextDecoder().decode(response) : response;
      const saved = raw ? JSON.parse(raw) : null;
      const layer = saved?.layers?.[0];
      let bytes = nativeBinary ? response.byteLength : 0;
      // 旧 string 契约也不为计数再分配一份百 MB 的 Uint8Array。
      if (!nativeBinary && raw) for (let index = 0; index < raw.length; index++) {
        const point = raw.codePointAt(index);
        bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        if (point > 0xffff) index++;
      }
      return { bytes, nativeBinary, layerCount: saved?.layers?.length ?? 0, features: layer?.features?.length ?? 0, last: layer?.features?.at(-1)?.properties?.name, noteBytes: layer?.features?.at(-1)?.properties?.note?.length };
    });
    if (recovery.features === count) break;
    await delay(500);
  }
  assert.equal(recovery.layerCount, 1);
  assert.equal(recovery.features, count);
  assert.equal(recovery.last, marker);
  assert.equal(recovery.noteBytes, importNoteBytes);
  if (importNoteBytes === 2200) assert.ok(recovery.bytes > 100 * 1024 * 1024);
  stage("Native recovery file persists the complete imported layer and final full attribute", { elapsedMs: performance.now() - recoveryStarted, ...recovery });

  const reloadStarted = performance.now();
  await page.reload();
  await expect(page.locator(".layer-text")).toHaveCount(1, { timeout: 180_000 });
  await expect(page.locator(".map-surface")).toHaveAttribute("aria-busy", "false");
  const expand = page.getByRole("button", { name: "展开属性表", exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".attribute-panel .count")).toHaveText(String(count));
  await page.getByRole("textbox", { name: "搜索属性", exact: true }).fill(marker);
  await expect(page.locator(".attribute-panel tbody tr")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.locator(".attribute-panel tbody tr")).toContainText(marker);
  stage("Real WebView reload restores all 50,000 records and the final searchable record", { elapsedMs: performance.now() - reloadStarted });
  report.heapAfterReload = await heapSample();
  await page.screenshot({ path: resolve(runOutput, "restored-last-record.png") });

  const saveStarted = performance.now();
  const savedName = `${marker}-saved`;
  await page.getByRole("button", { name: "编辑属性", exact: true }).click();
  await page.locator(".attribute-panel tbody tr").first().click();
  await page.locator('.attribute-panel td[data-field="name"]').first().dblclick();
  await page.getByLabel("属性 name", { exact: true }).fill(savedName);
  await page.keyboard.press("Enter");
  await expect(page.locator(".attribute-panel tbody tr")).toContainText(savedName);
  const save = page.getByRole("toolbar", { name: "地图工具", exact: true }).getByRole("button", { name: "保存编辑", exact: true });
  await expect(save).toBeEnabled();
  event("save-edited-source-begin");
  await save.click();
  await expect(page.locator(".operation-status")).toContainText("源文件已保存", { timeout: 180_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  report.savedOutput = await verifySavedFixture(sample, savedName);
  assert.notEqual(report.savedOutput.sha256, report.input.sha256, "Edited source must have a different content hash");
  stage("Real UI edit and source save preserve every record, full long attributes and all geometries on disk", {
    elapsedMs: performance.now() - saveStarted, beforeSha256: report.input.sha256, ...report.savedOutput,
  });
  report.heapAfterSourceSave = await heapSample();
  await page.screenshot({ path: resolve(runOutput, "saved-last-record.png") });
  } else {
    stage("Diagnostic only: native backup IPC mocked; persistence and reload intentionally remain unverified");
  }
  assert.deepEqual(errors, []);
  report.success = true;
  report.productValidationComplete = importNoteBytes === 2200 && !diagnosticSkipLargeJournal && !diagnosticSkipBackupIpc;
  report.limitations = ["Synthetic 50,000-point GeoJSON only; not arbitrary complex geometry or arbitrary 256 MiB files", "Debug binary with isolated identity; no production installation or macOS coverage", "No real database performance coverage", "Heap samples are not process peak memory measurements"];
  if (importNoteBytes !== 2200) report.limitations.push("Binary IPC and import use distinct fixtures in this run; successful binary transfer does not establish that the >100 MiB fixture can be imported or restored");
  if (diagnosticSkipLargeJournal) report.limitations.push("Diagnostic injection skipped oversized localStorage journal writes; this run does not establish unmodified product stability");
  if (diagnosticSkipBackupIpc) report.limitations.push("Diagnostic injection mocked save_recovery IPC success; this run cannot establish native persistence or unmodified product stability");
  saveReport();
  console.log(`${report.productValidationComplete ? "PASS native large-file smoke" : "DIAGNOSTIC selected paths passed; unmodified product remains unverified"}: binary ${sampleBytes} bytes; imported ${report.input.bytes} bytes / ${count} features; report ${resolve(runOutput, "report.json")}`);
} catch (reason) {
  if (statSafe(runOutput)) event("failure", { name: reason?.name });
  report.failure = reason?.stack ?? String(reason);
  report.childExitCodeBeforeCleanup = child?.exitCode;
  report.childSignalBeforeCleanup = child?.signalCode;
  if (page) await page.screenshot({ path: resolve(runOutput, "failure.png"), timeout: 15_000 }).catch(() => {});
  if (statSafe(runOutput)) saveReport();
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  cleanupStarted = true;
  if (statSafe(runOutput)) event("cleanup-started");
  memoryMonitor?.kill();
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      const cleanup = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      cleanup.on("exit", resolve);
      cleanup.on("error", resolve);
    });
  }
  await browser?.close().catch(() => {});
  const finalRecoveryPath = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, identifier, "recovery.json") : null;
  if (finalRecoveryPath && existsSync(finalRecoveryPath)) report.finalIsolatedRecoveryStat = { bytes: statSync(finalRecoveryPath).size, modifiedAt: statSync(finalRecoveryPath).mtime.toISOString() };
  if (statSafe(runOutput)) saveReport();
}
function statSafe(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
