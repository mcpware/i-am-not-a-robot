'use strict';

/**
 * human-gate live relay — raw CDP over a WebSocket (NO playwright).
 *
 * Streams a real browser page to the user's phone via CDP `Page.startScreencast`
 * and forwards the human's taps back into the SAME browser session via
 * `Input.dispatchMouseEvent`, so a real finger solves the in-page CAPTCHA.
 * Pass detection polls the reCAPTCHA token in the page (`grecaptcha.getResponse()`
 * / the `g-recaptcha-response` textarea), which only fills once Google accepts.
 *
 * Talks raw CDP (the protocol Playwright/Puppeteer/browser-use all sit on top of),
 * so the only integration point is one CDP HTTP endpoint. The single npm runtime
 * dependency is `ws` (a WebSocket client; Node <22 has no global WebSocket).
 *
 * Every entry point, decision branch, state change and external call logs to
 * stderr (toggle with { log:false } or HUMAN_GATE_QUIET=1). stdout is reserved
 * for the MCP JSON-RPC channel and must never be written to here.
 */

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const TAG = '[human-gate:relay]';

/** Structured logger -> stderr only. */
function makeLogger(enabled) {
  const on = enabled && process.env.HUMAN_GATE_QUIET !== '1';
  return (level, msg, extra) => {
    if (!on) return;
    const line = `${TAG} ${level.toUpperCase()} ${msg}`;
    if (extra !== undefined) console.error(line, extra);
    else console.error(line);
  };
}

/**
 * All non-internal IPv4 addresses, ranked so a phone on the same wifi works by
 * default: real RFC1918 LAN (192.168/10/172.16-31) first, then everything else,
 * with Tailscale CGNAT (100.64/10) LAST as primary — it's only reachable if the
 * phone is on the same tailnet, but we still return it as a candidate (it
 * doubles as a cross-network tunnel for tailnet users).
 */
function listIpv4() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  const rank = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 0;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 0;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 2; // Tailscale CGNAT
    return 1;
  };
  out.sort((a, b) => rank(a) - rank(b));
  return out.length ? out : ['127.0.0.1'];
}

/** Primary LAN IP a phone on the same network should use. */
function detectLanIp() {
  return listIpv4()[0];
}

/**
 * Minimal raw CDP client over a single page-level WebSocket.
 * Replaces playwright's CDPSession: send(method,params) -> Promise(result),
 * on(method, handler) for events. No sessionId juggling needed because we
 * connect directly to the page target's webSocketDebuggerUrl.
 */
class CdpSession {
  constructor(wsUrl, log) {
    this.wsUrl = wsUrl;
    this.log = log || (() => {});
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this._handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.log('external', 'CDP connecting', { wsUrl: this.wsUrl });
      const ws = new WebSocket(this.wsUrl, { maxPayload: 256 * 1024 * 1024 });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => { settled = true; this.log('state', 'CDP ws open'); resolve(); });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('error', (err) => {
        this.log('error', 'CDP ws error', err && err.message);
        if (!settled) { settled = true; reject(err); }
      });
      ws.on('close', () => this.log('state', 'CDP ws closed'));
    });
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { this.log('error', 'CDP non-JSON frame ignored'); return; }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error: ${msg.error.message || JSON.stringify(msg.error)}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const hs = this._handlers.get(msg.method);
      if (hs) for (const h of hs) {
        try { h(msg.params); } catch (e) { this.log('error', 'CDP event handler threw', e && e.message); }
      }
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('CDP socket not open'));
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) { this._pending.delete(id); reject(err); }
      });
    });
  }

  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, new Set());
    this._handlers.get(method).add(handler);
  }

  close() { try { this.ws && this.ws.close(); } catch { /* noop */ } }
}

/** List inspectable targets from a CDP HTTP endpoint (http://host:port). */
async function fetchTargets(cdpUrl) {
  const base = cdpUrl.replace(/\/+$/, '');
  const url = `${base}/json`;
  let res;
  try { res = await fetch(url); }
  catch (e) { throw new Error(`cannot reach CDP at ${url}: ${e.message}`); }
  if (!res.ok) throw new Error(`CDP ${url} returned HTTP ${res.status}`);
  return res.json();
}

/** The tiny phone page: a screencast <img> + tap-forwarding. Mobile-friendly. */
function renderPhonePage(title) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1,user-scalable=no">
<title>human-gate</title>
<body style="margin:0;background:#111;font-family:system-ui;color:#eee;text-align:center">
<div style="padding:8px;font-size:13px;line-height:1.3">${title}</div>
<img id=v alt="live page" style="width:100%;display:block;touch-action:manipulation" src="">
<div id=s style="padding:8px;font-size:12px;color:#9ca3af">connecting…</div>
<script>
var img=document.getElementById('v'),s=document.getElementById('s');
var base=location.pathname.replace(/\\/$/,'');
var es=new EventSource(base+'/stream');
es.onmessage=function(e){img.src='data:image/jpeg;base64,'+e.data;s.style.display='none';};
es.onerror=function(){s.textContent='reconnecting…';s.style.display='block';};
img.addEventListener('click',function(ev){
  var r=img.getBoundingClientRect();
  var nx=(ev.clientX-r.left)/r.width, ny=(ev.clientY-r.top)/r.height;
  fetch(base+'/tap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nx:nx,ny:ny})});
});
</script></body>`;
}

/**
 * Zero-binary public tunnel via the machine's own ssh client, so the phone can
 * reach the relay from anywhere (cellular, other wifi) with no user setup.
 * Anonymous + free; tries providers in order so it doesn't hinge on one host.
 * Power users can bypass this entirely by passing { host } (their own URL).
 */
const TUNNEL_PROVIDERS = [
  {
    name: 'pinggy',
    args: (port) => ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-p', '443', `-R0:localhost:${port}`, 'a.pinggy.io'],
    re: /https:\/\/[a-z0-9-]+\.[a-z0-9.-]*pinggy-free\.link/i,
  },
  {
    name: 'localhost.run',
    args: (port) => ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-R', `80:localhost:${port}`, 'nokey@localhost.run'],
    re: /https:\/\/[a-z0-9-]+\.lhr\.life/i,
  },
];

class Tunnel {
  constructor(log) {
    this.log = log || (() => {});
    this.proc = null;
    this.url = null;
    this.provider = null;
  }

  /** Open a public tunnel to the given local port. Resolves to the URL, or null if all providers fail. */
  async open(port, { timeoutMs = 20000 } = {}) {
    for (const prov of TUNNEL_PROVIDERS) {
      this.log('external', 'opening tunnel', { provider: prov.name, port });
      const url = await this._try(prov, port, timeoutMs).catch((e) => {
        this.log('warn', 'tunnel provider failed', { provider: prov.name, err: e && e.message });
        return null;
      });
      if (url) {
        this.url = url;
        this.provider = prov.name;
        this.log('state', 'tunnel up', { provider: prov.name, url });
        return url;
      }
    }
    this.log('warn', 'all tunnel providers failed — relay will be LAN-only');
    return null;
  }

  _try(prov, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh', prov.args(port));
      let buf = '';
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
      const onData = (d) => {
        buf += d.toString();
        const m = buf.match(prov.re);
        if (m) { this.proc = proc; finish(resolve, m[0]); }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => finish(reject, e)); // e.g. ssh not installed
      proc.on('exit', (code) => finish(reject, new Error(`ssh exited (${code}) before a URL`)));
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } finish(reject, new Error('tunnel timeout')); }, timeoutMs);
    });
  }

  close() {
    try { if (this.proc) this.proc.kill('SIGKILL'); } catch { /* noop */ }
    this.proc = null;
  }
}

/**
 * One live relay session (M1: a single active session at a time).
 */
class HumanRelay {
  constructor(opts = {}) {
    this.log = makeLogger(opts.log !== false);
    this.cdp = null;
    this.server = null;
    this.sse = new Set();
    this.lastFrame = null;
    this.vp = { w: 360, h: 640 };
    this.token = null;
    this.relayUrl = null;
    this.relayUrls = null;
    this.target = null;
    this.tunnel = null;
  }

  /**
   * Connect via CDP, start the screencast, and serve the phone relay page.
   * @returns {Promise<{relayUrl:string, relayUrls:string[], pageUrl:string, viewport:{w:number,h:number}}>}
   */
  async start({ cdpUrl, targetUrl, host, port, tunnel } = {}) {
    this.log('entry', 'start_human_relay', { cdpUrl, targetUrl });
    if (!cdpUrl) throw new Error('cdpUrl is required, e.g. http://localhost:9222');
    if (/^wss?:\/\//i.test(cdpUrl)) {
      throw new Error('pass the CDP HTTP endpoint (http://host:port), not a ws:// url');
    }

    const targets = await fetchTargets(cdpUrl);
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    this.log('state', 'targets fetched', { total: targets.length, pages: pages.length });

    let target = targetUrl ? pages.find((p) => (p.url || '').includes(targetUrl)) : null;
    if (!target) target = pages[0];
    if (!target) throw new Error('no inspectable page target found at cdpUrl');
    this.target = target;
    this.log('state', 'target picked', { url: target.url });

    this.cdp = new CdpSession(target.webSocketDebuggerUrl, this.log);
    await this.cdp.connect();
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');

    try {
      const r = await this.cdp.send('Runtime.evaluate', {
        expression: '({w:window.innerWidth,h:window.innerHeight})',
        returnByValue: true,
      });
      if (r && r.result && r.result.value) this.vp = r.result.value;
    } catch (e) {
      this.log('warn', 'viewport eval failed, using default', e && e.message);
    }
    this.log('state', 'viewport', this.vp);

    this.cdp.on('Page.screencastFrame', async (p) => {
      this.lastFrame = p.data;
      for (const res of this.sse) { try { res.write(`data: ${p.data}\n\n`); } catch { /* client gone */ } }
      try { await this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }); } catch { /* race on stop */ }
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 55, maxWidth: this.vp.w, maxHeight: this.vp.h, everyNthFrame: 1,
    });
    this.log('state', 'screencast started');

    this.token = crypto.randomBytes(12).toString('hex');
    await this._startHttp({ host, port });

    // Public URL so the phone reaches the relay from anywhere (cellular, other
    // wifi) with zero user setup. Skipped if the caller pinned their own host.
    const tunnelMode = tunnel !== undefined ? tunnel : (process.env.HUMAN_GATE_TUNNEL === 'off' ? 'off' : 'auto');
    if (tunnelMode !== 'off' && !host) {
      this.tunnel = new Tunnel(this.log);
      const localPort = this.server.address().port;
      const pub = await this.tunnel.open(localPort).catch((e) => { this.log('warn', 'tunnel open failed', e && e.message); return null; });
      if (pub) {
        const publicUrl = `${pub.replace(/\/+$/, '')}/r/${this.token}/`;
        this.relayUrls = [publicUrl, ...this.relayUrls];
        this.relayUrl = publicUrl;
      } else {
        this.tunnel = null; // fell back to LAN candidates already in relayUrls
      }
    }

    this.log('exit', 'relay live', { relayUrl: this.relayUrl, tunnel: this.tunnel ? this.tunnel.provider : 'none' });
    return { relayUrl: this.relayUrl, relayUrls: this.relayUrls, pageUrl: target.url, viewport: this.vp };
  }

  _startHttp({ host, port } = {}) {
    return new Promise((resolve, reject) => {
      const prefix = `/r/${this.token}`;
      const server = http.createServer((req, res) => {
        const path = (req.url || '').split('?')[0];
        if (!path.startsWith(prefix)) { this.log('warn', 'rejected bad/expired token path', { path }); res.writeHead(404).end('not found'); return; }
        const sub = path.slice(prefix.length);

        if (sub === '' || sub === '/') {
          this.log('debug', 'phone opened relay page');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderPhonePage('human-gate — solve the CAPTCHA with your finger'));
          return;
        }
        if (sub === '/stream') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          res.write('retry: 1000\n\n');
          if (this.lastFrame) res.write(`data: ${this.lastFrame}\n\n`);
          this.sse.add(res);
          this.log('state', 'SSE client attached', { clients: this.sse.size });
          req.on('close', () => { this.sse.delete(res); this.log('state', 'SSE client left', { clients: this.sse.size }); });
          return;
        }
        if (sub === '/tap' && req.method === 'POST') {
          let b = '';
          req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
          req.on('end', async () => {
            try { const { nx, ny } = JSON.parse(b); await this._tap(nx, ny); }
            catch (e) { this.log('error', 'tap relay failed', e && e.message); }
            res.writeHead(200).end('ok');
          });
          return;
        }
        res.writeHead(404).end('not found');
      });
      server.on('error', reject);
      server.listen(port || 0, () => {
        const p = server.address().port;
        this.server = server;
        const ips = listIpv4();
        this.relayUrls = ips.map((ip) => `http://${ip}:${p}${prefix}/`);
        this.relayUrl = host ? `http://${host}:${p}${prefix}/` : this.relayUrls[0];
        this.log('state', 'relay http listening', { primary: this.relayUrl, candidates: this.relayUrls });
        resolve();
      });
    });
  }

  async _tap(nx, ny) {
    const x = Math.round(nx * this.vp.w);
    const y = Math.round(ny * this.vp.h);
    this.log('state', 'tap relayed -> page', { x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * Poll until the reCAPTCHA token appears (Google accepted the human solve),
   * or until timeout.
   * @returns {Promise<{passed:boolean}>}
   */
  async awaitSolve({ timeoutMs = 300000, pollMs = 1500 } = {}) {
    this.log('entry', 'await_human_solve', { timeoutMs, pollMs });
    if (!this.cdp) throw new Error('no active relay; call start_human_relay first');
    const expr =
      "(function(){try{var t=document.querySelector('textarea[id^=\"g-recaptcha-response\"]');" +
      "var tok=t?t.value:'';" +
      "if(!tok&&typeof grecaptcha!=='undefined'&&grecaptcha.getResponse){try{tok=grecaptcha.getResponse();}catch(e){}}" +
      'return !!(tok&&tok.length>0);}catch(e){return false;}})()';
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
      try {
        const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        polls++;
        if (r && r.result && r.result.value === true) {
          this.log('exit', 'solve detected — passed', { polls });
          return { passed: true };
        }
      } catch (e) {
        this.log('warn', 'poll eval failed', e && e.message);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    this.log('exit', 'timed out waiting for human — not passed', { polls });
    return { passed: false };
  }

  async stop() {
    this.log('entry', 'stop relay');
    try { if (this.tunnel) this.tunnel.close(); } catch { /* noop */ }
    try { if (this.cdp) await this.cdp.send('Page.stopScreencast'); } catch { /* noop */ }
    for (const res of this.sse) { try { res.end(); } catch { /* noop */ } }
    this.sse.clear();
    try { if (this.server) this.server.close(); } catch { /* noop */ }
    try { if (this.cdp) this.cdp.close(); } catch { /* noop */ }
    this.cdp = null;
    this.server = null;
    this.log('state', 'relay stopped');
  }
}

module.exports = { HumanRelay, CdpSession, Tunnel, detectLanIp, listIpv4, fetchTargets };
