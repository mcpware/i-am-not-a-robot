#!/usr/bin/env node
'use strict';

/**
 * human-gate MCP server (stdio).
 *
 * Exposes two tools so any MCP-capable browser agent (Claude Code, Cursor,
 * Codex, browser-use, …) can hand an in-page CAPTCHA to a real human on a phone
 * and resume:
 *
 *   start_human_relay({ cdpUrl, targetUrl? }) -> { relayUrl, pageUrl }
 *       Connect to the agent's browser over CDP, stream the page to a phone,
 *       forward the human's taps back. The agent posts relayUrl in chat.
 *   await_human_solve({ timeoutMs? }) -> { passed }
 *       Block (polling) until the human solves the CAPTCHA (Google accepts the
 *       relayed real-finger solve) or until timeout.
 *
 * This is NOT a CAPTCHA solver: it relays the challenge to a human and ships no
 * auto-solve code path. The only integration point is one CDP endpoint, which
 * Playwright/Puppeteer/browser-use all expose (they all sit on CDP).
 *
 * All logs go to stderr; stdout is the JSON-RPC channel.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { HumanRelay } = require('./relay.js');

// M1: a single active relay session shared across the two tool calls.
let relay = null;

const server = new McpServer({ name: 'human-gate', version: '0.1.0' });

server.registerTool(
  'start_human_relay',
  {
    title: 'Start a human CAPTCHA relay',
    description:
      'Call this when the browser agent hits an in-page CAPTCHA (e.g. reCAPTCHA) it cannot and should not solve itself. It streams the live browser page to the user\'s phone and forwards the user\'s finger taps back into the SAME browser session, so a real human solves the challenge. ' +
      'Returns a relayUrl — post it to the user in chat as a link, e.g. "Solve this CAPTCHA on your phone: <relayUrl>". After the user solves it, call await_human_solve. ' +
      'Needs the browser\'s CDP HTTP endpoint (e.g. http://localhost:9222), which Playwright/Puppeteer/browser-use expose via --remote-debugging-port. This is a human-in-the-loop relay, not an automated solver.',
    inputSchema: {
      cdpUrl: z.string().describe('CDP HTTP endpoint of the agent browser, e.g. http://localhost:9222'),
      targetUrl: z.string().optional().describe('substring of the page URL that has the CAPTCHA; if omitted, the first page target is used'),
    },
    outputSchema: {
      relayUrl: z.string().describe('URL to post to the user so they open it on their phone'),
      relayUrls: z.array(z.string()).describe('all candidate URLs (one per network interface); open whichever the phone can reach'),
      pageUrl: z.string().describe('URL of the page being streamed'),
    },
  },
  async ({ cdpUrl, targetUrl }) => {
    try {
      if (relay) { await relay.stop().catch(() => {}); relay = null; }
      relay = new HumanRelay();
      const out = await relay.start({ cdpUrl, targetUrl });
      const alt = out.relayUrls && out.relayUrls.length > 1
        ? `\n\nIf the phone can't open that one (different network), try: ${out.relayUrls.slice(1).join('  ,  ')}`
        : '';
      const text =
        `Relay is live. Post this link to the user in chat so they can solve it on their phone:\n\n` +
        `Solve this CAPTCHA on your phone: ${out.relayUrl}${alt}\n\n` +
        `(streaming page: ${out.pageUrl}). When they finish, call await_human_solve.`;
      return { content: [{ type: 'text', text }], structuredContent: { relayUrl: out.relayUrl, relayUrls: out.relayUrls, pageUrl: out.pageUrl } };
    } catch (e) {
      if (relay) { await relay.stop().catch(() => {}); relay = null; }
      return { isError: true, content: [{ type: 'text', text: `start_human_relay failed: ${e.message}` }] };
    }
  }
);

server.registerTool(
  'await_human_solve',
  {
    title: 'Wait for the human to solve the CAPTCHA',
    description:
      'Block (polling) until the user finishes solving the relayed CAPTCHA, or until timeout. Returns { passed:true } once the reCAPTCHA token appears in the page (Google accepted the human solve) — then the agent can continue the task. Call this after start_human_relay.',
    inputSchema: {
      timeoutMs: z.number().int().positive().optional().describe('max milliseconds to wait (default 300000)'),
    },
    outputSchema: {
      passed: z.boolean().describe('true if the human solved it and Google accepted; false on timeout'),
    },
  },
  async ({ timeoutMs }) => {
    try {
      const r = relay; // capture: a concurrent start_human_relay may swap the singleton
      if (!r) {
        return { isError: true, content: [{ type: 'text', text: 'no active relay; call start_human_relay first' }] };
      }
      const out = await r.awaitSolve({ timeoutMs: timeoutMs || 300000 });
      if (out.passed || out.reason === 'cdp_closed') {
        await r.stop().catch(() => {});
        if (relay === r) relay = null; // don't null a newer relay that already replaced us
      }
      let text;
      if (out.passed) text = 'passed: the human solved the CAPTCHA and the relay is closed. Continue the task.';
      else if (out.reason === 'cdp_closed') text = 'failed: the browser/CDP connection dropped, so the relay is closed. Re-attach to the browser and call start_human_relay again if you still need a human.';
      else text = 'not passed: timed out waiting for the human. The relay is still live — call await_human_solve again, or tell the user to open the link.';
      return { content: [{ type: 'text', text }], structuredContent: { passed: out.passed } };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `await_human_solve failed: ${e.message}` }] };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (process.env.HUMAN_GATE_QUIET !== '1') {
    console.error('[human-gate] MCP server ready (stdio) — tools: start_human_relay, await_human_solve');
  }
}

// Tear down the relay (and its tunnel) if the client disconnects / kills us.
async function shutdown() { try { if (relay) await relay.stop(); } catch { /* noop */ } }
const onSignal = () => { shutdown().finally(() => process.exit(0)); };
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

main().catch((e) => {
  console.error('[human-gate] fatal:', e);
  process.exit(1);
});
