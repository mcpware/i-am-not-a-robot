'use strict';

/**
 * End-to-end QA for the human-gate MCP server, from a real MCP client's view.
 *
 * Spawns the stdio server, connects an MCP client, and drives the full flow a
 * human user's agent would trigger:
 *   1. tools/list shows both tools
 *   2. start_human_relay -> relayUrl
 *   3. the relay page serves HTML
 *   4. the SSE /stream pushes a real screencast frame
 *   5. a tap POST is forwarded (Input.dispatchMouseEvent) without error
 *   6. await_human_solve returns { passed:false } on timeout (nobody solved)
 *   7. inject a token into the page -> await_human_solve returns { passed:true }
 *
 * Requires a CDP Chrome at CDP_URL (default http://localhost:9222) with a page
 * open (default the reCAPTCHA demo). Start one with:
 *   google-chrome --remote-debugging-port=9222 --user-data-dir=~/.config/chrome-cdp-profile \
 *     https://www.google.com/recaptcha/api2/demo
 */

const http = require('http');
const path = require('path');
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

// Open the SSE stream and resolve once we see one `data:` frame (or after ms).
function streamFirstFrame(url, ms = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = '';
      const done = (gotData) => { clearTimeout(t); try { req.destroy(); } catch { /* noop */ } resolve({ status: res.statusCode, gotData, bytes: b.length }); };
      const t = setTimeout(() => done(/data: /.test(b)), ms);
      res.on('data', (c) => { b += c.toString(); if (/data: [A-Za-z0-9+/]/.test(b)) done(true); });
    });
    req.on('error', reject);
  });
}

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    req.on('error', reject);
    req.end(data);
  });
}

// Reset the demo page to a clean state so the run is idempotent (a prior run
// may have left a token in the textarea, which would break the timeout step).
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
    env: { ...process.env, HUMAN_GATE_TUNNEL: 'off' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'hg-e2e', version: '0.0.0' });
  await client.connect(transport);
  console.error('connected to MCP server\n');

  // 0. reset page to a clean state (idempotent across runs)
  await resetPageToken();

  // 1. tools/list
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  ok(names.includes('start_human_relay') && names.includes('await_human_solve'), `tools listed: ${names.join(', ')}`);

  // 2. start_human_relay
  const startRes = await client.callTool({ name: 'start_human_relay', arguments: { cdpUrl: CDP_URL, targetUrl: TARGET } });
  const relayUrl = startRes.structuredContent && startRes.structuredContent.relayUrl;
  ok(!!relayUrl && /^http:\/\//.test(relayUrl), `start_human_relay -> relayUrl: ${relayUrl}`);
  if (!relayUrl) { console.error('cannot continue without relayUrl'); await client.close(); process.exit(1); }
  const baseUrl = relayUrl.replace(/\/$/, '');

  // 3. relay page serves HTML
  const page = await httpGet(relayUrl);
  ok(page.status === 200 && /EventSource/.test(page.body), 'relay page serves phone HTML (EventSource client present)');

  // 4. SSE stream pushes a real screencast frame
  const stream = await streamFirstFrame(`${baseUrl}/stream`, 6000);
  ok(stream.gotData, 'SSE /stream pushed a screencast frame');

  // 5. tap forwards without error
  const tap = await httpPostJson(`${baseUrl}/tap`, { nx: 0.5, ny: 0.5 });
  ok(tap.status === 200, 'tap POST accepted (Input.dispatchMouseEvent forwarded)');

  // 6. await_human_solve times out fast when nobody solves
  const t0 = Date.now();
  const awaitMiss = await client.callTool({ name: 'await_human_solve', arguments: { timeoutMs: 2500 } });
  const missed = awaitMiss.structuredContent && awaitMiss.structuredContent.passed;
  ok(missed === false && Date.now() - t0 >= 2000, 'await_human_solve -> { passed:false } on timeout (no solver)');

  // 7. inject a token into the page, then await_human_solve should detect passed:true
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
  ok(hit === true, 'await_human_solve -> { passed:true } once the token appears in the page');

  await client.close();
  console.error(`\nE2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
