# TradingView × Claude — Signal Desk

A small, runnable version of the Claude ↔ TradingView integration that the
`claudlink` notes in this repo describe. It:

1. Receives TradingView webhook alerts at `POST /webhook`.
2. Sends each alert to the Claude API for a structured recommendation
   (action + confidence + risk + reasoning).
3. Shows every signal and Claude's verdict on a live dashboard at `/`.

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

## Configuration (`.env`)

| Variable            | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Your Claude API key. Blank = record signals but skip analysis. |
| `WEBHOOK_SECRET`    | Shared secret required in each alert payload. Blank = open.    |
| `PORT`              | Server port (default 3000).                                    |
| `CLAUDE_MODEL`      | Model id (default `claude-opus-4-8`).                          |

## Endpoints

| Method | Path           | Description                             |
| ------ | -------------- | --------------------------------------- |
| `POST` | `/webhook`     | Receive a TradingView alert.            |
| `GET`  | `/api/signals` | Recent signals + analyses (JSON).       |
| `GET`  | `/`            | Live dashboard.                         |
| `GET`  | `/health`      | Health check.                           |

## Notes & next steps

- Signals are held in memory (last 100) and reset on restart. Swap the
  `signals` array in `server.js` for a database if you need history.
- Claude's output is a **recommendation, not a trade**. Wiring `action` to a
  broker API is deliberately left out — add it in the `.then()` handler in
  `server.js` behind your own risk checks and confirmations.
- Never commit `.env`. Secrets stay in environment variables.
