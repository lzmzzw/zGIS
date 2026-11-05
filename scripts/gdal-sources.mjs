import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import { lockPath, repository, safeRelativePath, sha256 } from "./gdal-runtime.mjs";
import { applySourceProfile } from "./gdal-profile.mjs";

export function systemDownloadArguments() {
  if (process.platform !== "win32") return [];
  // Never print registry proxy configuration; only use an explicitly loopback endpoint without credentials.
  const script = "$p=Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings' -ErrorAction SilentlyContinue; if($p.ProxyEnable -eq 1 -and $p.ProxyServer -match '^(?:http://)?(?:127\\.0\\.0\\.1|localhost):[0-9]+$'){[Console]::Write($p.ProxyServer)}";
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const proxy = result.status === 0 ? result.stdout.trim() : "";
  return proxy ? ["--proxy", `http://${proxy.replace(/^http:\/\//, "")}`, "--ssl-revoke-best-effort"] : [];
}

export function download(url, destination, expectedHash, { timeout = 900 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Download requires a pinned SHA-256");
  if (fs.existsSync(destination) && sha256(fs.readFileSync(destination)) === expectedHash) return destination;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.download`;
  const downloaded = spawnSync("curl", ["--fail", "--location", "--silent", "--show-error", "--retry", "4", "--retry-all-errors", "--connect-timeout", "20", "--max-time", String(timeout), "--continue-at", "-", ...systemDownloadArguments(), "--output", temporary, url], { stdio: "inherit", shell: false, windowsHide: true });
  if (downloaded.status !== 0) throw new Error(`Source download failed: ${new URL(url).hostname}`);
  if (sha256(fs.readFileSync(temporary)) !== expectedHash) {
    fs.rmSync(temporary);
    throw new Error(`Source SHA-256 mismatch: ${path.basename(destination)}`);
  }
  fs.renameSync(temporary, destination);
  return destination;
}

export function ensureSources() {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const base = path.join(repository, "output/gdal-build/sources");
  const result = { lock, root: base };
  fs.mkdirSync(base, { recursive: true });
  for (const [name, source] of Object.entries(lock.sources)) {
    const archive = download(source.url, path.join(repository, "output/gdal-sources", source.filename), source.sha256);
    const directory = path.join(base, source.directory);
    const marker = path.join(directory, ".zgis-source-sha256");
    if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim() !== source.sha256) {
      // Validate archive paths before extraction; no absolute or parent traversal is accepted.
      if (source.filename.endsWith(".zip")) {
        const entries = unzipSync(fs.readFileSync(archive));
        for (const [entry, bytes] of Object.entries(entries)) {
          if (entry.endsWith("/")) continue;
          safeRelativePath(entry);
          if (!entry.startsWith(`${source.directory}/`)) throw new Error("Unexpected source archive root");
          const output = path.join(base, entry);
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, bytes);
        }
      } else {
        const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        if (listing.status !== 0) throw new Error("Cannot inspect source archive");
        for (const entry of listing.stdout.trim().split(/\r?\n/)) {
          const item = entry.replace(/\/$/, "");
          safeRelativePath(item);
          if (item !== source.directory && !item.startsWith(`${source.directory}/`)) throw new Error("Unexpected source archive root");
        }
        const extracted = spawnSync("tar", ["-xzf", archive, "-C", base], { stdio: "inherit" });
        if (extracted.status !== 0) throw new Error("Cannot extract source archive");
      }
      fs.writeFileSync(marker, `${source.sha256}\n`);
    }
    result[name] = directory;
  }
  applySourceProfile(result.gdal);
  return result;
}
