// Tests for indicator-aware scoring and scheduled-event caution (mock mode).
import { test, before } from "node:test";
import assert from "node:assert/strict";

before(() => { delete process.env.ANTHROPIC_API_KEY; }); // force mock analysis

const { analyzeSignal } = await import("../lib/analyzer.js");

test("aligned indicators score higher than conflicting ones", async () => {
  const aligned = await analyzeSignal({
    symbol: "NASDAQ:AAPL", side: "buy", price: 210,
    rsi: 58, macd_hist: 0.5, trend: "up", volume_vs_avg: 1.6, ema_fast: 210, ema_slow: 205,
  });
  const conflicting = await analyzeSignal({
    symbol: "NASDAQ:AAPL", side: "buy", price: 210,
    rsi: 82, macd_hist: -0.5, trend: "down", volume_vs_avg: 0.6, ema_fast: 205, ema_slow: 210,
  });
  assert.equal(aligned.action, "buy");
  assert.ok(aligned.confidence > 0.8, `aligned should be high, got ${aligned.confidence}`);
  assert.ok(conflicting.confidence < 0.5, `conflicting should be low, got ${conflicting.confidence}`);
  assert.ok(aligned.confidence > conflicting.confidence);
  assert.equal(aligned.risk, "low");
  assert.ok(aligned.factors.some((f) => /Indicators aligned: \d+\/\d+/.test(f)));
});

test("indicator-free alerts keep the original richness scoring", async () => {
  const rich = await analyzeSignal({ symbol: "X", side: "buy", price: 10, timeframe: "1h", strategy: "s" });
  assert.ok(Math.abs(rich.confidence - 0.88) < 1e-9); // 0.4 + 4*0.12
});

test("scheduled-event context trims confidence and raises risk", async () => {
  const base = await analyzeSignal({
    symbol: "JSE:NPN", side: "buy", price: 3000, rsi: 58, trend: "up", macd_hist: 0.3, volume_vs_avg: 1.4,
  });
  const nearEvent = await analyzeSignal(
    { symbol: "JSE:NPN", side: "buy", price: 3000, rsi: 58, trend: "up", macd_hist: 0.3, volume_vs_avg: 1.4 },
    { eventContext: { label: "SARB MPC rate decision", date: "2026-07-25", daysUntil: 1, windowDays: 3 } },
  );
  assert.ok(nearEvent.confidence < base.confidence, "confidence should be trimmed near an event");
  assert.equal(nearEvent.risk, "high");
  assert.equal(nearEvent.eventContext.label, "SARB MPC rate decision");
  assert.ok(nearEvent.factors.some((f) => /Scheduled event/.test(f)));
});
