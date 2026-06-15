# RESUME — human-gate（接手點）

更新：2026-06-15

## 一句：而家喺邊
generic「ask-human」版 **KILL**（被 native MCP Elicitation + call-a-human-mcp cover）。
**收斂咗做窄版 + 技術實測 PASS**：agent 撞 **in-page CAPTCHA** → 喺對話貼 link → 用戶喺 **mobile agent chat** 用真手指 solve → CDP relay 入真 browser → Google 收貨 → agent resume。**真人解 = 合法（唔係 solver）。**

## ✅ 已驗證（唔使再證）
- `src/index.js` P0 `humanGate()` + ntfy + `npm run selftest` → 3/3 綠（text/approve/token-guard）。
- `experiments/relay-poc.mjs`：CDP `Page.startScreencast` 串畫面 + `Input.dispatchMouseEvent` forward tap。**2026-06-15 實測：Nicole 真手指 solve reCAPTCHA demo image-grid → aria-checked=true（PASSED），25 個 relay tap，無 bot-block。**
- 機制結論：screencast+CDP-relay 真人 solve，reCAPTCHA **收貨**。

## ⏭️ 下一步 = M1：包成 MCP server
- 形態：MCP stdio server（npm package）。唯一 integration 點 = **一條 CDP endpoint**（接 CDP = cover Playwright/Puppeteer/browser-use 全部，因為底層都係 CDP）。
- 兩個 tool：
  - `start_human_relay({ cdpUrl }) → { relayUrl }`（連 browser + screencast + 起 public URL；邏輯抄 `experiments/relay-poc.mjs`）
  - `await_human_solve() → { passed }`（poll reCAPTCHA aria-checked=true）
- agent 攞到 relayUrl 後，**自己喺對話貼**「Solve this CAPTCHA: <relayUrl>」——唔使 notification subsystem（用戶本身喺 mobile chat）。

## 之後
- M2：public URL（cloud browser 直出 / 本機自動 fetch cloudflared binary，checksum-pin，用完即斷 → publisher $0）。
- M3：UX 打磨（手機頁 responsive、pass 偵測穩、timeout/多輪 challenge）。
- M4：`/name-product` → ship npm + GitHub（README 強調 human-solves≠solver；唔提供 auto-solve code path）。

## Scope（老實切，唔好擴）
- ✅ in：用戶開住 mobile agent chat（Claude Code mobile / Codex / OpenClaw…）撞 CAPTCHA。
- ❌ out：全程無人睇 chat；Computer-use 截圖式 agent（冇 CDP attach 點）。

## 完整設計 + 三份研究
`~/MyGithub/agentic-journal/projects/products/human-gate/`
- `human-gate.md`（收斂 MVP 設計 + 逐個 objection 點拆）
- `research/reCAPTCHA研究-gap分析-2026-06-15.md`
- `research/AI-agent-human-handoff-市場研究-2026-06-15.md`
- `research/MCP競品-deepdive-2026-06-15.md`
