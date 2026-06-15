# RESUME — human-gate（接手點）

更新：2026-06-15

## 一句：而家喺邊
窄版（agent 撞 **in-page CAPTCHA** → 貼 link → 用戶 **mobile chat** 真手指 solve → CDP relay → Google 收貨 → agent resume）。**真人解 = 合法（唔係 solver）。**
**M1（MCP server）+ M2（自動 public tunnel）都完成 + E2E 全綠。** 任何用戶裝完即跨網絡用，零 setup。

## ✅ 已驗證（唔使再證）
- `src/index.js` P0 `humanGate()`（text/approve）+ ntfy + `npm run selftest` → **3/3 綠（今次 session re-confirm，無 regression）**。
- `experiments/relay-poc.mjs`：2026-06-15 Nicole 真手指 solve reCAPTCHA demo → aria-checked=true（PASSED），25 relay tap，無 bot-block。機制已證。
- **M1 MCP server**（`src/relay.js` raw CDP over `ws` 零 playwright；`src/mcp-server.js` 官方 SDK，tool：`start_human_relay`/`await_human_solve`）：
  - `test/mcp-e2e.js`（本地、tunnel off）→ **7/7 綠，連跑兩次 idempotent**。覆蓋 tools/list、start→relayUrl、relay HTML、SSE screencast frame、tap forward、await timeout=false、inject token→passed=true。
- **M2 自動 public tunnel**（`src/relay.js` 的 `Tunnel` class，零 binary，用機器本身 `ssh`）：
  - 先測過 SSE+tap 過唔過到 tunnel：pinggy（`ssh -p443 -R0:localhost:PORT a.pinggy.io`）**SSE status 200 / 3 frames / tap 200 全過**。
  - `test/tunnel-e2e.js`（經真 pinggy 公網）→ **4/4 綠**：start 自動開 tunnel→`https://…pinggy-free.link/r/<token>/`、relay 頁過公網、真 screencast frame 過 tunnel、tap 過 tunnel。
  - robustness：**pinggy(:443) + localhost.run(:22) 兩個免費 serverless provider 都 live 測過 SSE+tap 過到**，primary 失敗自動 fallback；LAN/Tailscale 仍做候選（`relayUrls` 排序 public→LAN→tailnet）；`stop()`/SIGTERM kill tunnel（**實測無 orphan ssh**）；`{host}` override 可 bypass tunnel（own-it 逃生門）。
  - ⚠️ 個別 provider 都驗證過，但「primary 失敗→fallback」嘅自動切換 loop 係 code-reviewed、未 force-fail pinggy 實測切換。
  - 跑：`npm run mcp`（起 server）/ `npm run mcp:e2e`（本地）/ `npm run mcp:tunnel-e2e`（公網，需 :9222）。

## 🧩 架構決定（lightness research 結論）
- 架構本身已最 light（screencast-relay irreducible：reCAPTCHA token 綁 session）。真正「更 light」= 同架構但減 npm 重量。
- **掟走 playwright → raw CDP over `ws`**。兼容性嚟自「連 CDP」（Playwright/Puppeteer/browser-use 全部 expose CDP），唔嚟自用唔用 playwright。
- **Nicole 拍板：robust > 字面 zero-dep**。WebSocket 用 `ws`（跨 OS 最穩、任何 Node 18+，唔使 flag）；MCP 用官方 SDK。runtime deps = `ws` + `@modelcontextprotocol/sdk`。
- **跨網絡係核心，唔係 M2 nice-to-have**（同 wifi 你人就喺電腦邊，根本唔使呢 tool）。**Tailscale 唔係產品答案**（叫用戶特登裝 = 多嚿魚）→ human-gate **自己開 zero-binary ssh tunnel** 俾所有人，zero setup。
- LAN IP 揀法：private LAN（192.168/10/172.16）優先，Tailscale CGNAT 排後做候選。

## ⏭️ 下一步
- **M3 UX 打磨**：手機頁 responsive、多輪 challenge、CDP 斷線 reconnect、tunnel 斷線重連、觸發穩定度（tool description 引導 agent 一撞即 call）。
- **真機測（仲未做）**：用真手機開 public URL（cellular）→ 真手指 solve → 確認真 Google token。今次 session 用程式注入 token 證 detect-logic，未喺真機行過。
- **M4 ship**：`/name-product` → npm + GitHub（README 強調 human-solves≠solver；唔提供 auto-solve code path；README 現仲寫 P2 roadmap，到時一齊更新）。

## ⚠️ 仲未驗證 / 已知 trade-off（老實標）
- **真手機 + 真手指 → 真 Google token** 未喺今次 session re-run（detect-logic 用注入 token 證；真 Google-accept 靠 2026-06-15 PoC）。
- **tunnel 默認靠免費第三方 host**（pinggy→localhost.run）：**Nicole 已拍板 = (A) 免費 + 每 user serverless（publisher 唔出錢、唔養 server）**。緩解「單一 host 消失」= 多免費 provider fallback（兩個都驗證過）；Nicole 自己用 Tailscale/own VPS 可完全 own-it。已知細節：free tier 60 分鐘 cap（對單次 solve 綽綽有餘）、URL 醜（係 tappable link，唔打字）。

## Scope（老實切）
- ✅ in：用戶開住 mobile agent chat 撞 CAPTCHA；agent 連得到一條 CDP endpoint。
- ❌ out：全程無人睇 chat；Computer-use 截圖式 agent（冇 CDP attach 點）。

## 完整設計 + 三份研究
`~/MyGithub/agentic-journal/projects/products/human-gate/`：`human-gate.md` + `research/`（reCAPTCHA / AI-agent-handoff / MCP競品）。
