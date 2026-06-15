'use strict';

/**
 * Opt-in E2E that proves the PUBLIC cross-network path over the WebSocket
 * transport: the MCP server auto-opens a tunnel (cloudflared primary, ssh
 * fallback), and the relay page + WS screencast + tap all flow over the public
 * URL — the exact thing a phone on cellular hits. Hits a third-party tunnel, so
 * it's separate from the fast local mcp:e2e. Requires a CDP Chrome at CDP_URL.
 *   npm run mcp:tunnel-e2e
 */

const path = require('path');
const WebSocket = require('ws');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const TARGET = process.env.CDP_TARGET || 'recaptcha/api2/demo';

function waitFor(cond, ms) {
  return new Promise((resolve) => { const t0 = Date.now(); const i = setInterval(() => { if (cond() || Date.now() - t0 > ms) { clearInterval(i); resolve(cond()); } }, 50); });
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; console.error('  ✓', msg); } else { fail++; console.error('  ✗', msg); } };

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, IAMNOTAROBOT_TUNNEL: 'auto' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'hg-tunnel-e2e', version: '0.0.0' });
  await client.connect(transport);
  console.error('connected; opening relay WITH a public tunnel (cloudflared / ssh)…\n');

  const startRes = await client.callTool({ name: 'start_human_relay', arguments: { cdpUrl: CDP_URL, targetUrl: TARGET } });
  const relayUrl = startRes.structuredContent && startRes.structuredContent.relayUrl;
  ok(!!relayUrl && /^https:\/\//.test(relayUrl), `public relayUrl over tunnel: ${relayUrl}`);
  if (!relayUrl || !/^https:\/\//.test(relayUrl)) { console.error('no public URL — tunnel did not open'); await client.close(); process.exit(1); }

  const pageRes = await fetch(relayUrl);
  const pageHtml = await pageRes.text();
  ok(pageRes.status === 200 && /WebSocket/.test(pageHtml), 'relay page served over PUBLIC https');

  const wsUrl = relayUrl.replace(/^https/, 'wss') + 'ws';
  const ws = new WebSocket(wsUrl);
  let gotFrame = false;
  ws.on('message', (data, isBinary) => { if (isBinary) gotFrame = true; });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('ws open timeout')), 15000); }).catch((e) => { console.error('WS open failed:', e.message); });
  await waitFor(() => gotFrame, 9000);
  ok(gotFrame, 'WS streamed a screencast frame over the PUBLIC tunnel');

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ nx: 0.5, ny: 0.5 }));
    await new Promise((r) => setTimeout(r, 400));
  }
  ok(ws.readyState === WebSocket.OPEN, 'tap sent over the PUBLIC WS, still connected');

  try { ws.close(); } catch { /* noop */ }
  await client.close();
  console.error(`\nTUNNEL E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TUNNEL E2E ERROR', e); process.exit(1); });
