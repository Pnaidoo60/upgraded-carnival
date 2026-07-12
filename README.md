# TradingView × Claude — Signal Analysis Dashboard

Receives TradingView alert webhooks, sends each alert to the Claude API for a
structured trading assessment (action / confidence / risk / factors), and
serves a live dashboard that visualizes the signal stream.

```
TradingView (Pine alert) ──▶ POST /webhook ──▶ Claude Messages API
                                   │                  │
                                   ▼                  ▼
                             signal store ◀── structured analysis (JSON schema)
                                   │
                                   ▼
                        GET /  (live dashboard: KPIs, charts, table)
```

## Quick start

```bash
npm install
cp .env.example .env    # add your ANTHROPIC_API_KEY
npm start               # http://localhost:3000
```

Without an `ANTHROPIC_API_KEY` the server runs in **mock mode** — a
deterministic heuristic stands in for Claude so the dashboard and tests work
end-to-end with no credentials.

Simulate a TradingView alert:

```bash
curl -s http://localhost:3000/webhook \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"BTCUSD","side":"buy","price":65000,"timeframe":"1h","strategy":"sma_cross_10_30"}'
```

Then open http://localhost:3000 — the dashboard polls every 5 seconds.

## Endpoints

| Method | Path           | Purpose                                             |
|--------|----------------|-----------------------------------------------------|
| POST   | `/webhook`     | TradingView alert intake (responds 200 immediately, analyzes async) |
| GET    | `/api/signals` | Recent signals + analyses (`?limit=N`, max 500)     |
| GET    | `/api/stats`   | Aggregates: totals, action counts, avg confidence   |
| GET    | `/api/portfolio` | Paper-trading portfolio: equity, positions, trades, decision log |
| GET    | `/api/broker`  | IBKR paper adapter status (enabled/connected/account) |
| POST   | `/api/portfolio/reset` | Reset the paper portfolio (requires `X-Webhook-Secret` when a secret is configured) |
| GET    | `/health`      | Liveness + analysis mode (`live` / `mock`)          |
| GET    | `/`            | Dashboard                                           |

## TradingView setup

1. Add [`pine/example-signal.pine`](pine/example-signal.pine) (SMA-cross
   example) to a chart, or add `alert()` calls with a JSON payload to your own
   script.
2. Create an alert with condition **"Any alert() function call"** and set the
   webhook URL to `https://<your-host>/webhook`.
3. Recommended payload fields: `symbol`, `side` (`buy`/`sell`), `price`,
   `timeframe`, `strategy`, plus `secret` matching your `WEBHOOK_SECRET`.

Plain-text alert messages are accepted too — they're wrapped as
`{"message": "..."}` and analyzed with lower confidence.

## Claude analysis

Each alert is sent to the Claude Messages API (`@anthropic-ai/sdk`, default
model `claude-opus-4-8`) with a JSON-schema-constrained output
(`output_config.format`), so responses are guaranteed to parse into:

```json
{
  "action": "buy | sell | hold",
  "confidence": 0.0,
  "risk": "low | medium | high",
  "summary": "one-two sentence assessment",
  "factors": ["key factors behind the assessment"]
}
```

The system prompt instructs Claude to be conservative — thin or ambiguous
payloads get `hold` with low confidence and an explanation of what's missing.

## Paper trading simulator

Every analyzed signal is fed to a built-in **paper broker** (`lib/paper.js`)
that maintains a virtual portfolio — ZAR by default (`PAPER_CURRENCY=R`).
**No real orders are ever placed.**

Rules and guardrails:

- Trades execute only when Claude's confidence ≥ `PAPER_MIN_CONFIDENCE` (default 60%).
- Buys spend `PAPER_POSITION_PCT` of equity (default 10%), capped at
  `PAPER_MAX_POSITION_PCT` per symbol (default 25%). Fractional quantities are
  supported, EasyEquities-style.
- Sells close the full position and realize P&L.
- `PAPER_ENABLED=false` is a kill switch — signals are still evaluated and
  logged, but nothing executes.
- Every decision (executed *or* skipped) is logged with its reason and shown
  on the dashboard, alongside the equity curve, open positions, realized /
  unrealized P&L, and win rate.

### Interactive Brokers paper mirroring (optional)

Set `BROKER=ibkr` to mirror every executed simulator trade to an
**Interactive Brokers paper account** via IB Gateway / TWS — fake money on
real markets, the proper staging step before any real execution. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the full go-live guide (public HTTPS URL
for TradingView, API keys, IB Gateway paper setup).

Safety lock, with no override: the adapter only accepts the paper API ports
(4002 / 7497) and only accounts whose ID starts with `D` (all IBKR paper
accounts). Real-money execution is deliberately not implemented.

### Why not a real EasyEquities paper account?

EasyEquities has **no official public trading API** — its APIs are
partner-only (Capitec / Discovery / Telkom integrations). Community clients
exist but are unofficial, read-oriented, and order placement through them
would be fragile and against the platform's terms. The simulator is therefore
the safe implementation for South African users today. `lib/paper.js` is
written as a broker adapter, so if EasyEquities (or another broker with a
paper environment, e.g. Alpaca) opens an API, a real adapter can replace the
simulator without touching the signal pipeline or dashboard.

## Security notes

- Set `WEBHOOK_SECRET` in production. Incoming alerts must carry it in the
  payload's `secret` field or an `X-Webhook-Secret` header (compared in
  constant time). The secret is stripped before storage and before anything is
  sent to Claude.
- Request bodies are capped at 64 KB.
- The analysis is **decision support, not financial advice**, and this service
  never places trades — wiring it to a broker is deliberately out of scope.

## Configuration

See [`.env.example`](.env.example): `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
`WEBHOOK_SECRET`, `PORT`, `DATA_FILE`.

## Tests

```bash
npm test
```

Boots the server in mock mode and exercises the webhook (auth, JSON and
plain-text payloads, size limits), the analysis pipeline, and the stats API.
