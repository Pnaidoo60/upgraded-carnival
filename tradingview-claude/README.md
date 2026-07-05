# TradingView × Claude — Signal Desk

A small, runnable version of the Claude ↔ TradingView integration that the
`claudlink` notes in this repo describe. It:

1. Receives TradingView webhook alerts at `POST /webhook`.
2. Sends each alert to the Claude API for a structured recommendation
   (action + confidence + risk + reasoning).
3. **Paper-trades** that recommendation against a simulated portfolio — no
   broker, no real money — so you can practice strategies safely.
4. Shows every signal, Claude's verdict, and your paper portfolio (equity,
   positions, P&L) on a live dashboard at `/`.

This is a **new, self-contained project** in its own folder — it does not touch
the existing `claudlink` file at the repo root.

```
TradingView alert ──webhook──▶ /webhook ──▶ Claude API ──▶ dashboard
```

## Quick start

```bash
cd tradingview-claude
npm install
cp .env.example .env          # then edit .env and add your ANTHROPIC_API_KEY
npm start
```

Open http://localhost:3000/ and, in another terminal, fire a fake alert:

```bash
npm run test:signal
```

You'll see the signal appear on the dashboard and, a moment later, Claude's
recommendation fill in. No API key yet? The server still runs and records
signals — it just skips the analysis step and tells you so.

## Connecting real TradingView alerts

1. Deploy this server somewhere with a public HTTPS URL (Render, Railway,
   Fly.io, a VPS, or expose localhost with `ngrok http 3000`).
2. Set `WEBHOOK_SECRET` in `.env` to a random string.
3. In `pine/strategy.pine`, uncomment the `secret` line and set the same value.
4. Add the Pine script to a chart, create an alert with condition
   **"Any alert() function call"**, and set the webhook URL to
   `https://your-host/webhook`.

The Pine script already emits valid JSON, so TradingView's alert message can be
left as the script's `alert()` output.

## What Claude returns

For each alert, `POST /webhook` triggers a Claude call that returns
guaranteed-parseable JSON (via structured outputs):

```json
{
  "action": "buy",
  "confidence": 0.72,
  "risk_level": "medium",
  "reasoning": "Fast SMA crossed above the slow SMA on the 1h timeframe..."
}
```

## Paper trading (simulated)

When a signal is analyzed, the paper-trading engine (`paper.js`) may place a
**simulated** fill against a virtual portfolio:

- Claude says `buy` / `sell` → opens or flips a position sized at
  `PAPER_TRADE_NOTIONAL` dollars, but only if `confidence ≥ PAPER_MIN_CONFIDENCE`.
- Claude says `close` → flattens the position and books realized P&L.
- Claude says `hold` / `ignore`, or confidence is too low → no trade.
- **No API key?** Paper trades follow the alert's own `side` field, so the
  engine works out of the box while you're learning.

The dashboard shows an equity-curve chart, total/realized/open P&L, and open
positions, marked to the latest price seen per symbol. Nothing touches a
broker — connect one later when you're ready. Portfolio state (including the
equity curve) persists to `data/paper.json`.

To reset your portfolio, click **Reset portfolio** on the dashboard (or
`POST /api/reset`) — this restores starting cash and clears positions/trades
while keeping your signal history.

## Configuration (`.env`)

| Variable              | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`   | Your Claude API key. Blank = record + paper-trade on `side`.   |
| `WEBHOOK_SECRET`      | Shared secret required in each alert payload. Blank = open.    |
| `PORT`                | Server port (default 3000).                                    |
| `CLAUDE_MODEL`        | Model id (default `claude-opus-4-8`).                          |
| `PAPER_TRADING`       | `on`/`off` (default on).                                       |
| `PAPER_STARTING_CASH` | Virtual starting cash (default 100000).                        |
| `PAPER_TRADE_NOTIONAL`| Dollars per simulated trade (default 10000).                   |
| `PAPER_MIN_CONFIDENCE`| Min Claude confidence to act, 0-1 (default 0.6).               |

## Endpoints

| Method | Path           | Description                             |
| ------ | -------------- | --------------------------------------- |
| `POST` | `/webhook`     | Receive a TradingView alert.            |
| `GET`  | `/api/signals` | Recent signals + analyses + portfolio.  |
| `POST` | `/api/reset`   | Reset the paper portfolio.              |
| `GET`  | `/`            | Live dashboard.                         |
| `GET`  | `/health`      | Health check.                           |

## Notes & next steps

- Signals persist to `data/signals.json` (last 100) via `store.js`, so history
  survives restarts. The file is written atomically and is gitignored. Delete
  it to clear history, or swap `store.js` for SQLite/Postgres if you outgrow a
  flat file. Any signal caught mid-analysis by a restart is marked as
  interrupted on reload.
- Claude's output is a **recommendation, not a trade**. Wiring `action` to a
  broker API is deliberately left out — add it in the `.then()` handler in
  `server.js` behind your own risk checks and confirmations.
- Never commit `.env`. Secrets stay in environment variables.
