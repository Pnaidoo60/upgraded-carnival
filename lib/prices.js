// OHLC price provider for the dashboard's price chart.
//
// getCandles(symbol) returns recent daily candles plus 20- and 50-period EMAs.
// It tries a live, keyless source (Stooq daily CSV) and — mirroring the
// analyzer's mock fallback — falls back to deterministic synthetic candles when
// no network is available, so the chart always renders. Results are cached
// briefly so the dashboard's 5s refresh doesn't hammer the upstream source.

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // key -> { at, data }

// Exponential moving average. Returns an array aligned to `values`, with null
// until the seed index (period-1). The seed is the SMA of the first `period`
// values, matching how TradingView's ta.ema initializes.
export function computeEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let ema = sum / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// Wilder's RSI. Returns an array aligned to `closes`, null until the seed
// index (`period`). Flat stretches (no gain and no loss) map to a neutral 50.
export function computeRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  const rsi = (g, l) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = rsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = rsi(avgGain, avgLoss);
  }
  return out;
}

// MACD (default 12/26/9): macd line = EMA(fast) − EMA(slow); signal = EMA of the
// macd line; hist = macd − signal. Each is aligned to `closes` with leading
// nulls until it's defined.
export function computeMACD(closes, fast = 12, slow = 26, signalLen = 9) {
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const macd = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null);
  const firstIdx = macd.findIndex((v) => v != null);
  const signal = new Array(closes.length).fill(null);
  const hist = new Array(closes.length).fill(null);
  if (firstIdx !== -1) {
    const sig = computeEMA(macd.slice(firstIdx), signalLen);
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] == null) continue;
      const idx = firstIdx + i;
      signal[idx] = sig[i];
      hist[idx] = macd[idx] - sig[i];
    }
  }
  return { macd, signal, hist };
}

const round2 = (n) => Math.round(n * 100) / 100;

// --- Deterministic synthetic candles (offline fallback) -------------------

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A seeded random walk with occasional drift shifts, so up- and down-legs are
// visible for the EMAs to track. Deterministic per symbol → stable across
// refreshes and testable.
export function syntheticCandles(symbol, limit) {
  const rnd = mulberry32(hashSeed(String(symbol).toUpperCase()));
  const candles = [];
  let close = 150 + rnd() * 120; // per-symbol starting price
  let drift = (rnd() - 0.5) * 0.002;
  const now = Date.now();
  const DAY = 86_400_000;
  for (let i = limit - 1; i >= 0; i--) {
    if (rnd() < 0.05) drift = (rnd() - 0.5) * 0.004; // new leg
    const open = close;
    const shock = (rnd() - 0.5) * 0.02;
    close = Math.max(1, open * (1 + drift + shock));
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    candles.push({
      t: new Date(now - i * DAY).toISOString(),
      o: round2(open),
      h: round2(high),
      l: round2(low),
      c: round2(close),
    });
  }
  return candles;
}

// --- Live source: Stooq daily CSV (no API key) ----------------------------

function toStooqSymbol(symbol) {
  // "NASDAQ:AAPL" -> "aapl.us"; "AAPL" -> "aapl.us"
  const base = String(symbol).includes(":") ? String(symbol).split(":").pop() : String(symbol);
  return base.toLowerCase() + ".us";
}

async function fetchStooq(symbol, limit) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(toStooqSymbol(symbol))}&i=d`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`stooq ${res.status}`);
    const text = await res.text();
    const rows = text.trim().split("\n").slice(1); // drop header
    const candles = [];
    for (const row of rows) {
      const [date, o, h, l, c] = row.split(",");
      const open = Number(o), high = Number(h), low = Number(l), close = Number(c);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      candles.push({ t: new Date(date + "T00:00:00Z").toISOString(), o: open, h: high, l: low, c: close });
    }
    if (candles.length < 2) throw new Error("stooq returned no usable rows");
    return candles.slice(-limit);
  } finally {
    clearTimeout(timer);
  }
}

function withIndicators(symbol, source, candles) {
  const closes = candles.map((c) => c.c);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const rsi = computeRSI(closes, 14);
  const macd = computeMACD(closes, 12, 26, 9);
  const series = (arr) =>
    candles.map((c, i) => ({ t: c.t, v: arr[i] })).filter((p) => p.v != null);
  return {
    symbol: String(symbol).toUpperCase(),
    source,
    candles,
    ema: { 20: series(ema20), 50: series(ema50) },
    rsi: series(rsi),
    macd: { macd: series(macd.macd), signal: series(macd.signal), hist: series(macd.hist) },
  };
}

export async function getCandles(symbol = "AAPL", { limit = 180 } = {}) {
  const key = `${String(symbol).toUpperCase()}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let data;
  try {
    data = withIndicators(symbol, "stooq", await fetchStooq(symbol, limit));
  } catch {
    data = withIndicators(symbol, "synthetic", syntheticCandles(symbol, limit));
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}
