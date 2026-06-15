'use strict';

/**
 * End-to-end QA for the not-a-robot MCP server, from a real MCP client's view.
 * Transport is WebSocket (binary frames down, JSON taps up). Local only (tunnel
 * off) so it's fast + deterministic. Requires a CDP Chrome at CDP_URL with a page.
 */

const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { CdpSession } = require('../src/relay.js');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const TARGET = process.env.CDP_TARGET || 'recaptcha/api2/demo';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}
function waitFor(cond, ms) {
  return new Promise((resolve) => { const t0 = Date.now(); const i = setInterval(() => { if (cond() || Date.now() - t0 > ms) { clearInterval(i); resolve(cond()); } }, 50); });
}

async function resetPageToken() {
  const targets = JSON.parse((await httpGet(`${CDP_URL.replace(/\/$/, '')}/json`)).body);
  const demo = targets.find((t) => (t.url || '').includes(TARGET)) || targets.find((t) => t.type === 'page');
  if (!demo) return;
  const cdp = new CdpSession(demo.webSocketDebuggerUrl, () => {});
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Runtime.evaluate', {
    expression:
      "(function(){var t=document.querySelector('textarea[id^=\"g-recaptcha-response\"]');if(t)t.value='';" +
      "try{if(typeof grecaptcha!=='undefined'&&grecaptcha.reset)grecaptcha.reset();}catch(e){}return true;})()",
    returnByValue: true,
  });
  cdp.close();
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; console.error('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, NOT_A_ROBOT_TUNNEL: 'off' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'hg-e2e', version: '0.0.0' });
  await client.connect(transport);
  console.error('connected to MCP server\n');

  await resetPageToken();

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  ok(names.includes('start_human_relay') && names.includes('await_human_solve'), `tools listed: ${names.join(', ')}`);

  const startRes = await client.callTool({ name: 'start_human_relay', arguments: { cdpUrl: CDP_URL, targetUrl: TARGET } });
  const relayUrl = startRes.structuredContent && startRes.structuredContent.relayUrl;
  ok(!!relayUrl && /^http:\/\//.test(relayUrl), `start_human_relay -> relayUrl: ${relayUrl}`);
  if (!relayUrl) { console.error('cannot continue without relayUrl'); await client.close(); process.exit(1); }

  const page = await httpGet(relayUrl);
  ok(page.status === 200 && /WebSocket/.test(page.body), 'relay page uses the WebSocket transport');

  const wsUrl = relayUrl.replace(/^http/, 'ws') + 'ws';
  const ws = new WebSocket(wsUrl);
  let gotFrame = false, gotSolved = false;
  ws.on('message', (data, isBinary) => {
    if (isBinary) gotFrame = true;
    else { try { if (JSON.parse(data.toString()).type === 'solved') gotSolved = true; } catch { /* noop */ } }
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await waitFor(() => gotFrame, 6000);
  ok(gotFrame, 'WS streamed a binary screencast frame');

  ws.send(JSON.stringify({ nx: 0.5, ny: 0.5 }));
  await new Promise((r) => setTimeout(r, 300));
  ok(ws.readyState === WebSocket.OPEN, 'tap sent over WS (forwarded), relay still connected');

  const t0 = Date.now();
  const awaitMiss = await client.callTool({ name: 'await_human_solve', arguments: { timeoutMs: 2500 } });
  const missed = awaitMiss.structuredContent && awaitMiss.structuredContent.passed;
  ok(missed === false && Date.now() - t0 >= 2000, 'await_human_solve -> { passed:false } on timeout (no solver)');

  const targets = JSON.parse((await httpGet(`${CDP_URL.replace(/\/$/, '')}/json`)).body);
  const demo = targets.find((t) => (t.url || '').includes(TARGET)) || targets.find((t) => t.type === 'page');
  const inj = new CdpSession(demo.webSocketDebuggerUrl, () => {});
  await inj.connect();
  await inj.send('Runtime.enable');
  await inj.send('Runtime.evaluate', {
    expression:
      "(function(){var t=document.querySelector('textarea[id^=\"g-recaptcha-response\"]');" +
      "if(!t){t=document.createElement('textarea');t.id='g-recaptcha-response';t.style.display='none';document.body.appendChild(t);}" +
      "t.value='E2E_FAKE_TOKEN_'+Date.now();return t.value;})()",
    returnByValue: true,
  });
  inj.close();

  const awaitHit = await client.callTool({ name: 'await_human_solve', arguments: { timeoutMs: 6000 } });
  const hit = awaitHit.structuredContent && awaitHit.structuredContent.passed;
  ok(hit === true, 'await_human_solve -> { passed:true } once the token appears');
  await waitFor(() => gotSolved, 2000);
  ok(gotSolved, 'WS received { type:solved } before the relay closed');

  try { ws.close(); } catch { /* noop */ }
  await client.close();
  console.error(`\nE2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
