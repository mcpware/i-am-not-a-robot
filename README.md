# human-gate

Hand an in-page CAPTCHA from your AI browser agent to a real human on their phone. They solve it with a finger, and the agent picks up where it left off.

Your agent is running browser automation while you are on a bus. It hits a reCAPTCHA. Today that either stalls until you get back to a computer, or you wire in a bulk CAPTCHA-solving service built for scraping. `human-gate` does neither. It streams the live browser page to your phone, forwards your taps back into the same browser session, and resumes the moment the challenge clears.

**This is a human-in-the-loop relay, not a solver.** It ships no auto-solve code and never tries to beat a CAPTCHA. A real person solves it. That is also why it does not rot every time Google ships a new challenge: there is no vision model to keep up to date.

## How it works

```
your agent (browser over CDP) hits a CAPTCHA
   └─ calls MCP tool: start_human_relay({ cdpUrl })
        ├─ connects to the browser over CDP (raw protocol, no Playwright dependency)
        ├─ Page.startScreencast  → streams the challenge to a small web page
        ├─ opens a public URL for that page (auto ssh tunnel, see below)
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

The whole point of this tool is the times you are not at the computer, so the phone and the agent are usually on different networks. human-gate handles that itself. On `start_human_relay` it opens a public HTTPS URL using your machine's own `ssh` client, with no binary to download and no account. It tries pinggy first, then falls back to localhost.run. The tunnel closes when the relay stops.

If your machine and phone happen to be on the same network (same wifi, or the same Tailscale tailnet), `relayUrls` also lists the LAN and tailnet URLs and you can use those instead. Power users can pass their own `{ host }` to skip the tunnel entirely.

The default leans on a free third-party tunnel host for convenience. This project hosts nothing, and you can always point it at your own.

## Supported challenges

Automatic pass detection covers the response token for reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile. The relay streams and forwards taps for any visual challenge, so a human can drive whatever is on screen. The automatic "it passed" signal is what is tied to those three widgets.

## Security and intended use

- The relay URL carries a 96-bit random token in its path. Requests without it get a 404.
- The default is your own browser on your own machine. While a relay is open, its traffic routes through the tunnel host; nothing else leaves your machine.
- Use it for automation you are authorized to run, on your own accounts and tasks. It keeps a human in the loop and is single-user by design. It is not built for bulk use or for solving CAPTCHAs on someone else's behalf at scale.

## Also included: a phone-push gate for non-CAPTCHA steps

The package also ships `humanGate(page, { ... })`, a zero-dependency helper for the simpler case where the answer is text or a yes/no: an OTP code, a 2FA prompt, "approve this purchase". It screenshots the page, pushes a link to your phone over [ntfy](https://ntfy.sh), and resumes on your reply. See `examples/otp-demo.js`.

## Status

- MCP server with `start_human_relay` and `await_human_solve`: working, tested end to end.
- Auto public tunnel (pinggy, then localhost.run): working.
- `humanGate()` phone-push library for text/approve: working.

## License

MIT © Nicole Leung

If human-gate saves you a trip back to the keyboard, a star helps other people find it.
