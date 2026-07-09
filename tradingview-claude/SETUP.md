# Setup — connect TradingView → Claude → paper trades

Follow these in order. Steps 1–4 get it running and testable on your own
machine in a couple of minutes. Steps 5–6 connect your real TradingView chart.

Everything here is **paper trading only** — no broker, no real money.

---

## 1. Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer. Check with:
  ```bash
  node --version
  ```

## 2. Install

```bash
cd tradingview-claude
npm install
```

## 3. Add your config

Copy the example env file and open it in an editor:

```bash
cp .env.example .env
```

Fill in `.env`:

```ini
# Get a key at https://console.anthropic.com/  (Settings → API Keys → Create Key)
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Pick ANY random string. You'll paste the same value into the Pine script later.
WEBHOOK_SECRET=choose-a-long-random-string

# Leave these at defaults to start:
PORT=3000
CLAUDE_MODEL=claude-opus-4-8
PAPER_TRADING=on
PAPER_STARTING_CASH=100000
PAPER_TRADE_NOTIONAL=10000
PAPER_MIN_CONFIDENCE=0.6
```

> No API key yet? The app still runs — it records alerts and paper-trades on
> the alert's `side`, but skips Claude's analysis until you add a key.

## 4. Run it and test locally (no TradingView needed yet)

Start the server:

```bash
npm start
```

You should see it print the dashboard and webhook URLs. Open the dashboard:

- **http://localhost:3000/**

In a **second terminal**, fire a simulated alert:

```bash
cd tradingview-claude
npm run test:signal
```

Watch the dashboard: the signal appears, Claude analyzes it (if your key is
set), and a 📝 paper trade shows up with your equity curve and position.
Run it a few more times to build up positions and P&L. Use **Reset portfolio**
on the dashboard to start over.

✅ If that works, the whole pipeline is good. Now connect real alerts.

---

## 5. Expose your server to the internet (ngrok)

TradingView can only reach a public HTTPS URL, not `localhost`. The quickest
way while you're learning is [ngrok](https://ngrok.com/download):

```bash
# with the server still running from step 4, in another terminal:
ngrok http 3000
```

ngrok prints a public URL like `https://a1b2c3d4.ngrok-free.app`. Your webhook
endpoint is that URL + `/webhook`:

```
https://a1b2c3d4.ngrok-free.app/webhook
```

> The free ngrok URL changes each time you restart it — just update the alert's
> webhook URL in TradingView when it does. For something permanent, deploy to
> Render / Railway / Fly.io instead (same `npm start`, they give you a fixed
> HTTPS URL).

## 6. Configure TradingView

1. Open TradingView → **Pine Editor** (bottom panel).
2. Paste the contents of [`pine/strategy.pine`](pine/strategy.pine).
3. In that script, find the commented `secret` line, uncomment it, and set it
   to the **same** value as `WEBHOOK_SECRET` in your `.env`:
   ```
   ',"secret":"choose-a-long-random-string"' +
   ```
4. Click **Add to chart**.
5. Click the **Alarm/clock icon** → **Create Alert**.
   - **Condition:** your script → **"Any alert() function call"**
   - **Notifications tab → Webhook URL:** paste your ngrok webhook URL from step 5.
   - Leave the message box as-is (the script already sends valid JSON).
6. **Create.**

That's it. When your SMA crossover fires, TradingView POSTs the alert to your
server, Claude analyzes it, and a paper trade appears on your dashboard.

---

## Deploy for a permanent URL (instead of ngrok)

ngrok is great for testing, but the URL changes each restart. For a stable
HTTPS URL, deploy the app.

### Option A — Render (easiest, free tier)

A blueprint lives at the repo root (`render.yaml`).

1. Push this repo to GitHub (already done if you're reading this on GitHub).
2. In [Render](https://render.com/): **New → Blueprint** → connect this repo → **Apply**.
3. When prompted, set **`ANTHROPIC_API_KEY`** and **`WEBHOOK_SECRET`**.
4. Render builds and gives you a permanent URL like
   `https://tradingview-claude.onrender.com`. Your webhook is that + `/webhook`.
5. Put that webhook URL in your TradingView alert (step 6 above).

> Free instances sleep after inactivity and have an ephemeral filesystem, so
> paper-trade history resets on redeploy. For durable history, uncomment the
> `disk:` block in `render.yaml` (needs a paid instance).

### Option B — Docker (any host: Fly.io, Railway, Cloud Run, a VPS)

A `Dockerfile` is included. Build and run anywhere:

```bash
cd tradingview-claude
docker build -t tradingview-claude .
docker run -p 3000:3000 --env-file .env tradingview-claude
```

Most platforms inject their own `PORT`; the server honors it automatically.
Set `ANTHROPIC_API_KEY` and `WEBHOOK_SECRET` as env vars on the platform (don't
bake them into the image). Mount a volume at `/app/data` if you want durable
history.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dashboard says "ANTHROPIC_API_KEY not set" | Add the key to `.env`, restart `npm start`. |
| Alert fires but nothing on dashboard | Webhook URL must end in `/webhook`; check ngrok is still running; confirm the `secret` in the Pine script matches `.env`. |
| `401 invalid secret` in server logs | The `secret` in the Pine script doesn't match `WEBHOOK_SECRET`. |
| Signal shows but no paper trade | Claude returned `hold`/`ignore`, or confidence was below `PAPER_MIN_CONFIDENCE`. Lower the threshold in `.env` to see more trades. |
| Want to start fresh | Click **Reset portfolio**, or stop the server and delete `data/`. |

## Security notes

- Never commit `.env` — it's gitignored.
- Keep `WEBHOOK_SECRET` set so random internet traffic can't post fake alerts.
- This places **simulated** trades only. Connecting a real broker is
  intentionally not included — add it later, behind your own risk checks, when
  you're ready.
