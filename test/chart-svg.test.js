// Unit tests for the daily report generator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCandles } from "../lib/prices.js";
import { renderReportHTML, renderReportSVG, summarize } from "../lib/chart-svg.js";

test("summarize reports a consistent read of the latest bar", async () => {
  const data = await getCandles("AAPL", { limit: 180 });
  const s = summarize(data);
  assert.match(s.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof s.close, "number");
  assert.ok(["overbought", "oversold", "neutral", "n/a"].includes(s.rsiZone));
  assert.match(s.trend, /bullish|bearish|n\/a/);
  assert.match(s.macdState, /bullish|bearish|n\/a/);
  // EMA trend label must agree with the numbers it summarizes
  if (s.ema20 != null && s.ema50 != null) {
    assert.equal(s.trend.startsWith("bullish"), s.ema20 > s.ema50);
  }
});

test("renderReportSVG produces one aligned SVG with all three panels", async () => {
  const data = await getCandles("AAPL", { limit: 120 });
  const svg = renderReportSVG(data);
  assert.ok(svg.startsWith("<svg"));
  for (const label of ["Price &amp; EMA 20 / 50", "RSI (14)", "MACD (12, 26, 9)"]) {
    assert.ok(svg.includes(label), `missing panel label: ${label}`);
  }
});

test("renderReportHTML is a self-contained page with no external requests", async () => {
  const data = await getCandles("AAPL", { limit: 120 });
  const html = renderReportHTML(data, { generatedAt: new Date("2026-07-15T08:00:00Z") });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("<title>AAPL"));
  assert.ok(html.includes("<svg"));
  // no external resource loads (CSP-safe / offline)
  assert.ok(!/src\s*=\s*["']https?:/i.test(html));
  assert.ok(!/href\s*=\s*["']https?:/i.test(html));
});
