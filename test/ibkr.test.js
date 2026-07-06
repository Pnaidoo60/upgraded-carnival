// Unit tests for the IBKR paper adapter, using an injected fake gateway.
// The real @stoqey/ib connection requires a running IB Gateway, so these
// tests verify the safety locks, symbol mapping, and order flow logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { IbkrPaperBroker } from "../lib/brokers/ibkr.js";

class FakeGateway extends EventEmitter {
  constructor({ account = "DU1234567" } = {}) {
    super();
    this.account = account;
    this.orders = [];
  }
  connect() {
    setImmediate(() => {
      this.emit("connected");
      this.emit("managedAccounts", this.account);
      this.emit("nextValidId", 100);
    });
  }
  placeOrder(orderId, contract, order) {
    this.orders.push({ orderId, contract, order });
    setImmediate(() => {
      this.emit("orderStatus", orderId, "Filled", order.totalQuantity, 0, 123.45);
    });
  }
  disconnect() { this.emit("disconnected"); }
}

function makeBroker(overrides = {}) {
  const gateway = new FakeGateway(overrides.gateway || {});
  const broker = new IbkrPaperBroker({
    enabled: true,
    port: 7497,
    createApi: () => gateway,
    ...overrides.broker,
  });
  return { broker, gateway };
}

test("refuses live trading ports at construction", () => {
  assert.throws(
    () => new IbkrPaperBroker({ enabled: true, port: 7496 }),
    /not a paper-trading port/
  );
  assert.throws(
    () => new IbkrPaperBroker({ enabled: true, port: 4001 }),
    /not a paper-trading port/
  );
  // paper ports are fine
  new IbkrPaperBroker({ enabled: true, port: 7497 });
  new IbkrPaperBroker({ enabled: true, port: 4002 });
});

test("refuses non-paper accounts (live account ids)", async () => {
  const { broker } = makeBroker({ gateway: { account: "U9876543" } });
  await assert.rejects(broker.connect(), /not an IBKR paper account/);
  assert.equal(broker.connected, false);
  assert.match(broker.status().lastError, /not an IBKR paper account/);
});

test("connects to a paper account and reports status", async () => {
  const { broker } = makeBroker();
  await broker.connect();
  const s = broker.status();
  assert.equal(s.connected, true);
  assert.equal(s.account, "DU1234567");
  assert.equal(s.paperVerified, true);
});

test("places a whole-share market order with TradingView symbol mapping", async () => {
  const { broker, gateway } = makeBroker();
  const result = await broker.placeOrder({ tvSymbol: "NASDAQ:AAPL", side: "buy", quantity: 12.9 });
  assert.equal(result.symbol, "AAPL");
  assert.equal(result.quantity, 12); // floored to whole shares
  assert.equal(result.status, "Filled");
  assert.equal(result.account, "DU1234567");

  const placed = gateway.orders[0];
  assert.equal(placed.contract.symbol, "AAPL");
  assert.equal(placed.contract.secType, "STK");
  assert.equal(placed.order.action, "BUY");
  assert.equal(placed.order.orderType, "MKT");
  assert.equal(placed.order.totalQuantity, 12);
});

test("sell maps to SELL and sub-share quantities are skipped", async () => {
  const { broker, gateway } = makeBroker();
  const skipped = await broker.placeOrder({ tvSymbol: "AAPL", side: "sell", quantity: 0.4 });
  assert.equal(skipped.skipped, true);
  assert.equal(gateway.orders.length, 0);

  const result = await broker.placeOrder({ tvSymbol: "AAPL", side: "sell", quantity: 3 });
  assert.equal(gateway.orders[0].order.action, "SELL");
  assert.equal(result.quantity, 3);
});

test("disabled adapter is inert", async () => {
  const broker = new IbkrPaperBroker({ enabled: false, port: 7496 }); // bad port ok when disabled
  assert.equal(broker.isEnabled(), false);
  assert.equal(await broker.connect(), false);
  await assert.rejects(broker.placeOrder({ tvSymbol: "AAPL", side: "buy", quantity: 5 }), /disabled/);
});
