# human-gate

**The missing `input()` for headless agents.**

Your AI browser agent is running while you're on a bus. It hits a step only a human can do — a CAPTCHA, a one-time code, a "confirm this purchase", an ambiguous form field. Today it either dies waiting for you to get back to a computer, or you reach for a bulk CAPTCHA-solving service built for scraping.

`human-gate` does the third thing: it **pauses the agent, pushes a screenshot to your phone, and resumes the moment you tap one answer.**

```js
const { humanGate } = require('human-gate');

const otp = await humanGate(page, {
  prompt: 'Login needs the OTP that was just texted to you. Type it.',
  expect: 'text',
  notify: { topic: 'my-agent-7f3a' },   // ntfy topic on your phone
});
await page.fill('#otp', otp);           // ...the agent carries on.
```

That's it. `page` is **your own** Playwright or Puppeteer page. No cloud session, no platform to migrate into.

## Why this exists (and what it is not)

Human-handoff for browser agents already exists — but in one shape: **"open a live-view URL and take over the whole browser yourself, at a desktop."** Browserbase, Browserless, Cloudflare Browser Run, and Amazon Nova Act all ship that. It's good, but it's **cloud-locked** and assumes you're sitting at a computer ready to drive.

`human-gate` ships the other shape:

1. **Bring your own browser — zero cloud lock-in.** It runs on the Playwright/Puppeteer page you already control, anywhere: your laptop, a VPS, an air-gapped box.
2. **Phone-native answer, not browser-takeover.** A push notification with a screenshot and one thing to do — type the code, tap Approve. You can be anywhere. You never open a browser session.
3. **One gate, every blocker.** CAPTCHA, OTP, 2FA, ambiguous field, approve/reject — one primitive, framework-agnostic (browser-use, LangGraph, raw Playwright, a cron script).

**This is not a CAPTCHA solver.** It does not break CAPTCHAs and ships no auto-solve code path. It relays the step to a real human — which is also why it doesn't rot every time Google ships a new challenge. Use it for automation **you are authorized to run** (your own accounts and tasks).

## Install

```bash
npm i human-gate
```

Node >= 18. Zero runtime dependencies. You bring Playwright or Puppeteer; the phone side is just the free [ntfy](https://ntfy.sh) app (or print the link and open it yourself).

## Usage

```js
const { humanGate } = require('human-gate');

// 1) Text answer (OTP, CAPTCHA word, a value to fill)
const code = await humanGate(page, {
  prompt: 'Type the 6-digit code',
  expect: 'text',
  notify: { topic: 'my-agent-7f3a' },
});

// 2) Approve / reject decision
const ok = await humanGate(page, {
  prompt: 'Approve this $42 purchase?',
  expect: 'approve',
  capture: '#cart-summary',         // screenshot just one element
  notify: { topic: 'my-agent-7f3a' },
});
if (!ok) throw new Error('human rejected');
```

### Options

| option | default | meaning |
|---|---|---|
| `prompt` | — | what to ask the human |
| `expect` | `'text'` | `'text'` returns a string; `'approve'` returns a boolean |
| `capture` | `'viewport'` | `'viewport'`, `'fullpage'`, or a CSS selector to screenshot |
| `notify` | — | `{ topic, server?, title?, priority? }` for ntfy. Omit to print the link |
| `host` | auto LAN IP | host/IP your phone uses to reach the relay |
| `port` | `0` | relay port (0 = ephemeral) |
| `timeoutMs` | `300000` | how long to wait for the human |
| `onReady(url)` | — | callback with the live relay URL (logging / custom relay / tests) |
| `log` | `true` | debug logging to stderr (`HUMAN_GATE_QUIET=1` also silences it) |

### How it works

1. Screenshot the current page (or one element).
2. Start a tiny one-time-token HTTP relay (Node built-ins only — no Express).
3. Push the link to your phone via ntfy.
4. You open it, see the screenshot, type/tap one answer.
5. The promise resolves with your answer; the relay shuts down.

The relay listens on your LAN by default. For a phone off your network, point `host` at a tunnel (e.g. `cloudflared`, `tailscale`) — not bundled, your call.

## Self-test (no browser/phone needed)

```bash
npm run selftest
```

Runs the full pause → answer → resume loop against a fake page for both `text` and `approve` modes, plus the one-time-token guard.

## Roadmap

- **P0 (now):** `humanGate()` + ntfy + text/approve, local relay. ✅
- **P1:** Telegram + Pushover adapters.
- **P2:** `live` mode — stream the browser to your phone (CDP screencast) and forward your taps, so you can operate an actual CAPTCHA challenge remotely.
- **P3:** timeout/retry policies, Puppeteer adapter parity, self-host ntfy guide, TypeScript types.

## License

MIT © Nicole Leung
