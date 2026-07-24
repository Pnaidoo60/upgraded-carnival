// Paper-trading simulator ("paper broker").
//
// Consumes Claude signal analyses and maintains a virtual ZAR portfolio:
// no real orders are ever placed. Designed as a broker adapter so a real
// broker could be slotted in later — EasyEquities currently has no official
// public trading API (only partner integrations), so the built-in simulator
// is the only safe implementation for South African users today.
//
// Guardrails:
//   - PAPER_ENABLED=false is a kill switch (decisions logged, nothing executed)
//   - trades only above PAPER_MIN_CONFIDENCE
//   - position sizing capped per trade and per symbol
//   - every decision (executed OR skipped) is logged with a reason

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

const MAX_CURVE_POINTS = 500;
const MAX_TRADES = 500;
const MAX_DECISIONS = 200;

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export class PaperBroker {
  constructor(filePath, config = {}) {
    this.filePath = filePath;
    this.config = {
      enabled: process.env.PAPER_ENABLED !== "false",
      startingCash: envNum("PAPER_STARTING_CASH", 100_000),
      minConfidence: Math.min(1, envNum("PAPER_MIN_CONFIDENCE", 0.6)),
      positionPct: Math.min(1, envNum("PAPER_POSITION_PCT", 0.10)),     // of equity per new buy
      maxPositionPct: Math.min(1, envNum("PAPER_MAX_POSITION_PCT", 0.25)), // cap per symbol
      currency: process.env.PAPER_CURRENCY || "R",
      ...config,
    };
    this.writeQueue = Promise.resolve();
    this.resetState();
  }

  resetState() {
    this.cash = this.config.startingCash;
    this.positions = {};   // symbol -> { qty, avgPrice }
    this.lastPrices = {};  // symbol -> last seen price
    this.trades = [];      // executed fills
    this.decisions = [];   // every evaluated signal, executed or skipped
    this.realizedPnl = 0;
    this.closedTrades = 0;
    this.winningTrades = 0;
    this.closedRoundTrips = []; // { at, symbol, buyConfidence, pnl } — for confidence-bucket analysis
    this.equityCurve = [{ t: new Date().toISOString(), equity: this.cash }];
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      Object.assign(this, {
        cash: raw.cash,
        positions: raw.positions || {},
        lastPrices: raw.lastPrices || {},
        trades: raw.trades || [],
        decisions: raw.decisions || [],
        realizedPnl: raw.realizedPnl || 0,
        closedTrades: raw.closedTrades || 0,
        winningTrades: raw.winningTrades || 0,
        closedRoundTrips: raw.closedRoundTrips || [],
        equityCurve: raw.equityCurve?.length ? raw.equityCurve : this.equityCurve,
      });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  equity() {
    let value = this.cash;
    for (const [symbol, pos] of Object.entries(this.positions)) {
      value += pos.qty * (this.lastPrices[symbol] ?? pos.avgPrice);
    }
    return value;
  }

  // Evaluate one analyzed signal. Returns the decision record.
  onSignal(signal, analysis) {
    const alert = signal.alert || {};
    const symbol = alert.symbol || alert.ticker || null;
    const price = Number(alert.price);
    if (symbol && Number.isFinite(price) && price > 0) {
      this.lastPrices[symbol] = price;
    }

    const decision = {
      signalId: signal.id,
      at: new Date().toISOString(),
      symbol,
      action: analysis.action,
      confidence: analysis.confidence,
      executed: false,
      reason: "",
    };

    if (!this.config.enabled) decision.reason = "paper trading disabled (PAPER_ENABLED=false)";
    else if (!symbol) decision.reason = "no symbol in alert";
    else if (!Number.isFinite(price) || price <= 0) decision.reason = "no usable price in alert";
    else if (analysis.action === "hold") decision.reason = "analysis says hold";
    else if (analysis.confidence < this.config.minConfidence) {
      decision.reason = `confidence ${(analysis.confidence * 100).toFixed(0)}% below threshold ${(this.config.minConfidence * 100).toFixed(0)}%`;
    } else if (analysis.action === "buy") {
      this.executeBuy(decision, symbol, price);
    } else if (analysis.action === "sell") {
      this.executeSell(decision, symbol, price);
    } else {
      decision.reason = `unknown action "${analysis.action}"`;
    }

    this.decisions.push(decision);
    if (this.decisions.length > MAX_DECISIONS) this.decisions.splice(0, this.decisions.length - MAX_DECISIONS);
    this.recordEquity();
    this.persist();
    return decision;
  }

  executeBuy(decision, symbol, price) {
    const equity = this.equity();
    const pos = this.positions[symbol];
    const currentValue = pos ? pos.qty * price : 0;
    const maxValue = equity * this.config.maxPositionPct;
    if (currentValue >= maxValue) {
      decision.reason = `position cap reached for ${symbol} (${(this.config.maxPositionPct * 100).toFixed(0)}% of equity)`;
      return;
    }
    let spend = Math.min(equity * this.config.positionPct, maxValue - currentValue, this.cash);
    if (spend < price * 0.0001 || spend <= 0) {
      decision.reason = "insufficient cash";
      return;
    }
    const qty = spend / price; // fractional shares, EasyEquities-style
    const conf = decision.confidence;
    if (pos) {
      // weight buy-confidence by quantity, same as average price
      const priorConf = Number.isFinite(pos.buyConfidence) ? pos.buyConfidence : conf;
      pos.buyConfidence = (priorConf * pos.qty + conf * qty) / (pos.qty + qty);
      pos.avgPrice = (pos.avgPrice * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
    } else {
      this.positions[symbol] = { qty, avgPrice: price, buyConfidence: conf };
    }
    this.cash -= spend;
    decision.executed = true;
    decision.reason = "buy executed";
    decision.trade = this.recordTrade({ side: "buy", symbol, qty, price, value: spend, signalId: decision.signalId });
  }

  executeSell(decision, symbol, price) {
    const pos = this.positions[symbol];
    if (!pos || pos.qty <= 0) {
      decision.reason = `no open position in ${symbol}`;
      return;
    }
    const proceeds = pos.qty * price;
    const pnl = (price - pos.avgPrice) * pos.qty;
    this.cash += proceeds;
    this.realizedPnl += pnl;
    this.closedTrades += 1;
    if (pnl > 0) this.winningTrades += 1;
    // Attribute the round-trip outcome to the confidence Claude had when it bought,
    // so we can see whether higher-confidence entries actually paid off.
    if (Number.isFinite(pos.buyConfidence)) {
      this.closedRoundTrips.push({ at: new Date().toISOString(), symbol, buyConfidence: pos.buyConfidence, pnl });
      if (this.closedRoundTrips.length > MAX_TRADES) {
        this.closedRoundTrips.splice(0, this.closedRoundTrips.length - MAX_TRADES);
      }
    }
    decision.executed = true;
    decision.reason = `sell executed (P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`;
    decision.trade = this.recordTrade({ side: "sell", symbol, qty: pos.qty, price, value: proceeds, pnl, signalId: decision.signalId });
    delete this.positions[symbol];
  }

  recordTrade(trade) {
    const record = { at: new Date().toISOString(), ...trade };
    this.trades.push(record);
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
    return record;
  }

  // Attach the result of mirroring a trade to an external (paper) broker.
  attachBrokerResult(signalId, result) {
    const trade = this.trades.find((t) => t.signalId === signalId);
    if (trade) trade.ibkr = result;
    const decision = this.decisions.find((d) => d.signalId === signalId);
    if (decision) decision.ibkr = result;
    this.persist();
  }

  recordEquity() {
    this.equityCurve.push({ t: new Date().toISOString(), equity: this.equity() });
    if (this.equityCurve.length > MAX_CURVE_POINTS) {
      this.equityCurve.splice(0, this.equityCurve.length - MAX_CURVE_POINTS);
    }
  }

  snapshot() {
    const equity = this.equity();
    let unrealized = 0;
    const positions = Object.entries(this.positions).map(([symbol, pos]) => {
      const last = this.lastPrices[symbol] ?? pos.avgPrice;
      const pnl = (last - pos.avgPrice) * pos.qty;
      unrealized += pnl;
      return {
        symbol,
        qty: pos.qty,
        avgPrice: pos.avgPrice,
        lastPrice: last,
        value: pos.qty * last,
        unrealizedPnl: pnl,
      };
    });
    return {
      broker: "paper",
      currency: this.config.currency,
      enabled: this.config.enabled,
      config: {
        startingCash: this.config.startingCash,
        minConfidence: this.config.minConfidence,
        positionPct: this.config.positionPct,
        maxPositionPct: this.config.maxPositionPct,
      },
      equity,
      cash: this.cash,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      totalReturnPct: (equity / this.config.startingCash - 1) * 100,
      closedTrades: this.closedTrades,
      winRate: this.closedTrades ? this.winningTrades / this.closedTrades : null,
      confidenceBuckets: this.confidenceBuckets(),
      positions,
      trades: this.trades.slice(-50).reverse(),
      decisions: this.decisions.slice(-50).reverse(),
      equityCurve: this.equityCurve,
    };
  }

  // Group closed round-trips into confidence bands so you can see whether
  // higher-confidence entries actually produced better outcomes — the data
  // that tells you where to set PAPER_MIN_CONFIDENCE.
  confidenceBuckets() {
    const bands = [
      { label: "60–69%", min: 0.60, max: 0.70 },
      { label: "70–79%", min: 0.70, max: 0.80 },
      { label: "80–89%", min: 0.80, max: 0.90 },
      { label: "90–100%", min: 0.90, max: 1.01 },
    ];
    const buckets = bands.map((b) => ({ ...b, trades: 0, wins: 0, pnl: 0 }));
    for (const rt of this.closedRoundTrips) {
      const b = buckets.find((x) => rt.buyConfidence >= x.min && rt.buyConfidence < x.max);
      if (!b) continue;
      b.trades += 1;
      if (rt.pnl > 0) b.wins += 1;
      b.pnl += rt.pnl;
    }
    return buckets.map((b) => ({
      label: b.label,
      trades: b.trades,
      winRate: b.trades ? b.wins / b.trades : null,
      pnl: b.pnl,
      avgPnl: b.trades ? b.pnl / b.trades : null,
    }));
  }

  async reset() {
    this.resetState();
    await this.persist();
  }

  persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = this.filePath + ".tmp";
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, JSON.stringify({
        cash: this.cash,
        positions: this.positions,
        lastPrices: this.lastPrices,
        trades: this.trades,
        decisions: this.decisions,
        realizedPnl: this.realizedPnl,
        closedTrades: this.closedTrades,
        winningTrades: this.winningTrades,
        closedRoundTrips: this.closedRoundTrips,
        equityCurve: this.equityCurve,
      }, null, 2));
      await rename(tmp, this.filePath);
    }).catch((err) => {
      console.error("paper broker: persist failed:", err.message);
    });
    return this.writeQueue;
  }
}
