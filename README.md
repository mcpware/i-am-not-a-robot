# human-gate

Hand an in-page CAPTCHA from your AI browser agent to a real human on their phone. They solve it with a finger, and the agent picks up where it left off.

Your agent is running browser automation while you are on a bus. It hits a reCAPTCHA. Today that either stalls until you get back to a computer, or you wire in a bulk CAPTCHA-solving service built for scraping. `human-gate` does neither. It streams the live browser page to your phone, forwards your taps back into the same browser session, and resumes the moment the challenge clears.

**This is a human-in-the-loop relay, not a solver.** It ships no auto-solve code and never tries to beat a CAPTCHA. A real person solves it. That is also why it does not rot every time Google ships a new challenge: there is no vision model to keep up to date.

It is also **phone-native**. Other human-in-the-loop tools hand you a live-view URL to drive the whole browser at a desktop. human-gate sends just the CAPTCHA to your phone and you solve it with your thumb, from anywhere. The agent's browser stays put on its own machine and IP, so the token it earns is natively valid.

## How it works

```
your agent (browser over CDP) hits a CAPTCHA
   └─ calls MCP tool: start_human_relay({ cdpUrl })
        ├─ connects to the browser over CDP (raw protocol, no Playwright dependency)
        ├─ captures just the CAPTCHA widget and streams it over a WebSocket to a phone page
        ├─ opens a fast public URL for that page (cloudflared, see below)
        └─ returns relayUrl
   └─ the agent posts the link in chat: "Solve this CAPTCHA: <relayUrl>"
        └─ you open it on your phone, see the live challenge, tap the tiles
             └─ each tap → Input.dispatchMouseEvent → the real browser
   └─ the agent calls await_human_solve(), which polls until the token appears
   └─ passed: true → the agent continues
```

The relay speaks raw CDP, the protocol that Playwright, Puppeteer, and browser-use all sit on top of. So the only thing human-gate needs from your agent is one CDP endpoint. It does not care which framework drew the browser.

## Install

As an MCP server, which is the main way to use it. For Claude Code:

```bash
claude mcp add human-gate -- npx -y human-gate
```

For any other MCP client, point it at the same command:

```json
{ "mcpServers": { "human-gate": { "command": "npx", "args": ["-y", "human-gate"] } } }
```

Node >= 18. Runtime dependencies: `ws` and `@modelcontextprotocol/sdk`.

## The two tools

**`start_human_relay({ cdpUrl, targetUrl? }) -> { relayUrl, relayUrls, pageUrl }`**
Connects to the agent's browser, starts the screencast, opens a public URL, and returns it. The agent posts `relayUrl` to you in chat. `targetUrl` is an optional substring to pick which page holds the CAPTCHA.

**`await_human_solve({ timeoutMs? }) -> { passed }`**
Polls until the CAPTCHA token shows up in the page (the challenge was accepted), or until timeout. The agent calls it after you open the link.

Your agent decides when to call these from their tool descriptions. A prompt like "if you hit a CAPTCHA you cannot solve, use human-gate to ask me" is enough.

## Bring your own browser

human-gate attaches over CDP, so your browser runs wherever you want: a laptop, a VPS, a container. Expose a CDP endpoint and pass its URL.

```js
// Playwright: launch Chromium with a CDP port, then hand the URL to human-gate
const browser = await chromium.launch({ args: ['--remote-debugging-port=9222'] });
// cdpUrl = "http://localhost:9222"
```

Puppeteer and browser-use expose the same kind of endpoint. Anything that speaks CDP works. Screenshot-only computer-use agents, which have no CDP attach point, are out of scope.

## Cross-network, zero setup

The whole point of this tool is the times you are not at the computer, so the phone and the agent are usually on different networks. human-gate handles that itself. On `start_human_relay` it opens a public HTTPS URL. By default it uses a [cloudflared](https://github.com/cloudflare/cloudflared) quick tunnel (auto-downloaded once, then cached): a nearby Cloudflare edge keeps the round-trip low (~50 ms in testing, vs ~180 ms for a single-server ssh tunnel) so tapping feels responsive, and it streams WebSocket cleanly. If cloudflared is unavailable it falls back to a zero-binary `ssh` tunnel (localhost.run, then pinggy). The tunnel closes when the relay stops.

If your machine and phone are on the same network (same wifi, or the same Tailscale tailnet), `relayUrls` also lists the LAN and tailnet URLs, which are direct and fastest. Power users can pass their own `{ host }` to skip the tunnel entirely.

The public-tunnel default leans on a free third-party host for convenience. This project hosts nothing, and you can always point it at your own.

## Supported challenges

human-gate crops the stream to just the CAPTCHA widget (the checkbox and its image challenge), so you see only what you act on, not the whole page the agent is filling. Detection covers reCAPTCHA v2/v3/Enterprise, hCaptcha, and Cloudflare Turnstile; an unrecognized widget falls back to streaming the full page. Automatic pass detection (the response token) is wired for those same widgets.

## Security and intended use

- The relay URL carries a 96-bit random token in its path. Requests without it get a 404.
- The default is your own browser on your own machine. While a relay is open, its traffic routes through the tunnel host; nothing else leaves your machine.
- Use it for automation you are authorized to run, on your own accounts and tasks. It keeps a human in the loop and is single-user by design. It is not built for bulk use or for solving CAPTCHAs on someone else's behalf at scale.

## Also included: a phone-push gate for non-CAPTCHA steps

The package also ships `humanGate(page, { ... })`, a zero-dependency helper for the simpler case where the answer is text or a yes/no: an OTP code, a 2FA prompt, "approve this purchase". It screenshots the page, pushes a link to your phone over [ntfy](https://ntfy.sh), and resumes on your reply. See `examples/otp-demo.js`.

## Status

- MCP server (`start_human_relay` + `await_human_solve`): working, verified end to end on a real phone (real reCAPTCHA image challenges, real tokens).
- WebSocket transport, captcha-only crop, cloudflared fast tunnel with ssh fallback: working.
- `humanGate()` phone-push library for text/approve (OTP, 2FA, confirm): working.

## License

MIT © Nicole Leung

If human-gate saves you a trip back to the keyboard, a star helps other people find it.
