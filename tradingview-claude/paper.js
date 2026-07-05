// Paper-trading engine. Turns Claude's recommendations (or, if Claude isn't
// configured, the alert's own `side`) into SIMULATED fills against a virtual
// portfolio. No broker, no real money — just cash, positions, and P&L so you
// can practice strategies safely.
//
// State persists to data/paper.json so your portfolio survives restarts.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'paper.json');

function num(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

const ENABLED = (process.env.PAPER_TRADING || 'on').toLowerCase() !== 'off';
const STARTING_CASH = num(process.env.PAPER_STARTING_CASH, 100000);
const TRADE_NOTIONAL = num(process.env.PAPER_TRADE_NOTIONAL, 10000);
const MIN_CONFIDENCE = num(process.env.PAPER_MIN_CONFIDENCE, 0.6);

let state = freshState();
let nextTradeId = 1;

function freshState() {
  return {
    startingCash: STARTING_CASH,
    cash: STARTING_CASH,
    realizedPnl: 0,
    positions: {}, // symbol -> { qty (signed), avg }
    lastPrice: {}, // symbol -> most recent price seen
    trades: [], // newest first: { id, at, symbol, action, side, qty, price, realized, signalId }
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { ...freshState(), ...parsed };
    nextTradeId = state.trades.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    // If starting cash changed in .env after trading began, keep history but note it.
    console.log(`Loaded paper portfolio: cash $${state.cash.toFixed(2)}, ${state.trades.length} trade(s)`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Could not read ${FILE}: ${err.message} — starting fresh portfolio`);
    }
    state = freshState();
    nextTradeId = 1;
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error(`Failed to persist paper portfolio: ${err.message}`);
  }
}

function symbolOf(payload) {
  return payload.symbol || payload.ticker || null;
}

// Keep the mark price fresh for every symbol we hear about, even on a "hold".
function observe(payload) {
  const symbol = symbolOf(payload);
  const price = num(payload.price, NaN);
  if (symbol && Number.isFinite(price)) {
    state.lastPrice[symbol] = price;
    persist();
  }
}

// Apply a simulated fill using signed-position netting. Returns realized P&L
// from any portion of an existing position that this fill closed.
function fill(symbol, side, qty, price) {
  const pos = state.positions[symbol] || { qty: 0, avg: 0 };
  const signed = side === 'buy' ? qty : -qty;
  let realized = 0;

  const sameDirection = pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed);
  if (sameDirection) {
    // Opening or adding to a position: blend the average entry price.
    const newQty = pos.qty + signed;
    pos.avg = (Math.abs(pos.qty) * pos.avg + Math.abs(signed) * price) / Math.abs(newQty);
    pos.qty = newQty;
  } else {
    // Reducing, closing, or reversing: realize P&L on the closed portion.
    const closeQty = Math.min(Math.abs(signed), Math.abs(pos.qty));
    realized = pos.qty > 0 ? (price - pos.avg) * closeQty : (pos.avg - price) * closeQty;
    const remaining = Math.abs(signed) - closeQty;
    pos.qty += signed;
    if (Math.abs(pos.qty) < 1e-9) pos.qty = 0;
    if (remaining > 1e-9) pos.avg = price; // reversed through zero into a new position
    else if (pos.qty === 0) pos.avg = 0;
  }

  state.cash -= signed * price;
  state.realizedPnl += realized;
  if (pos.qty === 0) delete state.positions[symbol];
  else state.positions[symbol] = pos;
  return realized;
}

// Decide what (if anything) to trade for a completed signal, then execute it.
// Returns the recorded trade, or null if no trade was placed.
function onSignal(signal) {
  if (!ENABLED) return null;

  const symbol = symbolOf(signal.payload);
  const price = num(signal.payload.price, NaN);
  if (!symbol || !Number.isFinite(price) || price <= 0) return null;

  let action;
  let confidence;
  if (signal.analysis) {
    action = signal.analysis.action;
    confidence = signal.analysis.confidence;
  } else if (signal.status === 'no_api_key') {
    // Claude not configured — fall back to the alert's own side so paper
    // trading still works out of the box.
    action = String(signal.payload.side || '').toLowerCase();
    confidence = 1;
  } else {
    return null; // analyzing / error — nothing to act on
  }

  if (!['buy', 'sell', 'close'].includes(action)) return null;
  if (action !== 'close' && confidence < MIN_CONFIDENCE) return null;

  const pos = state.positions[symbol] || { qty: 0, avg: 0 };
  let side;
  let qty;
  if (action === 'close') {
    if (pos.qty === 0) return null; // nothing to close
    side = pos.qty > 0 ? 'sell' : 'buy';
    qty = Math.abs(pos.qty);
  } else {
    side = action;
    qty = TRADE_NOTIONAL / price;
  }

  state.lastPrice[symbol] = price;
  const realized = fill(symbol, side, qty, price);

  const trade = {
    id: nextTradeId++,
    at: new Date().toISOString(),
    symbol,
    action,
    side,
    qty,
    price,
    realized,
    signalId: signal.id,
  };
  state.trades.unshift(trade);
  if (state.trades.length > 500) state.trades.pop();
  persist();
  console.log(`Paper ${side} ${qty.toFixed(4)} ${symbol} @ ${price} (realized ${realized.toFixed(2)})`);
  return trade;
}

// Mark-to-market summary for the dashboard.
function summary() {
  const positions = Object.entries(state.positions).map(([symbol, pos]) => {
    const last = state.lastPrice[symbol] ?? pos.avg;
    const unrealized = pos.qty * (last - pos.avg);
    return {
      symbol,
      qty: pos.qty,
      avg: pos.avg,
      last,
      marketValue: pos.qty * last,
      unrealized,
    };
  });
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealized, 0);
  const positionsValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const equity = state.cash + positionsValue;
  return {
    enabled: ENABLED,
    startingCash: state.startingCash,
    cash: state.cash,
    equity,
    realizedPnl: state.realizedPnl,
    unrealizedPnl,
    totalPnl: equity - state.startingCash,
    minConfidence: MIN_CONFIDENCE,
    tradeNotional: TRADE_NOTIONAL,
    positions,
    trades: state.trades.slice(0, 50),
  };
}

module.exports = { load, observe, onSignal, summary, ENABLED };
