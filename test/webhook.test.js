// End-to-end tests: boot the server in mock mode (no ANTHROPIC_API_KEY),
// simulate TradingView webhook POSTs, and verify the API the dashboard uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let dataDir;

async function waitForServer(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

async function waitForAnalysis(id, retries = 50) {
  for (let i = 0; i < retries; i++) {
    const { signals } = await (await fetch(`${BASE}/api/signals`)).json();
    const s = signals.find((x) => x.id === id);
    if (s && s.analysisStatus !== "pending") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`signal ${id} never finished analysis`);
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "tvclaude-test-"));
  proc = spawn(process.execPath, ["server.js"], {
    cwd: path.join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "", // force mock mode
      PORT: String(PORT),
      WEBHOOK_SECRET: "test-secret",
      DATA_FILE: path.join(dataDir, "signals.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  const health = await waitForServer();
  assert.equal(health.mode, "mock");
});

after(async () => {
  proc?.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("rejects webhook without the shared secret", async () => {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol: "BTCUSD", side: "buy", price: 65000 }),
  });
  assert.equal(res.status, 401);
});

test("accepts a TradingView-style buy alert and analyzes it", async () => {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: "test-secret",
      symbol: "BTCUSD",
      side: "buy",
      price: 65000,
      timeframe: "1h",
      strategy: "sma_cross_10_30",
    }),
  });
  assert.equal(res.status, 200);
  const { ok, id } = await res.json();
  assert.equal(ok, true);

  const signal = await waitForAnalysis(id);
  assert.equal(signal.analysisStatus, "done");
  assert.equal(signal.analysis.action, "buy");
  assert.equal(signal.analysis.mode, "mock");
  assert.ok(signal.analysis.confidence >= 0 && signal.analysis.confidence <= 1);
  assert.ok(["low", "medium", "high"].includes(signal.analysis.risk));
  assert.equal(signal.alert.secret, undefined, "secret must not be stored");
});

test("wraps non-JSON alert bodies instead of dropping them", async () => {
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Webhook-Secret": "test-secret" },
    body: "BTCUSD crossing above 65000",
  });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const signal = await waitForAnalysis(id);
  assert.equal(signal.alert.message, "BTCUSD crossing above 65000");
  assert.equal(signal.analysis.action, "hold"); // no side info → conservative hold
});

test("stats aggregate analyzed signals", async () => {
  // add a sell so byAction has more than one bucket
  const res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: "test-secret", symbol: "ETHUSD", side: "sell", price: 3200, timeframe: "4h" }),
  });
  const { id } = await res.json();
  await waitForAnalysis(id);

  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  assert.ok(stats.total >= 3);
  assert.ok(stats.byAction.buy >= 1);
  assert.ok(stats.byAction.sell >= 1);
  assert.ok(stats.byAction.hold >= 1);
  assert.ok(stats.avgConfidence > 0 && stats.avgConfidence <= 1);
  assert.ok(stats.lastSignalAt);
});

test("paper portfolio executes confident signals and exposes /api/portfolio", async () => {
  // buy SOLUSD (rich payload → mock confidence 0.88 ≥ 0.6 threshold)
  let res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: "test-secret", symbol: "SOLUSD", side: "buy", price: 150, timeframe: "1h", strategy: "test" }),
  });
  await waitForAnalysis((await res.json()).id);

  // sell it at a higher price → realized profit
  res = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: "test-secret", symbol: "SOLUSD", side: "sell", price: 165, timeframe: "1h", strategy: "test" }),
  });
  await waitForAnalysis((await res.json()).id);

  const p = await (await fetch(`${BASE}/api/portfolio`)).json();
  assert.equal(p.broker, "paper");
  assert.equal(p.currency, "R");
  assert.ok(p.closedTrades >= 1);
  assert.ok(p.realizedPnl > 0, "sell above buy price realizes profit");
  assert.ok(p.decisions.length >= 2);
  assert.ok(p.decisions.some((d) => d.executed && d.action === "buy"));
  assert.ok(p.decisions.some((d) => d.executed && d.action === "sell"));
  assert.ok(p.equityCurve.length >= 2);

  // reset requires the shared secret
  const denied = await fetch(`${BASE}/api/portfolio/reset`, { method: "POST" });
  assert.equal(denied.status, 401);
  const okRes = await fetch(`${BASE}/api/portfolio/reset`, {
    method: "POST",
    headers: { "X-Webhook-Secret": "test-secret" },
  });
  assert.equal(okRes.status, 200);
  const fresh = await (await fetch(`${BASE}/api/portfolio`)).json();
  assert.equal(fresh.closedTrades, 0);
});

test("serves the dashboard and enforces payload size limit", async () => {
  const page = await fetch(`${BASE}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Signal Dashboard/);

  const big = await fetch(`${BASE}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(70 * 1024),
  }).catch(() => null);
  // server destroys the socket on oversize bodies; either a 413 or a reset is acceptable
  if (big) assert.equal(big.status, 413);
});
