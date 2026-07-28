# Going live: TradingView → Claude → IBKR paper trading

This guide takes you from the code in this repo to a running system where
your real TradingView strategies fire alerts, Claude analyzes them live, and
qualifying trades execute in an **Interactive Brokers paper account** (fake
money, real market) — the correct staging step before any conversation about
real execution.

```
TradingView alert ──HTTPS──▶ this server (your VPS) ──▶ Claude API (live)
                                    │
                                    ├─▶ built-in simulator (dashboard P&L)
                                    └─▶ IB Gateway (paper, port 4002) ──▶ IBKR paper account
```

## 0. Fastest path: one-command deploy to a real URL

If you just want the dashboard live on an HTTPS URL (no VPS, no reverse
proxy), the repo ships ready-to-deploy config. Both give you a public URL
with TLS handled for you.

**Fly.io** (`fly.toml`, region set to Johannesburg) — the most literal
one-command deploy:

```bash
# once: install flyctl (https://fly.io/docs/flyctl/install) and `fly auth login`
fly launch --copy-config --now          # builds the Dockerfile, deploys, prints your URL
fly secrets set ANTHROPIC_API_KEY=sk-ant-... WEBHOOK_SECRET=$(openssl rand -hex 24)
```

Your dashboard is then at `https://<app-name>.fly.dev` and the webhook at
`https://<app-name>.fly.dev/webhook`.

**Render** (`render.yaml` blueprint) — git-push based, has a free tier:
push this repo to GitHub, then in Render choose **New + → Blueprint** and
select the repo. It builds with Node and gives you an `onrender.com` URL.
Set `ANTHROPIC_API_KEY` and `WEBHOOK_SECRET` in the service's Environment
tab. (Free instances sleep when idle — fine for trying it out, but use a
paid instance if you need webhooks answered instantly.)

Both build from the same app; the `Dockerfile` also runs on Railway, Cloud
Run, or any container host. Note that written state (`data/`) is ephemeral
on these platforms and resets on redeploy — attach a volume if you need it
to persist. For the IBKR paper-trading loop, use the VPS route below (IB
Gateway needs to run alongside the server).

## 1. Get the server a public HTTPS URL (VPS route)

TradingView webhooks only deliver to **ports 80/443** on a publicly
reachable host, so the server must run somewhere public — a small VPS
(Hetzner/DigitalOcean/Afrihost), or a PaaS like Render/Fly/Railway.

VPS route (recommended, since IB Gateway can run on the same box):

```bash
git clone https://github.com/Pnaidoo60/upgraded-carnival.git
cd upgraded-carnival
npm install
cp .env.example .env   # then edit .env — see step 2
npm start              # listens on :3000
```

Put a reverse proxy with TLS in front. [Caddy](https://caddyserver.com) is
the least work:

```
# /etc/caddy/Caddyfile
signals.yourdomain.co.za {
    reverse_proxy 127.0.0.1:3000
}
```

Keep the process alive with systemd or `pm2 start server.js`.

## 2. Set your keys (in `.env` on the server — never in git)

```dotenv
ANTHROPIC_API_KEY=sk-ant-...     # from https://platform.claude.com → API keys
ANTHROPIC_MODEL=claude-opus-4-8
WEBHOOK_SECRET=<long random string>   # e.g. `openssl rand -hex 24`
PAPER_MIN_CONFIDENCE=0.6
```

Check it worked: `curl https://signals.yourdomain.co.za/health` should return
`"mode":"live"`.

> Your Anthropic key lives only in the server's `.env`. Never commit it,
> never put it in the TradingView alert, never share it in chat.

## 3. Set up the IBKR paper account + IB Gateway

1. Open an IBKR account (ZA residents can sign up through IBKR directly).
   Every account automatically gets a **paper trading account** — the ID
   starts with `DU`. You can trade JSE-listed and US stocks on paper.
2. Install **IB Gateway** (lighter than TWS) on the same VPS, log it into
   your **paper** username, and in *Configure → Settings → API*:
   - enable *ActiveX and Socket Clients*
   - socket port **4002** (the paper port)
   - trusted IP `127.0.0.1`
3. In `.env`:

```dotenv
BROKER=ibkr
IBKR_HOST=127.0.0.1
IBKR_PORT=4002          # 4002 = IB Gateway paper, 7497 = TWS paper
IBKR_EXCHANGE=SMART
IBKR_CURRENCY=USD       # or ZAR for JSE symbols; per-alert override supported
```

**Safety lock:** the adapter refuses live ports (7496/4001) and any account
whose ID doesn't start with `D` (all IBKR paper accounts do). There is no
override — real-money execution is deliberately not implemented in this
codebase.

Restart the server; the log should show
`IBKR connected: paper account DU…`, and the dashboard badge shows
`IBKR paper DU… connected`.

## 4. Point TradingView at it

1. Add your strategy (or `pine/example-signal.pine`) to a chart.
2. Create an alert → condition **"Any alert() function call"** →
   Notifications tab → **Webhook URL** = `https://signals.yourdomain.co.za/webhook`.
3. Make sure the alert payload includes your secret and a symbol IBKR can
   trade, e.g.:

```json
{"secret":"<your WEBHOOK_SECRET>","symbol":"NASDAQ:AAPL","side":"buy","price":{{close}},"timeframe":"{{interval}}"}
```

Optional per-alert fields: `"currency":"ZAR"`, `"exchange":"JSE"` for
JSE-listed instruments.

> Webhook alerts require a TradingView paid plan (Essential and up).

## 5. Verify the full loop

```bash
curl -s https://signals.yourdomain.co.za/webhook \
  -H 'Content-Type: application/json' \
  -d '{"secret":"<secret>","symbol":"NASDAQ:AAPL","side":"buy","price":210,"timeframe":"1h","strategy":"manual-test"}'
```

Then check:
- dashboard: signal appears, Claude's analysis fills in, decision log shows
  `buy executed · IBKR order #… (n sh)`
- IB Gateway / IBKR portal: the paper order shows in the paper account
- `GET /api/broker`: `"connected": true, "paperVerified": true`

## 6. Before ever considering real money

Run the paper setup for weeks, then review on the dashboard: win rate,
realized P&L vs. buy-and-hold, how often Claude vetoed your strategy
(`analysis says hold` / `below threshold` rows), and max drawdown on the
equity curve. Only after that evidence exists is a real-execution
conversation worth having — and that would be a deliberate, separate change
(this codebase's IBKR adapter will refuse live accounts as-is).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `mode":"mock"` in /health | `ANTHROPIC_API_KEY` not visible to the process — check `.env` and restart |
| TradingView says webhook failed | URL not HTTPS on 443, or server down — test with the curl above |
| `refusing account "U…"` in logs | IB Gateway is logged into your **live** account — log into the paper one |
| `timed out connecting to IB Gateway` | Gateway not running, API not enabled, or wrong port (paper = 4002/7497) |
| Orders skipped `quantity below 1 whole share` | Position sizing too small for the share price — raise `PAPER_POSITION_PCT` or starting cash |
| IBKR "no security definition" errors | Symbol/exchange/currency combination IBKR doesn't recognize — set `"exchange"`/`"currency"` in the alert payload |
