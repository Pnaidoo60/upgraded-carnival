// Unit tests for the price provider (EMA math + synthetic fallback).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEMA, computeRSI, computeMACD, syntheticCandles, getCandles } from "../lib/prices.js";

test("computeEMA seeds with SMA and tracks the series", () => {
  const out = computeEMA([1, 2, 3, 4, 5], 2);
  // seed = SMA of first 2 = 1.5; k = 2/3 thereafter
  assert.equal(out[0], null);
  assert.ok(Math.abs(out[1] - 1.5) < 1e-9);
  assert.ok(Math.abs(out[2] - 2.5) < 1e-9);
  assert.ok(Math.abs(out[3] - 3.5) < 1e-9);
  assert.ok(Math.abs(out[4] - 4.5) < 1e-9);
});

test("computeEMA returns all-null when fewer values than the period", () => {
  assert.deepEqual(computeEMA([1, 2], 5), [null, null]);
});

test("EMA of a flat series equals the constant value", () => {
  const out = computeEMA([10, 10, 10, 10, 10], 3);
  for (let i = 2; i < out.length; i++) assert.ok(Math.abs(out[i] - 10) < 1e-9);
});

test("syntheticCandles is deterministic per symbol and has valid OHLC", () => {
  const a = syntheticCandles("AAPL", 60);
  const b = syntheticCandles("AAPL", 60);
  assert.equal(a.length, 60);
  // OHLC is deterministic per symbol (timestamps are anchored to now, so
  // compare the price fields only).
  const ohlc = (arr) => arr.map(({ o, h, l, c }) => ({ o, h, l, c }));
  assert.deepEqual(ohlc(a), ohlc(b));
  for (const c of a) {
    assert.ok(c.h >= c.o && c.h >= c.c, "high is the max");
    assert.ok(c.l <= c.o && c.l <= c.c, "low is the min");
    assert.ok(c.c > 0);
    assert.ok(typeof c.t === "string");
  }
  // candles are ordered oldest → newest
  for (let i = 1; i < a.length; i++) {
    assert.ok(new Date(a[i].t).getTime() > new Date(a[i - 1].t).getTime());
  }
});

test("different symbols produce different synthetic series", () => {
  const ohlc = (arr) => arr.map(({ o, h, l, c }) => ({ o, h, l, c }));
  assert.notDeepEqual(ohlc(syntheticCandles("AAPL", 30)), ohlc(syntheticCandles("MSFT", 30)));
});

test("getCandles returns candles plus aligned 20/50 EMA series", async () => {
  const data = await getCandles("AAPL", { limit: 80 });
  assert.equal(data.symbol, "AAPL");
  assert.ok(["stooq", "synthetic"].includes(data.source));
  assert.ok(data.candles.length >= 2);
  // EMA series start after their seed and never precede the first candle
  assert.ok(data.ema["20"].length > 0);
  assert.ok(data.ema["50"].length <= data.ema["20"].length);
  for (const p of data.ema["20"]) assert.ok(typeof p.v === "number" && Number.isFinite(p.v));
});

test("computeRSI: all-up series is 100, all-down is 0, nulls before seed", () => {
  const up = Array.from({ length: 30 }, (_, i) => i + 1); // strictly increasing
  const rUp = computeRSI(up, 14);
  for (let i = 0; i < 14; i++) assert.equal(rUp[i], null);
  assert.ok(Math.abs(rUp[14] - 100) < 1e-9);
  assert.ok(Math.abs(rUp.at(-1) - 100) < 1e-9);

  const down = Array.from({ length: 30 }, (_, i) => 100 - i); // strictly decreasing
  const rDown = computeRSI(down, 14);
  assert.ok(Math.abs(rDown.at(-1) - 0) < 1e-9);
});

test("computeRSI: a flat series is neutral 50 and values stay in [0,100]", () => {
  const flat = new Array(30).fill(50);
  const r = computeRSI(flat, 14);
  assert.ok(Math.abs(r[14] - 50) < 1e-9);
  for (const v of r) if (v != null) assert.ok(v >= 0 && v <= 100);
});

test("computeMACD: macd = EMA12 − EMA26 and hist = macd − signal, aligned", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const { macd, signal, hist } = computeMACD(closes, 12, 26, 9);
  assert.equal(macd.length, closes.length);
  const e12 = computeEMA(closes, 12), e26 = computeEMA(closes, 26);
  for (let i = 0; i < closes.length; i++) {
    if (e12[i] != null && e26[i] != null) {
      assert.ok(Math.abs(macd[i] - (e12[i] - e26[i])) < 1e-9);
    } else {
      assert.equal(macd[i], null);
    }
    if (macd[i] != null && signal[i] != null) {
      assert.ok(Math.abs(hist[i] - (macd[i] - signal[i])) < 1e-9);
    }
  }
  // signal is defined only once there are enough macd points to seed its EMA
  assert.equal(signal[25], null);
  assert.ok(signal.at(-1) != null);
});

test("getCandles exposes RSI and MACD series in the response", async () => {
  const data = await getCandles("AAPL", { limit: 120 });
  assert.ok(Array.isArray(data.rsi) && data.rsi.length > 0);
  for (const p of data.rsi) assert.ok(p.v >= 0 && p.v <= 100);
  assert.ok(data.macd.macd.length > 0);
  assert.ok(data.macd.signal.length > 0);
  assert.ok(data.macd.hist.length > 0);
});
