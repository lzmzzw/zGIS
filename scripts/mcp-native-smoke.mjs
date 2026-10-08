import assert from 'node:assert/strict';
import { resolve } from 'node:path';
export async function mcpNativeSmoke(page, nativeDialog, fileAction) {
  const plain = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  async function waitIPC(command, predicate, args = {}) {
    let last;
    for (let i = 0; i < 150; i++) {
      const value = await page.evaluate(({command,args}) => window.__TAURI_INTERNALS__.invoke(command,args), {command,args});
      last = value;
      if (predicate(value)) return value;
      await page.waitForTimeout(200);
    }
    const diagnostic = command === 'agent_read' ? plain(last?.data ?? '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[email]').replace(/https?:\/\/\S+/g,'[url]').replace(/[A-Za-z]:\\[^\r\n]*/g,'[path]').replace(/[A-Za-z0-9_=-]{24,}/g,'[identifier]').slice(-1200) : '';
    throw new Error(`Timed out waiting for ${command}: ${diagnostic}`);
  }
  const opening = nativeDialog('output/smoke/fixtures/native.geojson');
  await fileAction('打开文件'); await opening;
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
  assert.equal((await rpc('tools/list')).tools.length,28);
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
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length===2);
  assert.deepEqual(await call('read_features',{layerId}),original);
  const path = resolve('output/smoke/fixtures/cities.zip');
  assert.equal(await page.getByRole('button',{name:'选择可读文件…',exact:true}).count(),0);
  const loaded = await call('load_vector_file',{path,crs:'EPSG:4326'});
  assert.equal(loaded.featureCount,2);
  assert.match(JSON.stringify(await call('read_result',{resultId:loaded.resultId})),/北京/);
  await page.getByRole('button',{name:'返回地图',exact:true}).click();
  await page.getByRole('button',{name:'Codex Agent',exact:true}).click();
  await page.getByRole('button',{name:'连接 Codex',exact:true}).click();
  await page.getByRole('button',{name:'停止会话',exact:true}).waitFor({state:'visible'});
  const agent = await waitIPC('agent_current', value => value?.running);
  const greeting = await waitIPC('agent_read', value => /OpenAI Codex|update|context left|›/i.test(plain(value.data)), {sessionId:agent.sessionId});
  // Skip the CLI's optional update prompt; never update the user's CLI in this test.
  if (/update/i.test(plain(greeting.data)) && /skip/i.test(plain(greeting.data))) {
    await page.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('agent_write',{sessionId,data:'\x1b[B\r'}), agent.sessionId);
  }
  await page.waitForTimeout(1500);
  const onboarding = await page.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('agent_read',{sessionId}), agent.sessionId);
  if (/trust/i.test(plain(onboarding.data)) && /continue/i.test(plain(onboarding.data))) {
    // This session's cwd is the empty app-owned folder, with read-only sandbox retained.
    await page.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('agent_write',{sessionId,data:'\r'}), agent.sessionId);
    await page.waitForTimeout(1000);
  }
  await page.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('agent_write',{sessionId,data:'/mcp'}), agent.sessionId);
  await page.waitForTimeout(300);
  await page.evaluate(sessionId => window.__TAURI_INTERNALS__.invoke('agent_write',{sessionId,data:'\r'}), agent.sessionId);
  await waitIPC('agent_read', value => {
    const text = plain(value.data);
    return /zgis/.test(text) && /spatial_query|28\s*tools|tools:\s*28/i.test(text);
  }, {sessionId:agent.sessionId});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'MCP',exact:true}).click();
  await page.getByRole('button',{name:'停止 MCP',exact:true}).click();
  await waitIPC('agent_current', value => !value?.running);
  await page.getByRole('button',{name:'返回地图',exact:true}).click();
  await page.getByTitle('隐藏侧栏，保留会话').click();
  await fileAction('移除图层');
  await page.getByRole('button',{name:'放弃并移除',exact:true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length===1);
  await page.locator('.layer-row').first().click();
  await fileAction('移除图层');
  await page.waitForFunction(() => document.querySelectorAll('.layer-row').length===0);
  console.log('PASS: native authenticated MCP, 28 tools, chained buffer/publication, source preservation, direct external-file loading/Chinese SHP ZIP, live Codex PTY and shutdown');
}
