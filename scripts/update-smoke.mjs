import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [phase, pid, expectedVersion, directory] = process.argv.slice(2);
if (!['install', 'verify'].includes(phase) || !pid || !expectedVersion || !directory)
  throw new Error('Usage: update-smoke.mjs install|verify PID EXPECTED_VERSION OUTPUT_DIRECTORY');
const output = resolve(directory);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
let browser;
for (let attempt = 0; attempt < 150; attempt++) {
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9227'); break; }
  catch (error) { if (attempt === 149) throw error; await new Promise(r => setTimeout(r, 200)); }
}
const page = browser.contexts()[0].pages().find(p => p.url().includes('tauri')) ?? browser.contexts()[0].pages()[0];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.waitForSelector('.app');
try {
  if (phase === 'install') {
    const fixture = resolve(output, 'update-recovery.geojson');
    writeFileSync(fixture, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'update-1', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: '更新覆盖恢复测试' } }] }));
    const dialog = new Promise((res, rej) => {
      const child = spawn('pwsh', ['-NoProfile', '-File', resolve(scriptRoot, 'native-dialog.ps1'), '-AppPid', pid, '-FilePath', fixture], { windowsHide: true });
      let log = '';
      child.stdout.on('data', d => log += d);
      child.stderr.on('data', d => log += d);
      child.on('error', rej);
      child.on('exit', code => code === 0 ? res() : rej(new Error(log)));
    });
    await page.locator('.app-header summary').filter({ hasText: /^文件$/ }).click();
    await page.locator('.app-header').getByRole('button', { name: '打开', exact: true }).click();
    await dialog;
    await page.getByRole('button', { name: '导入', exact: true }).click();
    await expect(page.locator('[data-node-kind="layer"]')).toHaveCount(1);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '关于', exact: true }).click();
    const about = page.locator('.settings-about');
    const beforeText = await about.innerText();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(about).toContainText(`发现新版本 v${expectedVersion}`, { timeout: 60000 });
    await page.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(page.getByRole('button', { name: '覆盖安装并重启', exact: true })).toBeEnabled({ timeout: 300000 });
    const preferences = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_preferences'));
    if (!preferences) throw new Error('App did not persist basemap preferences before updating');
    const cacheDirectory = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory', { directory: 16 }));
    writeFileSync(resolve(output, 'before.json'), JSON.stringify({ beforeText, preferences, cacheDirectory, installRequestedAt: Date.now(), errors }, null, 2));
    await page.screenshot({ path: resolve(output, 'update-ready.png') });
    const closed = page.waitForEvent('close', { timeout: 60000 });
    await page.getByRole('button', { name: '覆盖安装并重启', exact: true }).click();
    await closed;
    console.log('PASS: real release check, download and UI install/restart request');
  } else {
    await page.waitForFunction(() => document.querySelector('.operation-status')?.textContent?.includes('已恢复'), null, { timeout: 30000 });
    await expect(page.locator('[data-node-kind="layer"]')).toHaveCount(1);
    const before = JSON.parse(readFileSync(resolve(output, 'before.json'), 'utf8'));
    const preferences = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_preferences'));
    expect(JSON.parse(preferences)).toEqual(JSON.parse(before.preferences));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '关于', exact: true }).click();
    await expect(page.locator('.settings-about .about-settings-card').first().locator('.about-settings-value')).toHaveText(`v${expectedVersion}`);
    await page.screenshot({ path: resolve(output, 'update-restarted.png') });
    await page.getByRole('button', { name: '返回地图', exact: true }).click();
    const closed = page.waitForEvent('close');
    await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
    // 浏览态直接保存并关闭；编辑态才需要退出确认。
    await closed;
    expect(errors).toEqual([]);
    expect(before.errors).toEqual([]);
    writeFileSync(resolve(output, 'ui-report.json'), JSON.stringify({ success: true, version: expectedVersion, restoredLayers: 1, preferencesRetained: true, errors }, null, 2));
    console.log('PASS: updated runtime version, automatic workspace recovery and preferences retention');
  }
} finally { await browser.close().catch(() => {}); }
