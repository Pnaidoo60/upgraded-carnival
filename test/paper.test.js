// Unit tests for the paper-trading simulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { PaperBroker } from "../lib/paper.js";

let n = 0;
function makeBroker(config = {}) {
  const file = path.join(tmpdir(), `paper-test-${process.pid}-${n++}.json`);
  return new PaperBroker(file, {
    enabled: true,
    startingCash: 100_000,
    minConfidence: 0.6,
    positionPct: 0.10,
    maxPositionPct: 0.25,
    currency: "R",
    ...config,
  });
}

const signal = (id, alert) => ({ id, alert });

test("buy above threshold opens a position sized at positionPct", () => {
  const b = makeBroker();
  const d = b.onSignal(signal(1, { symbol: "JSE:SOL", price: 100 }), { action: "buy", confidence: 0.9 });
  assert.equal(d.executed, true);
  const pos = b.positions["JSE:SOL"];
  assert.ok(pos);
  assert.ok(Math.abs(pos.qty * 100 - 10_000) < 1e-6); // 10% of 100k equity
  assert.ok(Math.abs(b.cash - 90_000) < 1e-6);
});

test("low confidence is skipped with a reason", () => {
  const b = makeBroker();
  const d = b.onSignal(signal(1, { symbol: "JSE:SOL", price: 100 }), { action: "buy", confidence: 0.4 });
  assert.equal(d.executed, false);
  assert.match(d.reason, /below threshold/);
  assert.equal(Object.keys(b.positions).length, 0);
});

test("hold and missing price never trade", () => {
  const b = makeBroker();
  assert.equal(b.onSignal(signal(1, { symbol: "X", price: 10 }), { action: "hold", confidence: 0.9 }).executed, false);
  assert.equal(b.onSignal(signal(2, { symbol: "X" }), { action: "buy", confidence: 0.9 }).executed, false);
  assert.equal(b.onSignal(signal(3, { price: 10 }), { action: "buy", confidence: 0.9 }).executed, false);
});

test("per-symbol position cap blocks runaway buys", () => {
  const b = makeBroker();
  let executed = 0;
  for (let i = 0; i < 10; i++) {
    const d = b.onSignal(signal(i, { symbol: "JSE:NPN", price: 100 }), { action: "buy", confidence: 0.95 });
    if (d.executed) executed++;
    else {
      assert.match(d.reason, /position cap/);
      break;
    }
  }
  const pos = b.positions["JSE:NPN"];
  assert.ok(pos.qty * 100 <= b.equity() * 0.25 + 1e-6, "position stays under 25% of equity");
  assert.ok(executed >= 2 && executed < 10);
});

test("sell without a position is skipped; sell with one realizes P&L", () => {
  const b = makeBroker();
  const skip = b.onSignal(signal(1, { symbol: "JSE:AGL", price: 500 }), { action: "sell", confidence: 0.9 });
  assert.equal(skip.executed, false);
  assert.match(skip.reason, /no open position/);

  b.onSignal(signal(2, { symbol: "JSE:AGL", price: 500 }), { action: "buy", confidence: 0.9 });
  const qty = b.positions["JSE:AGL"].qty;
  const d = b.onSignal(signal(3, { symbol: "JSE:AGL", price: 550 }), { action: "sell", confidence: 0.9 });
  assert.equal(d.executed, true);
  assert.equal(b.positions["JSE:AGL"], undefined);
  assert.ok(Math.abs(b.realizedPnl - qty * 50) < 1e-6);
  assert.equal(b.closedTrades, 1);
  assert.equal(b.winningTrades, 1);
  assert.ok(b.equity() > 100_000);
});

test("kill switch blocks execution but still logs the decision", () => {
  const b = makeBroker({ enabled: false });
  const d = b.onSignal(signal(1, { symbol: "JSE:SOL", price: 100 }), { action: "buy", confidence: 0.95 });
  assert.equal(d.executed, false);
  assert.match(d.reason, /disabled/);
  assert.equal(b.decisions.length, 1);
  assert.equal(b.cash, 100_000);
});

test("confidence buckets group closed trades by buy-confidence and outcome", () => {
  const b = makeBroker();
  // buy at 88% confidence, sell at a profit → 80-89% bucket, a win
  b.onSignal(signal(1, { symbol: "JSE:SOL", price: 100 }), { action: "buy", confidence: 0.88 });
  b.onSignal(signal(2, { symbol: "JSE:SOL", price: 120 }), { action: "sell", confidence: 0.9 });
  // buy at 65% confidence, sell at a loss → 60-69% bucket, a loss
  b.onSignal(signal(3, { symbol: "JSE:NPN", price: 200 }), { action: "buy", confidence: 0.65 });
  b.onSignal(signal(4, { symbol: "JSE:NPN", price: 180 }), { action: "sell", confidence: 0.7 });

  const snap = b.snapshot();
  const byLabel = Object.fromEntries(snap.confidenceBuckets.map((x) => [x.label, x]));

  assert.equal(byLabel["80–89%"].trades, 1);
  assert.equal(byLabel["80–89%"].winRate, 1);
  assert.ok(byLabel["80–89%"].pnl > 0);

  assert.equal(byLabel["60–69%"].trades, 1);
  assert.equal(byLabel["60–69%"].winRate, 0);
  assert.ok(byLabel["60–69%"].pnl < 0);

  // bands with no closed trades report null win rate, zero trades
  assert.equal(byLabel["90–100%"].trades, 0);
  assert.equal(byLabel["90–100%"].winRate, null);
});

test("buy-confidence is quantity-weighted across multiple entries", () => {
  const b = makeBroker({ maxPositionPct: 1 });
  // two buys into the same symbol at different confidences
  b.onSignal(signal(1, { symbol: "JSE:AGL", price: 100 }), { action: "buy", confidence: 0.9 });
  b.onSignal(signal(2, { symbol: "JSE:AGL", price: 100 }), { action: "buy", confidence: 0.7 });
  const conf = b.positions["JSE:AGL"].buyConfidence;
  assert.ok(conf > 0.7 && conf < 0.9, "weighted between the two buys");
});

test("snapshot reports equity, unrealized P&L and win rate", () => {
  const b = makeBroker();
  b.onSignal(signal(1, { symbol: "JSE:SHP", price: 200 }), { action: "buy", confidence: 0.9 });
  // price moves up on a later signal that doesn't trade
  b.onSignal(signal(2, { symbol: "JSE:SHP", price: 220 }), { action: "hold", confidence: 0.5 });
  const snap = b.snapshot();
  assert.equal(snap.currency, "R");
  assert.equal(snap.positions.length, 1);
  assert.ok(snap.positions[0].unrealizedPnl > 0);
  assert.ok(snap.equity > 100_000);
  assert.equal(snap.winRate, null);
  assert.ok(snap.equityCurve.length >= 2);
});
