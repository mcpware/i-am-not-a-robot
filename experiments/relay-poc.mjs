import pkg from '/tmp/pw/node_modules/playwright-core/index.js'; const { chromium } = pkg;
import http from 'http';
import os from 'os';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function lanIp() {
  for (const ds of Object.values(os.networkInterfaces()))
    for (const d of ds || []) if (d.family === 'IPv4' && !d.internal) return d.address;
  return '127.0.0.1';
}

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];

// fresh demo + summon a challenge
let page = ctx.pages().find((p) => /recaptcha\/api2\/demo/.test(p.url()));
if (!page) page = await ctx.newPage();
await page.goto('https://www.google.com/recaptcha/api2/demo', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
const anchor = page.frames().find((f) => /recaptcha.*anchor/i.test(f.url()));
if (anchor) {
  await anchor.locator('#recaptcha-anchor').click().catch(() => {});
  await page.waitForTimeout(2500);
}
const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
log('viewport', vp);

// CDP screencast + input
const client = await ctx.newCDPSession(page);
const sseClients = new Set();
let lastFrame = null;
client.on('Page.screencastFrame', async ({ data, sessionId }) => {
  lastFrame = data;
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch {}
  }
  try { await client.send('Page.screencastFrameAck', { sessionId }); } catch {}
});
await client.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: vp.w, maxHeight: vp.h, everyNthFrame: 1 });
log('screencast started');

async function tapPage(nx, ny) {
  const x = Math.round(nx * vp.w), y = Math.round(ny * vp.h);
  log('TAP relayed -> page', { x, y });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const PAGE_HTML = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1,user-scalable=no">
<body style="margin:0;background:#111;font-family:system-ui;color:#eee;text-align:center">
<div style="padding:6px;font-size:13px">human-gate live relay — tap the buses + VERIFY with your finger</div>
<img id=v style="width:100%;display:block" src="">
<script>
const img=document.getElementById('v');
const es=new EventSource('/stream');
es.onmessage=e=>{img.src='data:image/jpeg;base64,'+e.data;};
img.addEventListener('click',ev=>{
  const r=img.getBoundingClientRect();
  const nx=(ev.clientX-r.left)/r.width, ny=(ev.clientY-r.top)/r.height;
  fetch('/tap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nx,ny})});
});
</script></body>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE_HTML); return; }
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (lastFrame) res.write(`data: ${lastFrame}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.url === '/tap' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
      try { const { nx, ny } = JSON.parse(b); await tapPage(nx, ny); } catch (e) { log('tap err', e.message); }
      res.writeHead(200).end('ok');
    });
    return;
  }
  res.writeHead(404).end();
});
const port = 8787;
server.listen(port, () => log('RELAY URL ->', `http://${lanIp()}:${port}/`, ' (also http://127.0.0.1:' + port + '/ on this machine)'));

// poll for pass/fail
let lastState = null;
const poll = setInterval(async () => {
  try {
    const a = page.frames().find((f) => /recaptcha.*anchor/i.test(f.url()));
    if (!a) return;
    const checked = await a.locator('#recaptcha-anchor').getAttribute('aria-checked').catch(() => null);
    if (checked !== lastState) { lastState = checked; log('reCAPTCHA aria-checked =', checked); }
    if (checked === 'true') {
      log('==== RESULT: PASSED ✅  Google accepted the relayed human solve ====');
      clearInterval(poll);
    }
  } catch {}
}, 1500);

// safety auto-exit after 8 min
setTimeout(() => { log('timeout, exiting'); process.exit(0); }, 8 * 60 * 1000);
