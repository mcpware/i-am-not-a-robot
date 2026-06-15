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
    if (/^(docker|veth|br-|virbr|cni|flannel)/i.test(name)) continue; // not reachable from a phone
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !/^169\.254\./.test(net.address)) out.push(net.address);
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
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.log('external', 'CDP connecting', { wsUrl: this.wsUrl });
      const ws = new WebSocket(this.wsUrl, { maxPayload: 64 * 1024 * 1024 });
      this.ws = ws;
      let settled = false;
      ws.on('open', () => { settled = true; this.log('state', 'CDP ws open'); resolve(); });
      ws.on('message', (data) => this._onMessage(data));
      ws.on('error', (err) => {
        this.log('error', 'CDP ws error', err && err.message);
        if (!settled) { settled = true; reject(err); }
      });
      ws.on('close', () => {
        this.closed = true;
        this.log('state', 'CDP ws closed');
        for (const { reject } of this._pending.values()) { try { reject(new Error('CDP socket closed')); } catch { /* noop */ } }
        this._pending.clear();
      });
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
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  let res;
  try { res = await fetch(url, { redirect: 'manual', signal: ac.signal }); }
  catch (e) { throw new Error(`cannot reach CDP at ${url}: ${e.message}`); }
  finally { clearTimeout(t); }
  if (!res.ok) throw new Error(`CDP ${url} returned HTTP ${res.status}`);
  return res.json();
}

/** Strip userinfo (token@host) from a URL before logging. */
function redactUrl(u) {
  try { const x = new URL(u); if (x.username || x.password) { x.username = ''; x.password = ''; return x.toString(); } return u; }
  catch { return u; }
}

/**
 * True if the CDP debugger ws is served on the same PORT as cdpUrl. Chrome always
 * serves the page ws on the same port as the /json endpoint, so a port mismatch
 * means the JSON pointed us elsewhere (SSRF signal) and we refuse. We deliberately
 * do NOT compare hostnames: legitimate setups report a different host than you
 * dialed (localhost vs 127.0.0.1, a container IP, an ssh-tunnelled remote Chrome).
 */
function sameCdpHost(cdpUrl, wsUrl) {
  try {
    return new URL(cdpUrl).port === new URL(wsUrl).port;
  } catch { return false; }
}

/** The phone page: live screencast <img> + tap-forwarding. Mobile-polished, zero deps. */
function renderPhonePage(title) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  title = esc(title);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>human-gate</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#0b0b0f;color:#e8e8ea;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:9px;padding:11px 13px;background:#15151c;border-bottom:1px solid #26262f;font-size:13px}
.dot{width:9px;height:9px;border-radius:50%;background:#f59e0b;flex:0 0 auto;transition:background .3s}
.dot.live{background:#22c55e}.dot.off{background:#ef4444}
.wrap{position:relative;touch-action:manipulation}
img{width:100%;display:block}
#hint{padding:11px 14px;font-size:12px;color:#9aa0aa;text-align:center;line-height:1.45}
.ring{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid #22c55e;border-radius:50%;pointer-events:none;opacity:0}
.ring.go{animation:rng .5s ease-out}
@keyframes rng{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(1.3)}}
</style></head>
<body>
<header><span class="dot" id="dot"></span><span>${title}</span></header>
<div class="wrap" id="wrap"><img id="v" alt="live page" src=""><div class="ring" id="ring"></div></div>
<div id="hint">Tap exactly where you would on a computer. When the challenge clears, you can close this page.</div>
<script>
var img=document.getElementById('v'),dot=document.getElementById('dot'),ring=document.getElementById('ring'),wrap=document.getElementById('wrap'),hint=document.getElementById('hint');
var base=location.pathname.replace(/\\/$/,''),solved=false;
var es=new EventSource(base+'/stream');
es.onmessage=function(e){if(!solved){img.src='data:image/jpeg;base64,'+e.data;dot.className='dot live';}};
es.addEventListener('solved',function(){solved=true;dot.className='dot live';img.style.opacity='0.35';hint.textContent='✓ Solved — the agent has it. You can close this page.';hint.style.color='#22c55e';hint.style.fontSize='15px';});
es.onerror=function(){if(!solved)dot.className='dot off';};
function tap(cx,cy){
  var ir=img.getBoundingClientRect();
  var nx=(cx-ir.left)/ir.width, ny=(cy-ir.top)/ir.height;
  if(nx<0||nx>1||ny<0||ny>1)return;
  var wr=wrap.getBoundingClientRect();
  ring.style.left=(cx-wr.left)+'px';ring.style.top=(cy-wr.top)+'px';
  ring.classList.remove('go');void ring.offsetWidth;ring.classList.add('go');
  fetch(base+'/tap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nx:nx,ny:ny})});
}
img.addEventListener('click',function(ev){tap(ev.clientX,ev.clientY);});
</script>
</body></html>`;
}

/**
 * Zero-binary public tunnel via the machine's own ssh client, so the phone can
 * reach the relay from anywhere (cellular, other wifi) with no user setup.
 * Anonymous + free; tries providers in order so it doesn't hinge on one host.
 * Power users can bypass this entirely by passing { host } (their own URL).
 */
// Order matters: localhost.run is PRIMARY because it passes real phone-browser
// traffic straight through. pinggy's free tier shows its own interstitial warning
// page to browser User-Agents (verified), which breaks "open the link and solve";
// it stays as a fallback only because it runs on :443 (reachable where :22 is
// firewall-blocked), at the cost of the user having to click through that page.
const TUNNEL_PROVIDERS = [
  {
    name: 'localhost.run',
    args: (port) => ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-R', `80:localhost:${port}`, 'nokey@localhost.run'],
    re: /https:\/\/[a-z0-9-]+\.lhr\.life/i,
  },
  {
    name: 'pinggy',
    args: (port) => ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=15', '-p', '443', `-R0:localhost:${port}`, 'a.pinggy.io'],
    re: /https:\/\/[a-z0-9-]+\.[a-z0-9.-]*pinggy[a-z-]*\.(?:link|online)/i,
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
      this.close(); // kill the failed provider's ssh before trying the next
    }
    this.log('warn', 'all tunnel providers failed — relay will be LAN-only');
    return null;
  }

  _try(prov, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh', prov.args(port));
      this.proc = proc; // assign immediately so close() can always kill it
      let buf = '';
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
      const onData = (d) => {
        buf += d.toString();
        if (buf.length > 65536) buf = buf.slice(-4096); // bound memory on a long-lived tunnel
        const m = buf.match(prov.re);
        if (m) {
          proc.stdout.removeListener('data', onData);
          proc.stderr.removeListener('data', onData);
          finish(resolve, m[0]);
        }
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
    this._killTimer = null;
  }

  /**
   * Connect via CDP, start the screencast, and serve the phone relay page.
   * @returns {Promise<{relayUrl:string, relayUrls:string[], pageUrl:string, viewport:{w:number,h:number}}>}
   */
  async start({ cdpUrl, targetUrl, host, port, tunnel, maxLifetimeMs } = {}) {
    this.log('entry', 'start_human_relay', { cdpUrl: redactUrl(cdpUrl), targetUrl });
    if (!cdpUrl) throw new Error('cdpUrl is required, e.g. http://localhost:9222');
    if (/^wss?:\/\//i.test(cdpUrl)) {
      throw new Error('pass the CDP HTTP endpoint (http://host:port), not a ws:// url');
    }

    const targets = await fetchTargets(cdpUrl);
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    this.log('state', 'targets fetched', { total: targets.length, pages: pages.length });

    let target = targetUrl ? pages.find((p) => (p.url || '').includes(targetUrl)) : null;
    if (!target) target = pages.find((p) => p.url && !/^(about:|chrome:|devtools:)/.test(p.url)) || pages[0];
    if (!target) throw new Error('no inspectable page target found at cdpUrl');
    if (!sameCdpHost(cdpUrl, target.webSocketDebuggerUrl)) {
      throw new Error('CDP debugger ws host does not match cdpUrl host (refusing to dial elsewhere)');
    }
    this.target = target;
    this.log('state', 'target picked', { url: target.url });

    this.cdp = new CdpSession(target.webSocketDebuggerUrl, this.log);
    await this.cdp.connect();
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    // Background tabs don't composite, so the screencast would be blank. Bring the
    // target to front so it actually renders frames for the phone.
    try { await this.cdp.send('Page.bringToFront'); } catch { /* not always supported */ }

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
    // Cap frame size + rate so the JPEG screencast stays light over a phone tunnel.
    // Full-viewport frames were too heavy and made image challenges feel laggy on
    // real devices. Tap accuracy is unaffected (coords map to the real viewport).
    const FCAP = 700;
    const fscale = Math.min(1, FCAP / Math.max(this.vp.w, this.vp.h));
    const sw = Math.max(1, Math.round(this.vp.w * fscale));
    const sh = Math.max(1, Math.round(this.vp.h * fscale));
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 50, maxWidth: sw, maxHeight: sh, everyNthFrame: 1,
    });
    this.log('state', 'screencast started', { frame: sw + 'x' + sh });

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

    // Hard lifetime cap so an abandoned relay never lingers (tunnel/ws/http).
    const maxMs = Number.isFinite(maxLifetimeMs) ? maxLifetimeMs : 15 * 60 * 1000;
    this._killTimer = setTimeout(() => { this.log('warn', 'relay hit max lifetime — auto-stopping'); this.stop(); }, maxMs);
    if (this._killTimer.unref) this._killTimer.unref();

    this.log('exit', 'relay live', { relayUrl: this.relayUrl, tunnel: this.tunnel ? this.tunnel.provider : 'none' });
    return { relayUrl: this.relayUrl, relayUrls: this.relayUrls, pageUrl: target.url, viewport: this.vp };
  }

  _startHttp({ host, port } = {}) {
    return new Promise((resolve, reject) => {
      const tokenBuf = Buffer.from(this.token);
      const prefix = `/r/${this.token}`; // used to build the public relay URLs below
      const server = http.createServer((req, res) => {
        const reqPath = (req.url || '').split('?')[0];
        const parts = reqPath.split('/'); // ['', 'r', <token>, ...rest]
        const given = parts[2] || '';
        const tokOk = parts[1] === 'r' && given.length === this.token.length &&
          crypto.timingSafeEqual(Buffer.from(given), tokenBuf);
        if (!tokOk) { this.log('warn', 'rejected request with bad/expired token'); res.writeHead(404).end('not found'); return; }
        const sub = '/' + parts.slice(3).join('/'); // '/', '/stream', or '/tap'
        const method = req.method || 'GET';

        if (sub === '/') {
          if (method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
          this.log('debug', 'phone opened relay page');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          });
          res.end(renderPhonePage('human-gate · solve the CAPTCHA'));
          return;
        }
        if (sub === '/stream') {
          if (method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
          res.write('retry: 1000\n\n');
          if (this.lastFrame) res.write(`data: ${this.lastFrame}\n\n`);
          this.sse.add(res);
          this.log('state', 'SSE client attached', { clients: this.sse.size });
          req.on('close', () => { this.sse.delete(res); this.log('state', 'SSE client left', { clients: this.sse.size }); });
          return;
        }
        if (sub === '/tap' && method === 'POST') {
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
    nx = Number(nx);
    ny = Number(ny);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      this.log('warn', 'tap ignored: coords out of [0,1]', { nx, ny });
      return;
    }
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
    // Pass = the CAPTCHA's response token is present in the page. Covers the
    // three common in-page widgets: reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.
    const expr =
      '(function(){try{' +
      'function v(s){var e=document.querySelector(s);return e&&e.value?e.value.length:0;}' +
      'var n=0;' +
      "n+=v('textarea[id^=\"g-recaptcha-response\"]');" +
      "n+=v('textarea[name=\"h-captcha-response\"]');" +
      "n+=v('input[name=\"cf-turnstile-response\"]');" +
      "if(!n&&typeof grecaptcha!=='undefined'&&grecaptcha.getResponse){try{n+=(grecaptcha.getResponse()||'').length;}catch(e){}}" +
      "if(!n&&typeof hcaptcha!=='undefined'&&hcaptcha.getResponse){try{n+=(hcaptcha.getResponse()||'').length;}catch(e){}}" +
      'return n>0;}catch(e){return false;}})()';
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
      if (this.cdp.closed) { this.log('error', 'CDP connection dropped — stopping poll'); return { passed: false, reason: 'cdp_closed' }; }
      try {
        const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        polls++;
        if (r && r.result && r.result.value === true) {
          this.log('exit', 'solve detected — passed', { polls });
          // tell the phone it worked before we tear the relay down (avoids a "frozen/stuck" look)
          for (const res of this.sse) { try { res.write('event: solved\ndata: 1\n\n'); } catch { /* client gone */ } }
          await new Promise((r2) => setTimeout(r2, 250)); // let the success frame reach the phone
          return { passed: true };
        }
      } catch (e) {
        this.log('warn', 'poll eval failed', e && e.message);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    this.log('exit', 'timed out waiting for human — not passed', { polls });
    return { passed: false, reason: 'timeout' };
  }

  async stop() {
    this.log('entry', 'stop relay');
    if (this._killTimer) { clearTimeout(this._killTimer); this._killTimer = null; }
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
