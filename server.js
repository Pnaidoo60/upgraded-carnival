// TradingView x Claude signal analysis dashboard server.
//
// Endpoints:
//   POST /webhook       — TradingView alert webhook (responds 200 fast, analyzes async)
//   GET  /api/signals   — recent signals with Claude analyses (?limit=N)
//   GET  /api/stats     — aggregate stats for the dashboard
//   GET  /health        — liveness + mode (live Claude vs mock)
//   GET  /              — the dashboard

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { SignalStore } from "./lib/store.js";
import { analyzeSignal, isLiveMode } from "./lib/analyzer.js";
import { getCandles } from "./lib/prices.js";
import { PaperBroker } from "./lib/paper.js";
import { IbkrPaperBroker } from "./lib/brokers/ibkr.js";
import { MarketEvents } from "./lib/events.js";
import { assertPaperOnly, TRADING_MODE, TRADING_MODE_LABEL } from "./lib/safety.js";

// Paper-only guarantee: refuse to boot if anything requests real trading.
assertPaperOnly();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "signals.json");
const PORTFOLIO_FILE = process.env.PORTFOLIO_FILE || path.join(path.dirname(DATA_FILE), "portfolio.json");
const MAX_BODY_BYTES = 64 * 1024;

const EVENTS_FILE = process.env.EVENTS_FILE || path.join(__dirname, "config", "market-events.json");

const store = new SignalStore(DATA_FILE);
const broker = new PaperBroker(PORTFOLIO_FILE);
const ibkr = new IbkrPaperBroker(); // enabled via BROKER=ibkr; paper-only by design
const events = new MarketEvents(EVENTS_FILE); // public scheduled-event caution

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function secretMatches(provided) {
  if (!WEBHOOK_SECRET) return true;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleWebhook(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, err.status || 400, { error: err.message });
  }

  let alert;
  try {
    alert = JSON.parse(body);
  } catch {
    // TradingView alerts can be plain text; wrap them so nothing is dropped.
    alert = { message: body };
  }
  if (alert === null || typeof alert !== "object" || Array.isArray(alert)) {
    alert = { message: String(body) };
  }

  const providedSecret = alert.secret ?? req.headers["x-webhook-secret"];
  if (!secretMatches(providedSecret)) {
    return json(res, 401, { error: "invalid webhook secret" });
  }
  delete alert.secret; // never store or send the shared secret to Claude

  const signal = store.add(alert);
  // Respond immediately so TradingView doesn't retry, then analyze async.
  json(res, 200, { ok: true, id: signal.id });

  try {
    const eventContext = events.contextFor();
    const analysis = await analyzeSignal(alert, { eventContext });
    store.setAnalysis(signal.id, analysis, "done");
    const decision = broker.onSignal(signal, analysis);
    // Mirror executed simulator trades to the IBKR paper account when enabled.
    if (decision.executed && decision.trade && ibkr.isEnabled()) {
      try {
        const result = await ibkr.placeOrder({
          tvSymbol: decision.symbol,
          side: decision.trade.side,
          quantity: decision.trade.qty,
          currency: alert.currency,
          exchange: alert.exchange,
        });
        broker.attachBrokerResult(signal.id, result);
      } catch (err) {
        console.error(`IBKR mirror failed for signal ${signal.id}:`, err.message);
        broker.attachBrokerResult(signal.id, { error: err.message });
      }
    }
  } catch (err) {
    console.error(`analysis failed for signal ${signal.id}:`, err.message);
    store.setAnalysis(signal.id, { error: err.message }, "failed");
  }
}

async function serveDashboard(res) {
  try {
    const html = await readFile(path.join(__dirname, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    json(res, 500, { error: "dashboard not found" });
  }
}

// Allowlisted static assets (PWA manifest + icons). Explicit map — no
// user-controlled path ever touches the filesystem, so no traversal risk.
const STATIC_ASSETS = {
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/icons/icon-192.png": { file: "icons/icon-192.png", type: "image/png" },
  "/icons/icon-512.png": { file: "icons/icon-512.png", type: "image/png" },
  "/icons/icon-maskable-512.png": { file: "icons/icon-maskable-512.png", type: "image/png" },
};

async function serveStatic(res, asset) {
  try {
    const body = await readFile(path.join(__dirname, "public", asset.file));
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "public, max-age=86400" });
    res.end(body);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "POST" && url.pathname === "/webhook") {
      return await handleWebhook(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/signals") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      return json(res, 200, { signals: store.list(limit) });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      return json(res, 200, store.stats());
    }
    if (req.method === "GET" && url.pathname === "/api/portfolio") {
      return json(res, 200, broker.snapshot());
    }
    if (req.method === "GET" && url.pathname === "/api/broker") {
      return json(res, 200, ibkr.status());
    }
    if (req.method === "GET" && url.pathname === "/api/prices") {
      const symbol = (url.searchParams.get("symbol") || "AAPL").slice(0, 20);
      const limit = Math.min(400, Math.max(20, Number(url.searchParams.get("limit")) || 180));
      return json(res, 200, await getCandles(symbol, { limit }));
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      return json(res, 200, { windowDays: events.windowDays, upcoming: events.upcoming() });
    }
    if (req.method === "POST" && url.pathname === "/api/portfolio/reset") {
      const provided = req.headers["x-webhook-secret"];
      if (!secretMatches(typeof provided === "string" ? provided : "")) {
        return json(res, 401, { error: "invalid secret" });
      }
      await broker.reset();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        mode: isLiveMode() ? "live" : "mock",
        tradingMode: TRADING_MODE, // always "paper" — real execution is not implemented
        tradingModeLabel: TRADING_MODE_LABEL,
        paperTrading: broker.config.enabled,
      });
    }
    if (req.method === "GET" && STATIC_ASSETS[url.pathname]) {
      return await serveStatic(res, STATIC_ASSETS[url.pathname]);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return await serveDashboard(res);
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("request error:", err);
    return json(res, 500, { error: "internal error" });
  }
});

await store.load();
await broker.load();
await events.load();
server.listen(PORT, () => {
  console.log("──────────────────────────────────────────────────────────");
  console.log(`  TRADING MODE: ${TRADING_MODE_LABEL}`);
  console.log("  No real-money orders are ever placed by this service.");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`TradingView x Claude dashboard listening on http://localhost:${PORT}`);
  console.log(`Analysis mode: ${isLiveMode() ? "live (Claude API)" : "mock (set ANTHROPIC_API_KEY for live analysis)"}`);
  if (!WEBHOOK_SECRET) {
    console.log("Warning: WEBHOOK_SECRET not set — webhook accepts unauthenticated posts.");
  }
  if (ibkr.isEnabled()) {
    console.log(`IBKR paper mirroring enabled → ${ibkr.host}:${ibkr.port} (paper ports only)`);
    ibkr.connect()
      .then(() => console.log(`IBKR connected: paper account ${ibkr.account}`))
      .catch((err) => console.error(`IBKR connect failed (will retry on first trade): ${err.message}`));
  }
});

export default server;
