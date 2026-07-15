# Session notes — AAPL charts, indicators, daily report & deploy

A running summary of what was built so this is easy to pick up later.
Everything below is committed on branch `claude/test-connection-daltc1`
and bundled in **PR #3**.

## Quick links

- **Interactive chart snapshot (open anywhere, no setup):**
  https://claude.ai/code/artifact/2ee6b432-eabe-46f1-a51d-67a564f5738e
  (price + EMA 20/50, RSI, MACD with hover tooltips; static demo data)
- **Pull request #3:** https://github.com/Pnaidoo60/upgraded-carnival/pull/3
  (`claude/test-connection-daltc1` → `feature-1`)

## How to view the full dashboard

**Run locally** (needs Node 18+):

```bash
git clone https://github.com/Pnaidoo60/upgraded-carnival.git
cd upgraded-carnival
git checkout claude/test-connection-daltc1
npm install
npm start           # → http://localhost:3000
```

Optional: `ANTHROPIC_API_KEY=sk-ant-... npm start` for live Claude analysis
(otherwise it runs in mock mode). `Ctrl+C` to stop. If port 3000 is busy,
`PORT=3001 npm start`.

**Deploy to a public URL** (one command):

```bash
fly launch --copy-config --now
fly secrets set ANTHROPIC_API_KEY=sk-ant-... WEBHOOK_SECRET=$(openssl rand -hex 24)
```

→ `https://<app-name>.fly.dev`. Or use the `render.yaml` blueprint on Render.
See `DEPLOYMENT.md` → "Fastest path: one-command deploy".

## What was built this session

- **Dashboard charts** (`public/index.html`): AAPL candlesticks with EMA 20
  (blue) / EMA 50 (orange), plus aligned RSI(14) and MACD(12,26,9) panels,
  all with crosshair tooltips; light/dark themed.
- **Price/indicator API** (`lib/prices.js`, `GET /api/prices`): tries Stooq
  (keyless live data), falls back to deterministic synthetic demo data.
  Computes EMA/RSI/MACD.
- **Live TradingView widget** in the dashboard (NASDAQ:AAPL, daily) with
  bold blue/orange EMAs + RSI + MACD; degrades gracefully if unreachable.
- **Pine indicator** (`pine/ema-cross-signal.pine`): plots 20/50 EMA, marks
  crossovers, computes RSI + MACD, and sends them in the webhook payload.
- **Daily report** (`lib/chart-svg.js`, `scripts/daily-chart.mjs`): builds a
  self-contained HTML report with just `node` (no server/browser). Run with
  `node scripts/daily-chart.mjs AAPL`.
- **Deploy config**: `Dockerfile`, `fly.toml` (region jnb), `render.yaml`.
- **CI/CD**: `.github/workflows/ci.yml` (tests) and `deploy.yml` (gated
  Fly.io auto-deploy — add a `FLY_API_TOKEN` secret to enable).
- **Tests**: `npm test` — 32 passing.

## Scheduled job

A weekday Routine generates the AAPL report around US market open
(**3:32 PM SAST**, i.e. 13:32 UTC, Mon–Fri) and delivers it. It uses
synthetic demo data in environments without a live feed.

## Open follow-ups

- Wire in **real market data** (Stooq/Alpha Vantage/Finnhub/Twelve Data) so
  the dashboard and daily report show real AAPL prices — no schema change
  needed, just a source + key.
- Activate **auto-deploy**: create the Fly app, add `FLY_API_TOKEN` repo
  secret.
- **PR #3** is being watched for CI/review; merge when ready.
- Note: default branch is `feature-1`. Written state (`data/`) is ephemeral
  on PaaS hosts.
