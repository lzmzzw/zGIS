import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';

const ipc = (page, command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const cliLabels = { codex: 'Codex CLI', claudeCode: 'Claude Code CLI' };
const claudeFiles = ['zgis-instructions.txt', 'zgis-mcp.json', 'zgis-settings.json'];
const toolCount = /\b(?:33\s+tools|tools:\s*33)\b/i;
const mcpCompletion = /^[ \t]*[›❯]?[ \t]*\/mcp[ \t]+(?:list|manage|show|view)\b[^\n]*\bMCP\b/im;

async function waitFor(label, check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function connectionRefused(endpoint) {
  const { hostname, port } = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port) });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Timed out probing stopped MCP listener')); });
  });
}

// The existing installed smoke remains Codex-only. Run the dual flow separately
// on an isolated native instance with disposable CLI profiles: trust decisions
// can persist in CLI config, not just the app-owned workspace. The caller owns
// WebView2/CDP attachment and app startup/cleanup; this helper starts no app.
export async function agentNativeSmoke(page, {
  includeClaude = false,
  privateCliProfiles = process.env.ZGIS_SMOKE_PRIVATE_CLI_PROFILES === '1',
} = {}) {
  assert.ok(!includeClaude || privateCliProfiles, 'Dual CLI smoke requires disposable CLI profiles');
  const current = () => ipc(page, 'agent_current');
  const panel = page.locator('.gis-agent-panel');
  const stop = button(panel, '停止会话');
  const terminalRows = panel.locator('.xterm-rows > div');
  let session;
  const write = data => ipc(page, 'agent_write', { sessionId: session.sessionId, data });

  async function idleChoices() {
    for (const name of Object.values(cliLabels)) await expect(button(panel, name)).toBeEnabled();
    await expect(stop).toHaveCount(0);
  }

  async function start(cli) {
    await button(panel, cliLabels[cli]).click();
    await waitFor(`${cliLabels[cli]} starts`, async () => {
      session = await current();
      if (await panel.getByRole('alert').count()) throw new Error(`${cliLabels[cli]} could not start (Agent sidebar reports an error)`);
      if (!session) return false;
      assert.equal(session.cli, cli);
      assert.equal(session.running, true, `${cliLabels[cli]} exited during startup`);
      return true;
    });
    await expect(stop).toBeEnabled();
    for (const name of Object.values(cliLabels)) await expect(button(panel, name)).toHaveCount(0);
    return session.sessionId;
  }

  async function waitForScreen(label, predicate) {
    return waitFor(`${cliLabels[session.cli]}: ${label}`, async () => {
      const info = await current();
      assert.ok(info?.running && info.sessionId === session.sessionId, `${cliLabels[session.cli]} exited while waiting for ${label}`);
      // Inspect the current xterm rendering rather than raw PTY history: repaints
      // can leave stale prompts and partial text in the history. Never log rows.
      const screen = (await terminalRows.allTextContents()).join('\n').replace(/ /g, ' ');
      return predicate(screen);
    });
  }

  async function allowWorkspaceTrust() {
    assert.ok(privateCliProfiles, 'Refusing to persist workspace trust in a non-disposable CLI profile');
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/i);
    const appLocalData = await ipc(page, 'plugin:path|resolve_directory', { directory: 15 }); // AppLocalData
    const sessions = join(appLocalData, 'agent-sessions');
    const workspace = join(sessions, session.sessionId);
    for (const path of [sessions, workspace]) {
      assert.ok((await lstat(path)).isDirectory(), 'Refusing to trust a redirected Agent workspace');
    }
    const files = await readdir(workspace, { withFileTypes: true });
    const expected = session.cli === 'claudeCode' ? claudeFiles : [];
    assert.ok(files.length === expected.length && files.every(file => file.isFile() && expected.includes(file.name)),
      'Refusing to trust an Agent workspace containing anything other than its app-owned bootstrap files');
    await write('\r');
  }

  async function discover() {
    const codex = session.cli === 'codex';
    const trust = (screen) => codex
      ? /trust (?:this directory|and continue)/i.test(screen) && /[›❯]\s*(?:1[.)]\s+)?(?:Yes, continue|Trust and continue)\b/i.test(screen)
      : /[›❯]\s*1[.)]\s+Yes, I trust this folder/i.test(screen);
    const prompt = (screen) => /^\s*[›❯](?:[ \t]*$|[ \t]+(?:Ask Codex\b|Try ["“]))/mi.test(screen);
    const setup = await waitForScreen('workspace trust or ready input', screen => trust(screen) ? 'trust' : prompt(screen) && 'ready');
    if (setup === 'trust') {
      await allowWorkspaceTrust();
      await waitForScreen('ready input after private workspace trust', screen => !trust(screen) && prompt(screen));
    }
    await write('/mcp');
    // Do not press Enter if the CLI doesn't recognize the slash command. Some
    // versions submit unrecognized slash strings as model prompts.
    await waitForScreen('recognized /mcp command completion (not submitted)', screen => mcpCompletion.test(screen));
    await write('\r');
    const result = await waitForScreen('zgis MCP discovery', screen => {
      if (/\bzgis\b/i.test(screen) && (toolCount.test(screen) || /\b(?:spatial_query|mcp__zgis__spatial_query)\b/i.test(screen))) return 'tools';
      if (!codex && /[❯›]\s*(?:1[.)]\s+)?zgis\s+(?:[✓✔]\s*)?connected\b/i.test(screen)) return 'selected';
      return false;
    });
    if (result === 'selected') {
      // Claude displays the server list first. Enter only on the selected,
      // connected zgis row to open local server details, never on a chat input.
      await write('\r');
      await waitForScreen('zgis MCP tool count', screen => /\bzgis\b/i.test(screen) && toolCount.test(screen));
    }
  }

  assert.equal(await current(), null, 'Agent smoke requires a fresh app with no existing Agent session');
  const mcp = () => ipc(page, 'gis_mcp_status').then(({ enabled, endpoint }) => ({ enabled, endpoint }));
  const { enabled, endpoint } = await mcp();
  assert.equal(enabled, true, 'MCP must already be running in the isolated app');
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  await button(page, 'Agent').click();
  await idleChoices();
  try {
    const codexId = await start('codex');
    await discover();
    if (includeClaude) {
      await stop.click();
      await waitFor('Codex session disposed by Stop Session', async () => await current() === null);
      session = undefined;
      await idleChoices();

      const claudeId = await start('claudeCode');
      assert.notEqual(claudeId, codexId, 'Claude Code must get a new PTY session');
      await discover();
    }

    const activeCli = cliLabels[session.cli];
    assert.equal((await current())?.running, true, `${activeCli} must still be running before stopping MCP`);
    await button(page, '设置').click();
    await button(page, 'MCP').click();
    await button(page, '停止 MCP').click();
    await button(page, '启用 MCP').waitFor({ state: 'visible' });
    await waitFor(`${activeCli} session disposed by MCP shutdown`, async () => await current() === null);
    session = undefined;
    assert.equal((await mcp()).enabled, false);
    await waitFor('MCP stops accepting loopback connections', () => connectionRefused(endpoint));
    await button(page, '返回地图').click();
    await idleChoices();
    await panel.getByTitle('隐藏侧栏，保留会话').click();
  } finally {
    if (session && (await current())?.sessionId === session.sessionId) {
      await ipc(page, 'agent_close', { sessionId: session.sessionId });
    }
  }
  console.log(includeClaude
    ? 'PASS: native Agent selection, Codex /mcp and Stop Session, Claude Code /mcp, Agent disposal on MCP shutdown, and closed loopback listener (no model prompts)'
    : 'PASS: native Agent choices, Codex /mcp, Agent disposal on MCP shutdown, and closed loopback listener (no model prompts)');
}

export async function mcpNativeSmoke(page, nativeDialog, fileAction) {
  const opening = nativeDialog('output/smoke/fixtures/native.geojson');
  await fileAction('打开'); await opening;
  await page.getByRole('button', {name:'导入',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  await page.getByRole('button', {name:'设置',exact:true}).click();
  await page.getByRole('button', {name:'MCP',exact:true}).click();
  await page.getByRole('button', {name:'停止 MCP',exact:true}).waitFor();
  const status = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('gis_mcp_status'));
  let seq = 0;
  async function rpc(method, params) {
    const response = await fetch(status.endpoint, {method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${status.token}`},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params})});
    assert.equal(response.status,200);
    const body = await response.json();
    assert.equal(body.error,undefined);
    return body.result;
  }
  async function call(name,args={}) {
    const result = await rpc('tools/call',{name,arguments:args});
    assert.ok(!result.isError,`${name}: ${result.content?.[0]?.text ?? 'failed'}`);
    return JSON.parse(result.content[0].text);
  }
  assert.equal((await fetch(status.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(status.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${status.token}`,Origin:'https://evil.invalid'},body:'{}'})).status,403);
  await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'zgis-smoke',version:'1'}});
  assert.equal((await rpc('tools/list')).tools.length,33);
  let layers;
  for(let i=0;i<40;i++) { layers=await call('list_layers'); if(layers.layers.length===1)break; await page.waitForTimeout(100); }
  assert.equal(layers.layers.length,1);
  const layerId = layers.layers[0].id;
  const original = await call('read_features',{layerId});
  const selected = await call('spatial_query',{source:{layerId},bbox:[115,38,118,42]});
  assert.equal(selected.featureCount,1);
  await call('topology_check',{source:{layerId}});
  const buffered = await call('buffer',{source:{resultId:selected.resultId},distanceMeters:100});
  await call('publish_result',{resultId:buffered.resultId,name:'原生 MCP 缓冲'});
  // 设置页隐藏地图；结果暂存到返回地图后导入，不在隐藏页等待图层 DOM。
  await page.getByRole('button',{name:'返回地图',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-node-kind="layer"]').length===2);
  assert.deepEqual(await call('read_features',{layerId}),original);
  const path = resolve('output/smoke/fixtures/cities.zip');
  assert.equal(await page.getByRole('button',{name:'选择可读文件…',exact:true}).count(),0);
  const loaded = await call('load_vector_file',{path,crs:'EPSG:4326'});
  assert.equal(loaded.featureCount,2);
  assert.match(JSON.stringify(await call('read_result',{resultId:loaded.resultId})),/北京/);
  await agentNativeSmoke(page);
  await fileAction('移除图层');
  await page.getByRole('button',{name:'放弃并移除',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-node-kind="layer"]').length===1);
  await page.locator('[data-node-kind="layer"]').first().click();
  await fileAction('移除图层');
  await page.waitForFunction(() => document.querySelectorAll('[data-node-kind="layer"]').length===0);
  console.log('PASS: native authenticated MCP, 33 tools, chained buffer/publication, source preservation, direct external-file loading/Chinese SHP ZIP, live Codex PTY and shutdown');
}
