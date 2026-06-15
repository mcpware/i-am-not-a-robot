'use strict';

/**
 * human-gate — the missing input() for headless agents.
 *
 * Pause any Playwright/Puppeteer flow at a step only a human can do
 * (CAPTCHA, OTP, 2FA, ambiguous field, approve/reject), push a screenshot
 * to your phone, and resume on the human's tap/answer.
 *
 * Design goals:
 *   - Zero runtime dependencies (Node >=18 built-ins + global fetch only).
 *   - Bring your own browser: accepts any object with a `screenshot()` method
 *     (Playwright Page, Puppeteer Page, or a custom shim). No cloud session.
 *   - Phone-native Pattern B: notify -> human answers one thing -> resume.
 *
 * Every entry point, decision branch, state change and external call is logged
 * (toggle with { log: false } or HUMAN_GATE_QUIET=1).
 */

const http = require('http');
const crypto = require('crypto');
const os = require('os');

const TAG = '[human-gate]';

/** Structured logger. Logs to stderr so it never pollutes stdout data. */
function makeLogger(enabled) {
  const on = enabled && process.env.HUMAN_GATE_QUIET !== '1';
  return (level, msg, extra) => {
    if (!on) return;
    const line = `${TAG} ${level.toUpperCase()} ${msg}`;
    if (extra !== undefined) console.error(line, extra);
    else console.error(line);
  };
}

/** Pick the first non-internal IPv4 address so a phone on the same LAN can reach us. */
function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/** Grab a screenshot buffer from a Playwright/Puppeteer-style page. */
async function captureScreenshot(page, capture, log) {
  if (!page || typeof page.screenshot !== 'function') {
    throw new Error(
      'human-gate: first arg must be a page-like object with a screenshot() method ' +
        '(Playwright Page, Puppeteer Page, or a shim).'
    );
  }
  log('debug', 'capturing screenshot', { capture });
  try {
    if (capture && capture !== 'viewport' && capture !== 'fullpage') {
      // capture is a CSS selector -> screenshot just that element when supported
      if (typeof page.locator === 'function') {
        const buf = await page.locator(capture).screenshot();
        return buf;
      }
      if (typeof page.$ === 'function') {
        const el = await page.$(capture);
        if (el) return await el.screenshot();
      }
      log('warn', 'selector capture unsupported on this page, falling back to viewport', { capture });
    }
    return await page.screenshot({ fullPage: capture === 'fullpage' });
  } catch (err) {
    log('error', 'screenshot failed', err && err.message);
    throw err;
  }
}

/** HTML the human opens on their phone: screenshot + the right answer control. */
function renderAnswerPage({ prompt, expect, pngBase64, submitted }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (submitted) {
    return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;text-align:center">
<h2>✅ Answer received</h2><p>The agent is resuming. You can close this page.</p></body>`;
  }
  const control =
    expect === 'approve'
      ? `<div style="display:flex;gap:12px;margin-top:16px">
           <button name=answer value=approve style="flex:1;padding:18px;font-size:18px;background:#16a34a;color:#fff;border:0;border-radius:10px">Approve</button>
           <button name=answer value=reject  style="flex:1;padding:18px;font-size:18px;background:#dc2626;color:#fff;border:0;border-radius:10px">Reject</button>
         </div>`
      : `<input name=answer autofocus autocomplete=off
              style="width:100%;padding:16px;font-size:20px;box-sizing:border-box;border:2px solid #888;border-radius:10px;margin-top:16px"
              placeholder="Type the answer (OTP / CAPTCHA text / value)">
         <button style="width:100%;padding:16px;font-size:18px;margin-top:12px;background:#2563eb;color:#fff;border:0;border-radius:10px">Send</button>`;
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h2 style="margin:0 0 4px">human-gate</h2>
<p style="font-size:18px;margin:0 0 16px">${esc(prompt)}</p>
<img src="data:image/png;base64,${pngBase64}" style="width:100%;border:1px solid #ddd;border-radius:8px">
<form method=POST>${control}</form>
</body>`;
}

/** Push a notification with a link to the answer page. ntfy is the only P0 channel. */
async function pushNtfy(notify, url, prompt, log) {
  if (!notify || !notify.topic) {
    log('warn', 'no ntfy.topic configured — printing the link instead', { url });
    console.error(`${TAG} OPEN THIS ON YOUR PHONE: ${url}`);
    return;
  }
  const server = (notify.server || 'https://ntfy.sh').replace(/\/$/, '');
  const endpoint = `${server}/${notify.topic}`;
  log('external', 'POST ntfy', { endpoint });
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Title: notify.title || 'Agent needs you',
        Click: url,
        Actions: `view, Open, ${url}`,
        Priority: notify.priority || 'high',
        Tags: 'robot',
      },
      body: prompt,
    });
    log('external', 'ntfy responded', { status: res.status });
    if (!res.ok) {
      console.error(`${TAG} OPEN THIS ON YOUR PHONE: ${url}`);
    }
  } catch (err) {
    log('error', 'ntfy push failed — printing link as fallback', err && err.message);
    console.error(`${TAG} OPEN THIS ON YOUR PHONE: ${url}`);
  }
}

/**
 * Pause and ask a human.
 *
 * @param {object} page  Playwright/Puppeteer page (anything with screenshot()).
 * @param {object} opts
 * @param {string} opts.prompt        What to ask the human.
 * @param {'text'|'approve'} [opts.expect='text']  Answer shape.
 * @param {'viewport'|'fullpage'|string} [opts.capture='viewport']  Screenshot scope or CSS selector.
 * @param {{topic:string, server?:string, title?:string, priority?:string}} [opts.notify]  ntfy config.
 * @param {string} [opts.host]        Host/IP the phone uses to reach us (default: auto LAN IP).
 * @param {number} [opts.port=0]      Relay port (0 = ephemeral).
 * @param {number} [opts.timeoutMs=300000]  How long to wait for the human.
 * @param {boolean} [opts.log=true]   Debug logging to stderr.
 * @returns {Promise<string|boolean>} text answer, or true/false for 'approve' mode.
 */
async function humanGate(page, opts = {}) {
  const log = makeLogger(opts.log !== false);
  const expect = opts.expect === 'approve' ? 'approve' : 'text';
  const capture = opts.capture || 'viewport';
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 300000;
  const prompt = opts.prompt || 'The agent needs your input.';
  log('entry', 'humanGate called', { expect, capture, timeoutMs, prompt });

  const png = await captureScreenshot(page, capture, log);
  const pngBase64 = Buffer.from(png).toString('base64');
  const token = crypto.randomBytes(16).toString('hex');
  log('state', 'session created', { token, screenshotBytes: png.length });

  let resolveAnswer, rejectAnswer;
  const answerPromise = new Promise((res, rej) => {
    resolveAnswer = res;
    rejectAnswer = rej;
  });
  let submitted = false;

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    // one-time-token guards every route
    if (!path.startsWith(`/g/${token}`)) {
      log('warn', 'rejected request with bad/expired token', { path });
      res.writeHead(404).end('not found');
      return;
    }
    if (req.method === 'GET') {
      log('debug', 'human opened the answer page', { token });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderAnswerPage({ prompt, expect, pngBase64, submitted }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e6) req.destroy(); // guard against runaway POST
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const raw = params.get('answer');
        let answer;
        if (expect === 'approve') answer = raw === 'approve';
        else answer = raw == null ? '' : raw.trim();
        submitted = true;
        log('state', 'answer submitted by human', { token, expect, answer });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderAnswerPage({ submitted: true }));
        resolveAnswer(answer);
      });
      return;
    }
    res.writeHead(405).end('method not allowed');
  });

  const host = opts.host || detectLanIp();
  const port = await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, () => resolve(server.address().port));
  });
  const url = `http://${host}:${port}/g/${token}`;
  log('state', 'relay server listening', { host, port, url });

  // onReady lets callers observe the live URL (logging, custom relay, or tests).
  if (typeof opts.onReady === 'function') {
    try {
      opts.onReady(url);
    } catch (err) {
      log('warn', 'onReady callback threw', err && err.message);
    }
  }

  await pushNtfy(opts.notify, url, prompt, log);

  const timer = setTimeout(() => {
    log('error', 'timed out waiting for human', { timeoutMs });
    rejectAnswer(new Error(`human-gate: timed out after ${timeoutMs}ms waiting for a human answer`));
  }, timeoutMs);

  try {
    const answer = await answerPromise;
    log('exit', 'resuming automation with answer', { answer });
    return answer;
  } finally {
    clearTimeout(timer);
    server.close(() => log('debug', 'relay server closed', { token }));
  }
}

module.exports = { humanGate, detectLanIp };
