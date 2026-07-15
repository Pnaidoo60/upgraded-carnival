#!/usr/bin/env node
// Generates the daily AAPL indicator report (price + EMA 20/50, RSI, MACD).
//
// Writes two files under reports/:
//   reports/AAPL-latest.html         — always the newest
//   reports/AAPL-<YYYY-MM-DD>.html    — dated snapshot for history
// and prints a one-line text read to stdout.
//
// Usage: node scripts/daily-chart.mjs [SYMBOL] [LIMIT]
//   SYMBOL defaults to AAPL, LIMIT (candles) defaults to 180.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCandles } from "../lib/prices.js";
import { renderReportHTML, summarize } from "../lib/chart-svg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");

const symbol = (process.argv[2] || "AAPL").toUpperCase();
const limit = Math.min(400, Math.max(60, Number(process.argv[3]) || 180));

const data = await getCandles(symbol, { limit });
const html = renderReportHTML(data);
const s = summarize(data);

const outDir = path.join(repoRoot, "reports");
await mkdir(outDir, { recursive: true });
const latest = path.join(outDir, `${symbol}-latest.html`);
const dated = path.join(outDir, `${symbol}-${s.date}.html`);
await writeFile(latest, html);
await writeFile(dated, html);

const fmt = (v, d = 2) => (v == null ? "—" : v.toFixed(d));
console.log(
  `${symbol} ${s.date} · close ${fmt(s.close)} · ${s.trend} · ` +
  `RSI ${fmt(s.rsi, 1)} (${s.rsiZone}) · ${s.macdState} · source=${data.source}`
);
console.log(`wrote ${path.relative(repoRoot, latest)} and ${path.relative(repoRoot, dated)}`);
