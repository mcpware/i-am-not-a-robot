# I'm not a robot

*Your AI agent **is** the robot. When it hits the "I'm not a robot" box and can't tick it, `i-am-not-a-robot` sends the box to your phone — you tap it with your thumb, and the agent carries on.*

Hand an in-page CAPTCHA from your AI browser agent to a real human on their phone. They solve it with a finger, and the agent picks up where it left off.

Your agent is running browser automation while you are on a bus. It hits a reCAPTCHA. Today that either stalls until you get back to a computer, or you wire in a bulk CAPTCHA-solving service built for scraping. `i-am-not-a-robot` does neither. It streams the live browser page to your phone, forwards your taps back into the same browser session, and resumes the moment the challenge clears.

**This is a human-in-the-loop relay, not a solver.** It ships no auto-solve code and never tries to beat a CAPTCHA. A real person solves it. That is also why it does not rot every time Google ships a new challenge: there is no vision model to keep up to date.

It is also **phone-native**. Other human-in-the-loop tools hand you a live-view URL to drive the whole browser at a desktop. i-am-not-a-robot sends just the CAPTCHA to your phone and you solve it with your thumb, from anywhere. The agent's browser stays put on its own machine and IP, so the token it earns is natively valid.

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

The relay speaks raw CDP, the protocol that Playwright, Puppeteer, and browser-use all sit on top of. So the only thing i-am-not-a-robot needs from your agent is one CDP endpoint. It does not care which framework drew the browser.

## Install

As an MCP server, which is the main way to use it. For Claude Code:

```bash
claude mcp add i-am-not-a-robot -- npx -y i-am-not-a-robot
```

For any other MCP client, point it at the same command:

```json
{ "mcpServers": { "i-am-not-a-robot": { "command": "npx", "args": ["-y", "i-am-not-a-robot"] } } }
```

Node >= 18. Runtime dependencies: `ws` and `@modelcontextprotocol/sdk`.

## The two tools

**`start_human_relay({ cdpUrl, targetUrl? }) -> { relayUrl, relayUrls, pageUrl }`**
Connects to the agent's browser, starts the screencast, opens a public URL, and returns it. The agent posts `relayUrl` to you in chat. `targetUrl` is an optional substring to pick which page holds the CAPTCHA.

**`await_human_solve({ timeoutMs? }) -> { passed }`**
Polls until the CAPTCHA token shows up in the page (the challenge was accepted), or until timeout. The agent calls it after you open the link.

Your agent decides when to call these from their tool descriptions. A prompt like "if you hit a CAPTCHA you cannot solve, use i-am-not-a-robot to ask me" is enough.

## Bring your own browser

i-am-not-a-robot attaches over CDP, so your browser runs wherever you want: a laptop, a VPS, a container. Expose a CDP endpoint and pass its URL.

```js
// Playwright: launch Chromium with a CDP port, then hand the URL to i-am-not-a-robot
const browser = await chromium.launch({ args: ['--remote-debugging-port=9222'] });
// cdpUrl = "http://localhost:9222"
```

Puppeteer and browser-use expose the same kind of endpoint. Anything that speaks CDP works. Screenshot-only computer-use agents, which have no CDP attach point, are out of scope.

## Cross-network, zero setup

The whole point of this tool is the times you are not at the computer, so the phone and the agent are usually on different networks. i-am-not-a-robot handles that itself. On `start_human_relay` it opens a public HTTPS URL. By default it uses a [cloudflared](https://github.com/cloudflare/cloudflared) quick tunnel (auto-downloaded once, then cached): a nearby Cloudflare edge keeps the round-trip low (~50 ms in testing, vs ~180 ms for a single-server ssh tunnel) so tapping feels responsive, and it streams WebSocket cleanly. If cloudflared is unavailable it falls back to a zero-binary `ssh` tunnel (localhost.run, then pinggy). The tunnel closes when the relay stops.

If your machine and phone are on the same network (same wifi, or the same Tailscale tailnet), `relayUrls` also lists the LAN and tailnet URLs, which are direct and fastest. Power users can pass their own `{ host }` to skip the tunnel entirely.

The public-tunnel default leans on a free third-party host for convenience. This project hosts nothing, and you can always point it at your own.

## Supported challenges

i-am-not-a-robot crops the stream to just the CAPTCHA widget (the checkbox and its image challenge), so you see only what you act on, not the whole page the agent is filling. Detection covers reCAPTCHA v2/v3/Enterprise, hCaptcha, and Cloudflare Turnstile; an unrecognized widget falls back to streaming the full page. Automatic pass detection (the response token) is wired for those same widgets.

## How this compares

There are a few ways to get an agent past a CAPTCHA, and i-am-not-a-robot is in none of the usual buckets. Here is the honest version, including where the alternatives are the better choice.

| | Solver services (2Captcha, Anti-Captcha, CapMonster) | Desktop handoff (Pilot, hosted-browser live views) | i-am-not-a-robot |
|---|---|---|---|
| Who actually solves it | an AI, or a paid worker in a farm, off your session | a hired operator, or you, driving the whole browser at a desk | you, the real user, with a thumb, in the real session |
| Where the token is minted | the farm's device, shipped to you as a string | the real session | the real session |
| Holds up on reCAPTCHA v3 / Enterprise / Turnstile | weak: minted on a farm device, so it scores low or the clearance is turned away | strong | strong |
| What the helper can see | nothing, it is automated | your whole browser session | only the CAPTCHA widget |
| Usable from a phone, away from the desk | yes, it is an API | no, you need a computer | yes |
| Ships auto-solve code that breaks on each challenge update | yes | no | no |
| Cost | per solve, forever | per rescue or hosted browser | free, you host nothing |
| Built for thousands of unattended solves | yes, that is the whole point | no | no, one at a time, by design |

**Why not a solver like 2Captcha?**
A solver mints the token somewhere else and hands you the string. That is fine for a throwaway v2 checkbox and it scales to millions, so if your goal is to clear CAPTCHAs in bulk with no human, use one. It falls apart the moment a site actually cares. reCAPTCHA v3 and Enterprise score the session behind the token, and a farm session scores like a bot; Cloudflare ties a Turnstile clearance to the device it was issued to, so a token minted on the farm's machine comes back low or gets turned away. You also pay per solve, you carry auto-solve code that rots every time Google ships a new challenge, and the solving runs on machines that are not yours. i-am-not-a-robot puts a real finger in your real browser, so the token is an ordinary token from an ordinary session. It is the opposite trade: no scale, but it holds up where solvers do not, and it never tries to beat the test.

**Why not a desktop handoff like Pilot?**
Pilot and the hosted-browser live views solve the same blocker by handing a human a link to drive the whole browser, and that human is usually a paid operator who can see your entire session. Two things are different here. The person solving is you, the actual account owner, not a stranger on call. And you only ever see the CAPTCHA widget, cropped out of the page and sent to your phone, never the full desktop browser. Some MCP browser tools (Agent360, for one) pair an auto-solver with a pop-up on the same screen the agent runs on, which is still a solver on that machine, not a relay to your own phone.

**Why not just wait until you are back at the keyboard?**
Often the right call, and if you are always at your desk you do not need this. An agent earns its keep by running while you are away. This keeps it from stalling for an hour over one checkbox.

**Why a human at all, instead of a stored code?**
A CAPTCHA is not a 2FA secret. Nothing you can save in advance answers "pick every crosswalk", which is the whole reason the challenge exists. It needs a human gesture, so this gives it one, with the least interruption to you. For the steps that really are a code or a yes/no (OTP, 2FA, "approve this"), the package also ships `humanGate()`, which pushes those to your phone over ntfy.

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

If i-am-not-a-robot saves you a trip back to the keyboard, a star helps other people find it.
