'use strict';

/**
 * Opt-in E2E that proves the PUBLIC cross-network path: the MCP server auto-opens
 * an ssh tunnel, and the relay page + SSE screencast + tap all flow over the
 * public HTTPS URL (the exact thing a phone on cellular would hit).
 *
 * Hits a free third-party tunnel host (pinggy, then localhost.run), so it is kept
 * separate from the fast, deterministic local `mcp:e2e`. Requires a CDP Chrome at
 * CDP_URL with a page open.
 *   npm run mcp:tunnel-e2e
 */

const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const TARGET = process.env.CDP_TARGET || 'recaptcha/api2/demo';

async function readSseFrame(url, ms = 10000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
    if (res.status !== 200) return { status: res.status, gotData: false };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let txt = '';
    while (!/data: [A-Za-z0-9+/]/.test(txt)) {
      const { value, done } = await reader.read();
      if (done) break;
      txt += dec.decode(value);
    }
    return { status: 200, gotData: /data: [A-Za-z0-9+/]/.test(txt) };
  } finally { clearTimeout(to); }
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; console.error('  ✓', m); } else { fail++; console.error('  ✗', m); } };

  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, '..', 'src', 'mcp-server.js')],
    env: { ...process.env, HUMAN_GATE_TUNNEL: 'auto' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'hg-tunnel-e2e', version: '0.0.0' });
  await client.connect(transport);
  console.error('connected; opening relay WITH public tunnel (hits pinggy/localhost.run)…\n');

  const startRes = await client.callTool({ name: 'start_human_relay', arguments: { cdpUrl: CDP_URL, targetUrl: TARGET } });
  const relayUrl = startRes.structuredContent && startRes.structuredContent.relayUrl;
  ok(!!relayUrl && /^https:\/\//.test(relayUrl), `public relayUrl over tunnel: ${relayUrl}`);
  if (!relayUrl || !/^https:\/\//.test(relayUrl)) { console.error('no public URL — tunnel did not open'); await client.close(); process.exit(1); }
  const base = relayUrl.replace(/\/$/, '');

  const pageRes = await fetch(relayUrl);
  const pageHtml = await pageRes.text();
  ok(pageRes.status === 200 && /EventSource/.test(pageHtml), 'relay page served over PUBLIC https');

  const sse = await readSseFrame(`${base}/stream`, 10000);
  ok(sse.gotData, 'SSE screencast frame flowed over PUBLIC tunnel');

  const tapRes = await fetch(`${base}/tap`, { method: 'POST', body: JSON.stringify({ nx: 0.5, ny: 0.5 }), headers: { 'Content-Type': 'application/json' } });
  ok(tapRes.status === 200, 'tap POST forwarded over PUBLIC tunnel');

  await client.close();
  console.error(`\nTUNNEL E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TUNNEL E2E ERROR', e); process.exit(1); });
