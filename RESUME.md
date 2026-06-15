# RESUME — human-gate（接手點）

更新：2026-06-15

## 一句：而家喺邊
窄版 in-page CAPTCHA 電話 relay（agent 撞 CAPTCHA → 貼 link → 用戶 mobile chat 真手指 solve → CDP relay → token 收貨 → agent resume）。**真人解 = 合法（唔係 solver）。**
**M1+M2+M3 完成、2 輪獨立 Opus review、QA 全綠、真機測 PASS = release-ready。** 只差正式 publish（不可逆，等 Nicole go）。

## ✅ 已驗證（QA 全綠，今次 session 跑過）
- P0 `humanGate()`（text/approve + ntfy）：`npm run selftest` → **3/3**。
- 核心 MCP E2E（`npm run mcp:e2e`，本地 tunnel off）：**7/7，idempotent**。
- 公網 tunnel E2E（`npm run mcp:tunnel-e2e`，經真 pinggy）：**4/4**（public URL、relay 頁、真 screencast frame、tap 全部過公網）。
- 兩個免費 serverless tunnel provider（localhost.run:22 / pinggy:443）都 live 測過 SSE+tap。
- **真機 E2E PASS（2026-06-15）**：Nicole 真 iPhone Safari → localhost.run URL → 8 下真手指 tap 經 CDP → 真 reCAPTCHA → **真 Google token（2276 字、`0cAF…`）→ passed=true**。冇用注入 token。
- 偵測到 solve → 推 SSE `event: solved` 去手機（顯示「✓ Solved, close this page」，唔再凍結似卡機）——程式實測 phone 收到。
- Security 加固實測：bad token→404、CSP/nosniff、method-guard→405、tap server 端 clamp、double-stop/restart 冪等、**無 orphan ssh**。
- 零 playwright（raw CDP over `ws`）、deps 淨 `ws` + `@modelcontextprotocol/sdk`。

## 🧩 形態 + 架構決定
- MCP stdio server（npm `human-gate`，`npx human-gate` / `claude mcp add`）。唯一 integration 點 = 一條 CDP endpoint。
- **掟走 playwright → raw CDP over `ws`**；robust > 字面 zero-dep（Nicole 拍板）；MCP 用官方 SDK。
- 兩個 tool：`start_human_relay({cdpUrl,targetUrl?})→{relayUrl,relayUrls,pageUrl}`、`await_human_solve({timeoutMs?})→{passed}`。
- **跨網絡 = 核心**（同 wifi 你人就喺電腦邊，唔使呢 tool）。**Tailscale 唔係產品答案**（叫人特登裝 = 多嚿魚）→ human-gate **自己用機器 `ssh` 開免費 serverless tunnel**（**localhost.run primary → pinggy fallback**），每 user 自己一條、用完即斷、publisher $0。`{host}` 可 bypass。
  - ⚠️ **pinggy 免費版對 browser User-Agent 彈自己個 interstitial 警告頁（實測 verified）→ 真手機 load 唔到我哋個頁**，所以 localhost.run 做 primary（browser 直接過到）；pinggy 只做 :22-被擋網絡嘅 fallback（用戶要撳穿 interstitial）。
- M3 加固（2 輪 review）：exact-segment + `timingSafeEqual` token guard、CSP/nosniff、GET-only method guard、`/tap` server clamp、`fetch` redirect:manual+timeout、CDP port-match guard、15 分鐘 relay lifetime cap、每條失敗/遺棄路徑都 cleanup、singleton-swap race guard、docker/link-local IP 隔離、pass-detection 擴到 reCAPTCHA+hCaptcha+Turnstile、await reason codes。

## ⏭️ 下一步（按優先）
1. **Publish（等 Nicole go，不可逆）**：見下「Publish 步驟」。
2. M4 patch（非 blocker）：viewport-on-nav drift（見「已知限制」）。

## 📦 Publish 步驟（prep 好，等 Nicole 親自 go — 不可逆/對外）
```bash
cd ~/MyGithub/human-gate
npm publish --access public        # name=human-gate (npm 上未被佔，已查)
# GitHub：開 public repo mcpware/human-gate（或 nicole/…）→ git remote add origin … → git push -u origin master
```
- npm 未登入就 `npm login` 先。publish 前可 `npm pack --dry-run` 睇 tarball（應只含 src/ + README + LICENSE）。
- README 已強調 human-solves≠solver、唔提供 auto-solve code path。

## ⚠️ 已知限制 / trade-off（老實標）
- **viewport-on-navigation drift（M4）**：`vp` 喺 start 一次過攞；若 solve 中途 page 導航令 innerWidth 變，tap 座標會偏。CAPTCHA solve 好少中途導航，列為 patch。
- **tunnel 默認靠免費第三方**（pinggy/localhost.run）：Nicole 拍板可接受（每 user serverless、publisher $0）；緩解 = 多 provider fallback + `{host}` 可指自己。free tier 60 分鐘 cap（單次 solve 綽綽有餘）、URL 醜（tappable link，唔打字）。

## Scope
- ✅ in：用戶開住 mobile agent chat 撞 CAPTCHA；agent 連得到一條 CDP endpoint（Playwright/Puppeteer/browser-use…）。
- ❌ out：全程無人睇 chat；Computer-use 截圖式 agent（冇 CDP attach 點）。

## 檔案地圖
- `src/relay.js`（CDP relay + Tunnel，raw `ws`）、`src/mcp-server.js`（2 tool）、`src/index.js`（P0 humanGate lib）、`test/mcp-e2e.js`、`test/tunnel-e2e.js`、`examples/captcha-demo.js`（programmatic）、`examples/otp-demo.js`（lib）。
- 設計 + 研究：`~/MyGithub/agentic-journal/projects/products/human-gate/`。
