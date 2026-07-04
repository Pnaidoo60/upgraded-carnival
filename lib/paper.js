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
    if (pos) {
      pos.avgPrice = (pos.avgPrice * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
    } else {
      this.positions[symbol] = { qty, avgPrice: price };
    }
    this.cash -= spend;
    decision.executed = true;
    decision.reason = "buy executed";
    this.recordTrade({ side: "buy", symbol, qty, price, value: spend, signalId: decision.signalId });
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
    decision.executed = true;
    decision.reason = `sell executed (P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`;
    this.recordTrade({ side: "sell", symbol, qty: pos.qty, price, value: proceeds, pnl, signalId: decision.signalId });
    delete this.positions[symbol];
  }

  recordTrade(trade) {
    this.trades.push({ at: new Date().toISOString(), ...trade });
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES);
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
      positions,
      trades: this.trades.slice(-50).reverse(),
      decisions: this.decisions.slice(-50).reverse(),
      equityCurve: this.equityCurve,
    };
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
        equityCurve: this.equityCurve,
      }, null, 2));
      await rename(tmp, this.filePath);
    }).catch((err) => {
      console.error("paper broker: persist failed:", err.message);
    });
    return this.writeQueue;
  }
}
