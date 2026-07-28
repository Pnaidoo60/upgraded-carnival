# Deploying to Render

Render gives the app a public HTTPS URL out of the box — which is exactly what
TradingView webhooks need. This repo ships a [`render.yaml`](render.yaml)
Blueprint, so deployment is mostly clicks + pasting two secrets.

> **Scope:** this deploys the dashboard + live Claude analysis + the built-in
> paper-trading simulator. IBKR paper mirroring needs IB Gateway on a host you
> control — see § Interactive Brokers at the end. Start with the simulator; add
> IBKR later.

## 1. One-click Blueprint deploy

1. Make sure this repo is on your GitHub (it is: `Pnaidoo60/upgraded-carnival`).
2. In Render: **New → Blueprint** → connect the repo → Render reads
   `render.yaml` and shows a `tradingview-claude-dashboard` web service with a
   1 GB disk.
3. It will prompt for the two `sync: false` secrets — fill them in:
   - **`ANTHROPIC_API_KEY`** — from https://platform.claude.com → API keys
   - **`WEBHOOK_SECRET`** — any long random string. Generate one:
     `openssl rand -hex 24`
4. **Apply** → Render builds (`npm install`) and starts (`npm start`).

When it's live you get a URL like
`https://tradingview-claude-dashboard.onrender.com`.

### Verify

```bash
# should return {"ok":true,"mode":"live",...}  ("live" = your API key is working)
curl https://<your-app>.onrender.com/health

# post a test alert (use your WEBHOOK_SECRET)
curl -s https://<your-app>.onrender.com/webhook \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<WEBHOOK_SECRET>","symbol":"NASDAQ:AAPL","side":"buy","price":210,"timeframe":"1h","strategy":"deploy-test"}'
```

Open `https://<your-app>.onrender.com/` — the dashboard should show the test
signal with a real Claude assessment.

## 2. Point TradingView at it

1. Add your strategy (or `pine/example-signal.pine`) to a chart.
2. Create an alert → condition **"Any alert() function call"** → **Notifications
   → Webhook URL** = `https://<your-app>.onrender.com/webhook`.
3. Alert message (JSON) must include your secret and a tradeable symbol:

```json
{"secret":"<WEBHOOK_SECRET>","symbol":"NASDAQ:AAPL","side":"buy","price":{{close}},"timeframe":"{{interval}}"}
```

> TradingView webhooks require a paid TradingView plan (Essential+).

## 3. Plan & persistence notes

- **`starter` plan ($7/mo, always-on)** is set in the Blueprint. This matters:
  Render's **free** web services spin down after ~15 min idle and cold-start on
  the next request — a TradingView webhook could hit a sleeping service and be
  dropped. For a signal listener you want always-on.
- **Persistent disk** (`/data`, 1 GB) keeps `signals.json` and `portfolio.json`
  across deploys and restarts. Without it, Render's filesystem is ephemeral and
  your portfolio history would reset on every deploy. (Disks require a paid
  instance, which lines up with the always-on recommendation.)
- **Region** is set to `frankfurt` (Render's closest to South Africa). Change it
  in `render.yaml` if you prefer another.

## 4. Manual setup (without the Blueprint)

If you'd rather click through the dashboard instead of using `render.yaml`:

1. **New → Web Service** → connect the repo, branch `feature-1`.
2. Runtime **Node**, Build `npm install`, Start `npm start`, Health check path
   `/health`, plan **Starter**.
3. **Environment** tab → add every var from `render.yaml`'s `envVars` (secrets
   `ANTHROPIC_API_KEY` / `WEBHOOK_SECRET` as-is; the rest with the values
   shown).
4. **Disks** tab → add a disk mounted at `/data` (1 GB).
5. Deploy.

## 5. Interactive Brokers (optional, later)

IBKR paper mirroring is **not** enabled on Render — IB Gateway is a stateful GUI
app that has to run somewhere it can hold a logged-in session, which a
stateless PaaS instance can't do. Two paths when you're ready:

- **Simplest:** run IB Gateway on a small always-on VPS (or your own always-on
  machine) logged into your paper account, expose its paper port over a private
  tunnel, and set `BROKER=ibkr` + `IBKR_HOST`/`IBKR_PORT` on the Render service
  to point at it.
- **All-in-one:** skip Render for the IBKR stage and run everything on one VPS
  per [`DEPLOYMENT.md`](DEPLOYMENT.md), where the app and IB Gateway sit on the
  same box.

Either way the paper-only safety lock still applies: the adapter refuses live
ports and non-paper accounts.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` shows `"mode":"mock"` | `ANTHROPIC_API_KEY` not set on the service — add it in the Environment tab and redeploy |
| Webhook returns 401 | Alert payload's `secret` doesn't match `WEBHOOK_SECRET` |
| Portfolio resets after a deploy | Disk not mounted at `/data`, or `DATA_FILE`/`PORTFOLIO_FILE` not pointing there |
| First request after idle is slow / dropped | On free plan — upgrade to Starter for always-on |
