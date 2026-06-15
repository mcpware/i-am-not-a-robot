'use strict';

/**
 * i-am-not-a-robot live relay — raw CDP over a WebSocket (NO playwright), streamed to
 * the phone over a WebSocket transport.
 *
 * Streams a real browser page to the user's phone via CDP `Page.startScreencast`
 * and forwards the human's taps back into the SAME browser session via
 * `Input.dispatchMouseEvent`, so a real finger solves the in-page CAPTCHA.
 *
 * Transport is a single WebSocket (frames down as binary JPEG, taps up as JSON):
 * Cloudflare buffers SSE but streams WebSocket natively, which lets us use a
 * cloudflared quick tunnel (a nearby Cloudflare edge -> ~3x lower latency than a
 * single-server ssh tunnel). cloudflared is the primary tunnel; ssh tunnels
 * (localhost.run, then pinggy) are the zero-binary fallback.
 *
 * Pass detection polls the CAPTCHA token in the page (reCAPTCHA v2/v3, hCaptcha,
 * Cloudflare Turnstile). Runtime deps: `ws`. Logs go to stderr; stdout is for the
 * MCP JSON-RPC channel and must never be written to here.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const TAG = '[i-am-not-a-robot:relay]';

/** Structured logger -> stderr only. */
function makeLogger(enabled) {
  const on = enabled && process.env.IAMNOTAROBOT_QUIET !== '1';
  return (level, msg, extra) => {
    if (!on) return;
    const line = `${TAG} ${level.toUpperCase()} ${msg}`;
    if (extra !== undefined) console.error(line, extra);
    else console.error(line);
  };
}

/**
 * All non-internal IPv4 addresses, ranked so a phone on the same wifi works by
 * default: real RFC1918 LAN first, then everything else, Tailscale CGNAT last.
 * docker/veth/virbr interfaces and link-local addresses are skipped entirely.
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
 * Minimal raw CDP client over a single page-level WebSocket. Replaces playwright's
 * CDPSession: send(method,params) -> Promise(result), on(method, handler) for events.
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
        for (const { reject: rej } of this._pending.values()) { try { rej(new Error('CDP socket closed')); } catch { /* noop */ } }
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
 * True if the CDP debugger ws is on the same PORT as cdpUrl. Chrome serves the
 * page ws on the same port as /json, so a port mismatch means the JSON pointed us
 * elsewhere (SSRF) and we refuse. Hostnames are deliberately NOT compared
 * (localhost vs 127.0.0.1, container IPs, ssh-tunnelled remotes all differ legit).
 */
function sameCdpHost(cdpUrl, wsUrl) {
  try { return new URL(cdpUrl).port === new URL(wsUrl).port; }
  catch { return false; }
}

/** The phone page: a WebSocket pulls binary JPEG frames + sends taps. Zero deps. */
function renderPhonePage(title) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  title = esc(title);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>i-am-not-a-robot</title>
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
var base=location.pathname.replace(/\\/$/,''),solved=false,curUrl=null;
var ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+base+'/ws');
ws.binaryType='blob';
ws.onmessage=function(e){
  if(typeof e.data==='string'){ try{var m=JSON.parse(e.data); if(m.type==='solved'){solved=true;dot.className='dot live';img.style.opacity='0.35';hint.textContent='\\u2713 Solved \\u2014 the agent has it. You can close this page.';hint.style.color='#22c55e';hint.style.fontSize='15px';}}catch(_){} return; }
  if(solved) return;
  var url=URL.createObjectURL(e.data); var old=curUrl; curUrl=url; img.src=url; dot.className='dot live';
  if(old){ setTimeout(function(){URL.revokeObjectURL(old);},200); }
};
ws.onclose=function(){ if(!solved) dot.className='dot off'; };
ws.onerror=function(){ if(!solved) dot.className='dot off'; };
function tap(cx,cy){
  var ir=img.getBoundingClientRect();
  var nx=(cx-ir.left)/ir.width, ny=(cy-ir.top)/ir.height;
  if(nx<0||nx>1||ny<0||ny>1)return;
  var wr=wrap.getBoundingClientRect();
  ring.style.left=(cx-wr.left)+'px';ring.style.top=(cy-wr.top)+'px';
  ring.classList.remove('go');void ring.offsetWidth;ring.classList.add('go');
  if(ws.readyState===1) ws.send(JSON.stringify({nx:nx,ny:ny}));
}
img.addEventListener('click',function(ev){tap(ev.clientX,ev.clientY);});
</script>
</body></html>`;
}

// Union bounding box (viewport coords) of the visible CAPTCHA widget(s) so we can
// stream just that region: reCAPTCHA anchor (checkbox) + challenge (bframe),
// hCaptcha, Cloudflare Turnstile. Returns {x,y,width,height} or null (full page).
const CAPTCHA_CLIP_EXPR = `(function(){
  function box(el){ if(!el) return null; var r=el.getBoundingClientRect(); if(r.width<8||r.height<8) return null;
    var st=getComputedStyle(el); if(st.visibility==='hidden'||st.display==='none'||parseFloat(st.opacity||'1')<0.05) return null;
    if(r.bottom<0||r.right<0||r.top>innerHeight||r.left>innerWidth) return null; return {x:r.left,y:r.top,w:r.width,h:r.height}; }
  var sel=['iframe[src*="recaptcha/api2/anchor"]','iframe[src*="recaptcha/api2/bframe"]','iframe[src*="recaptcha/enterprise/anchor"]','iframe[src*="recaptcha/enterprise/bframe"]','iframe[title="reCAPTCHA"]','.g-recaptcha','[data-sitekey]','iframe[src*="hcaptcha.com"]','iframe[src*="newassets.hcaptcha.com"]','.h-captcha','.cf-turnstile','iframe[src*="challenges.cloudflare.com"]'];
  var rects=[];
  sel.forEach(function(s){ document.querySelectorAll(s).forEach(function(e){ var b=box(e); if(b)rects.push(b); var p=e.parentElement; if(p){var pb=box(p); if(pb&&pb.w<innerWidth*0.95)rects.push(pb);} }); });
  if(!rects.length) return null;
  var x0=Math.min.apply(null,rects.map(function(r){return r.x;})), y0=Math.min.apply(null,rects.map(function(r){return r.y;}));
  var x1=Math.max.apply(null,rects.map(function(r){return r.x+r.w;})), y1=Math.max.apply(null,rects.map(function(r){return r.y+r.h;}));
  var pad=10; x0=Math.max(0,x0-pad); y0=Math.max(0,y0-pad); x1=Math.min(innerWidth,x1+pad); y1=Math.min(innerHeight,y1+pad);
  return {x:Math.round(x0),y:Math.round(y0),width:Math.round(x1-x0),height:Math.round(y1-y0)};
})()`;

// ---------------------------------------------------------------------------
// Public tunnels. cloudflared (primary) streams WebSocket from a nearby edge =
// low latency; ssh tunnels (localhost.run -> pinggy) are the zero-binary fallback.
// ---------------------------------------------------------------------------

/** Download a URL to a file, following redirects (GitHub release -> CDN). */
async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const { Readable } = require('stream');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    Readable.fromWeb(res.body).pipe(out).on('finish', resolve).on('error', reject);
  });
}

/**
 * Wait until the public URL is reachable, or timeout. Critically, wait a few
 * seconds BEFORE the first lookup: querying the hostname before its DNS record
 * has propagated makes the system resolver negative-cache the miss, after which
 * every retry keeps failing for the negative-TTL even once the record appears.
 */
async function waitReachable(url, timeoutMs, initialDelayMs = 9000) {
  await new Promise((r) => setTimeout(r, initialDelayMs));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { method: 'GET', redirect: 'manual' }); if (r.status) return true; }
    catch { /* not propagated yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** Ensure a cloudflared binary exists (cached, auto-fetched once). null if unsupported/failed. */
async function ensureCloudflared(log) {
  const plat = process.platform, arch = process.arch;
  let asset, binName;
  if (plat === 'linux') { asset = arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64'; binName = 'cloudflared'; }
  else if (plat === 'win32') { asset = 'cloudflared-windows-amd64.exe'; binName = 'cloudflared.exe'; }
  else return null; // macOS ships a .tgz; fall back to ssh tunnels there
  const cacheDir = path.join(os.homedir(), '.cache', 'i-am-not-a-robot');
  const bin = path.join(cacheDir, binName);
  try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { /* not cached */ }
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
    log('external', 'fetching cloudflared binary (one-time, ~37MB)', { asset });
    await downloadFile(url, bin);
    if (plat !== 'win32') fs.chmodSync(bin, 0o755);
    return bin;
  } catch (e) { log('warn', 'cloudflared fetch failed — will use ssh tunnel', e && e.message); return null; }
}

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

  /** Open a public tunnel to the given local port. cloudflared first, then ssh. Resolves to URL or null. */
  async open(port, { timeoutMs = 20000 } = {}) {
    try {
      const url = await this._openCloudflared(port);
      if (url) { this.url = url; this.provider = 'cloudflared'; this.log('state', 'tunnel up', { provider: 'cloudflared', url }); return url; }
    } catch (e) { this.log('warn', 'cloudflared failed — trying ssh', e && e.message); }
    this.close(); // kill any half-spawned cloudflared before the fallback

    for (const prov of TUNNEL_PROVIDERS) {
      this.log('external', 'opening tunnel', { provider: prov.name, port });
      const url = await this._trySsh(prov, port, timeoutMs).catch((e) => {
        this.log('warn', 'tunnel provider failed', { provider: prov.name, err: e && e.message });
        return null;
      });
      if (url) { this.url = url; this.provider = prov.name; this.log('state', 'tunnel up', { provider: prov.name, url }); return url; }
      this.close();
    }
    this.log('warn', 'all tunnels failed — relay will be LAN-only');
    return null;
  }

  async _openCloudflared(port) {
    const bin = await ensureCloudflared(this.log);
    if (!bin) return null; // unsupported platform / fetch failed -> fall back to ssh
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate']);
      this.proc = proc;
      let buf = '';
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
      const onData = (d) => {
        buf += d.toString();
        if (buf.length > 65536) buf = buf.slice(-4096);
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m) {
          proc.stdout.removeListener('data', onData);
          proc.stderr.removeListener('data', onData);
          this.log('external', 'cloudflared url up — waiting for DNS', { url: m[0] });
          waitReachable(m[0], 20000).then((ok) => finish(ok ? resolve : reject, ok ? m[0] : new Error('cloudflared url not reachable')));
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => finish(reject, e));
      proc.on('exit', (code) => finish(reject, new Error(`cloudflared exited (${code})`)));
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } finish(reject, new Error('cloudflared timeout')); }, 50000);
    });
  }

  _trySsh(prov, port, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = spawn('ssh', prov.args(port));
      this.proc = proc; // assign immediately so close() can always kill it
      let buf = '';
      let settled = false;
      const finish = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
      const onData = (d) => {
        buf += d.toString();
        if (buf.length > 65536) buf = buf.slice(-4096);
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

/** One live relay session (a single active session at a time). */
class HumanRelay {
  constructor(opts = {}) {
    this.log = makeLogger(opts.log !== false);
    this.cdp = null;
    this.server = null;
    this.wss = null;
    this.wsClients = new Set();
    this.lastFrame = null; // base64 JPEG of the most recent frame
    this.clip = null; // current captcha bounding box (viewport coords); null = full page
    this._capTimer = null;
    this.vp = { w: 360, h: 640 };
    this.token = null;
    this.relayUrl = null;
    this.relayUrls = null;
    this.target = null;
    this.tunnel = null;
    this._killTimer = null;
  }

  /**
   * Connect via CDP, start the screencast, and serve the phone relay page + WS.
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

    // Stream just the CAPTCHA region (cropped) to the phone: clearer (a small
    // region at high quality) and focused on the one thing the human needs — not
    // the whole page/form the agent fills. Falls back to the full page if no
    // captcha widget is found.
    this._startCapture();
    this.log('state', 'captcha capture started');

    this.token = crypto.randomBytes(12).toString('hex');
    await this._startHttp({ host, port });

    // Public URL so the phone reaches the relay from anywhere with zero setup.
    const tunnelMode = tunnel !== undefined ? tunnel : (process.env.IAMNOTAROBOT_TUNNEL === 'off' ? 'off' : 'auto');
    if (tunnelMode !== 'off' && !host) {
      this.tunnel = new Tunnel(this.log);
      const localPort = this.server.address().port;
      const pub = await this.tunnel.open(localPort).catch((e) => { this.log('warn', 'tunnel open failed', e && e.message); return null; });
      if (pub) {
        const publicUrl = `${pub.replace(/\/+$/, '')}/r/${this.token}/`;
        this.relayUrls = [publicUrl, ...this.relayUrls];
        this.relayUrl = publicUrl;
      } else {
        this.tunnel = null;
      }
    }

    const maxMs = Number.isFinite(maxLifetimeMs) ? maxLifetimeMs : 15 * 60 * 1000;
    this._killTimer = setTimeout(() => { this.log('warn', 'relay hit max lifetime — auto-stopping'); this.stop(); }, maxMs);
    if (this._killTimer.unref) this._killTimer.unref();

    this.log('exit', 'relay live', { relayUrl: this.relayUrl, tunnel: this.tunnel ? this.tunnel.provider : 'none' });
    return { relayUrl: this.relayUrl, relayUrls: this.relayUrls, pageUrl: target.url, viewport: this.vp };
  }

  _startHttp({ host, port } = {}) {
    return new Promise((resolve, reject) => {
      const prefix = `/r/${this.token}`;
      const tokenBuf = Buffer.from(this.token);
      const checkToken = (reqPath) => {
        const parts = reqPath.split('/'); // ['', 'r', <token>, ...rest]
        const given = parts[2] || '';
        const ok = parts[1] === 'r' && given.length === this.token.length && crypto.timingSafeEqual(Buffer.from(given), tokenBuf);
        return ok ? parts : null;
      };

      const server = http.createServer((req, res) => {
        const reqPath = (req.url || '').split('?')[0];
        const parts = checkToken(reqPath);
        if (!parts) { this.log('warn', 'rejected request with bad/expired token'); res.writeHead(404).end('not found'); return; }
        const sub = '/' + parts.slice(3).join('/');
        if (sub === '/' && (req.method || 'GET') === 'GET') {
          this.log('debug', 'phone opened relay page');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ws: wss:",
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
          });
          res.end(renderPhonePage('i-am-not-a-robot · solve the CAPTCHA'));
          return;
        }
        res.writeHead(404).end('not found');
      });

      // WebSocket transport: binary JPEG frames down, JSON taps up.
      this.wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        const reqPath = (req.url || '').split('?')[0];
        const parts = checkToken(reqPath);
        if (!parts || parts[3] !== 'ws') { socket.destroy(); return; }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wsClients.add(ws);
          this.log('state', 'phone WS connected', { clients: this.wsClients.size });
          if (this.lastFrame) { try { ws.send(Buffer.from(this.lastFrame, 'base64')); } catch { /* noop */ } }
          ws.on('message', (data) => {
            try { const { nx, ny } = JSON.parse(data.toString()); this._tap(nx, ny); }
            catch (e) { this.log('error', 'bad WS tap message', e && e.message); }
          });
          ws.on('close', () => { this.wsClients.delete(ws); this.log('state', 'phone WS left', { clients: this.wsClients.size }); });
          ws.on('error', () => { this.wsClients.delete(ws); });
        });
      });

      server.on('error', reject);
      server.listen(port || 0, () => {
        const p = server.address().port;
        this.server = server;
        const ips = listIpv4();
        this.relayUrls = ips.map((ip) => `http://${ip}:${p}${prefix}/`);
        this.relayUrl = host ? `http://${host}:${p}${prefix}/` : this.relayUrls[0];
        this.log('state', 'relay http+ws listening', { primary: this.relayUrl, candidates: this.relayUrls });
        resolve();
      });
    });
  }

  /** Poll-capture the captcha region and push it to the phone over WS. */
  _startCapture() {
    this._lastClip = null; // last good captcha box, held through brief detection gaps
    this._missCount = 0;
    this._capTimer = setInterval(async () => {
      if (!this.cdp || this.cdp.closed) return;
      if (this.wsClients.size === 0 && this.lastFrame) return; // nobody watching
      try {
        let clip = await this._captchaClip();
        // Debounce: a momentary detection miss (mid-transition) shouldn't flicker
        // the whole page in. Hold the last good box for a few frames, then give up.
        if (clip) { this._lastClip = clip; this._missCount = 0; }
        else if (this._lastClip && this._missCount < 6) { this._missCount++; clip = this._lastClip; }
        else { this._missCount++; }
        this.clip = clip;
        const params = { format: 'jpeg', quality: 80 };
        if (clip) params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
        const shot = await this.cdp.send('Page.captureScreenshot', params);
        if (shot && shot.data) {
          this.lastFrame = shot.data;
          const bin = Buffer.from(shot.data, 'base64');
          for (const ws of this.wsClients) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(bin); } catch { /* client gone */ } } }
        }
      } catch { /* transient: mid-navigation, detached frame, etc. */ }
    }, 90);
    if (this._capTimer.unref) this._capTimer.unref();
  }

  /** Bounding box (viewport coords) of the visible CAPTCHA widget(s), or null for full page. */
  async _captchaClip() {
    try {
      const r = await this.cdp.send('Runtime.evaluate', { expression: CAPTCHA_CLIP_EXPR, returnByValue: true });
      return r && r.result && r.result.value ? r.result.value : null;
    } catch { return null; }
  }

  async _tap(nx, ny) {
    nx = Number(nx);
    ny = Number(ny);
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      this.log('warn', 'tap ignored: coords out of [0,1]', { nx, ny });
      return;
    }
    // Map the tap from the cropped image back to full-page coords via the clip.
    const clip = this.clip || { x: 0, y: 0, width: this.vp.w, height: this.vp.h };
    const x = Math.round(clip.x + nx * clip.width);
    const y = Math.round(clip.y + ny * clip.height);
    this.log('state', 'tap relayed -> page', { x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * Poll until the CAPTCHA token appears (reCAPTCHA v2/v3, hCaptcha, Turnstile),
   * or until timeout.
   * @returns {Promise<{passed:boolean, reason?:string}>}
   */
  async awaitSolve({ timeoutMs = 300000, pollMs = 1500 } = {}) {
    this.log('entry', 'await_human_solve', { timeoutMs, pollMs });
    if (!this.cdp) throw new Error('no active relay; call start_human_relay first');
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
          // tell the phone it worked before we tear the relay down (avoids a "stuck" look)
          for (const ws of this.wsClients) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'solved' })); } catch { /* noop */ } } }
          await new Promise((r2) => setTimeout(r2, 250));
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
    if (this._capTimer) { clearInterval(this._capTimer); this._capTimer = null; }
    try { if (this.tunnel) this.tunnel.close(); } catch { /* noop */ }
    for (const ws of this.wsClients) { try { ws.close(); } catch { /* noop */ } }
    this.wsClients.clear();
    try { if (this.wss) this.wss.close(); } catch { /* noop */ }
    try { if (this.server) this.server.close(); } catch { /* noop */ }
    try { if (this.cdp) this.cdp.close(); } catch { /* noop */ }
    this.cdp = null;
    this.server = null;
    this.wss = null;
    this.log('state', 'relay stopped');
  }
}

module.exports = { HumanRelay, CdpSession, Tunnel, detectLanIp, listIpv4, fetchTargets, ensureCloudflared };
