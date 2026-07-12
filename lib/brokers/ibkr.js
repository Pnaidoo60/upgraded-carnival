// Interactive Brokers PAPER trading adapter.
//
// Mirrors executed simulator decisions to an IBKR *paper* account through
// IB Gateway / TWS (via @stoqey/ib). The local simulator stays the source of
// truth for the dashboard; IBKR order ids/statuses are attached to each trade.
//
// HARD SAFETY LOCK — paper only, no override:
//   - only the paper API ports are accepted (7497 = TWS paper, 4002 = IB
//     Gateway paper). Live ports (7496 / 4001) are refused at startup.
//   - the connected account must be a paper account (IBKR paper account ids
//     start with "D", e.g. DU1234567). Anything else disconnects immediately.
// Real-money execution is intentionally not implemented in this codebase.

import { EventEmitter } from "node:events";

const PAPER_PORTS = new Set([7497, 4002]);
const ORDER_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;

export class IbkrPaperBroker {
  constructor(options = {}) {
    this.enabled = options.enabled ?? (process.env.BROKER === "ibkr" || process.env.IBKR_ENABLED === "true");
    this.host = options.host || process.env.IBKR_HOST || "127.0.0.1";
    this.port = Number(options.port || process.env.IBKR_PORT || 7497);
    this.clientId = Number(options.clientId || process.env.IBKR_CLIENT_ID || 17);
    this.exchange = options.exchange || process.env.IBKR_EXCHANGE || "SMART";
    this.currency = options.currency || process.env.IBKR_CURRENCY || "USD";
    // injectable for tests; defaults to the real @stoqey/ib client
    this.createApi = options.createApi || null;

    this.api = null;
    this.connected = false;
    this.account = null;
    this.nextOrderId = null;
    this.lastError = null;
    this.pending = new EventEmitter();
    this.connectPromise = null;

    if (this.enabled && !PAPER_PORTS.has(this.port)) {
      throw new Error(
        `IBKR port ${this.port} is not a paper-trading port. ` +
        `Use 7497 (TWS paper) or 4002 (IB Gateway paper). ` +
        `Live trading is deliberately not supported by this adapter.`
      );
    }
  }

  isEnabled() {
    return this.enabled;
  }

  status() {
    return {
      broker: "ibkr-paper",
      enabled: this.enabled,
      connected: this.connected,
      account: this.account,
      paperVerified: Boolean(this.account && this.account.startsWith("D")),
      host: this.host,
      port: this.port,
      exchange: this.exchange,
      currency: this.currency,
      lastError: this.lastError,
    };
  }

  async makeApi() {
    if (this.createApi) return this.createApi(this);
    const { IBApi } = await import("@stoqey/ib");
    return new IBApi({ host: this.host, port: this.port, clientId: this.clientId });
  }

  connect() {
    if (!this.enabled) return Promise.resolve(false);
    if (this.connected) return Promise.resolve(true);
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      const { EventName } = this.createApi ? fakeEventNames() : await import("@stoqey/ib");
      const api = await this.makeApi();
      this.api = api;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `timed out connecting to IB Gateway/TWS at ${this.host}:${this.port} — is it running and logged into a PAPER account?`
        )), CONNECT_TIMEOUT_MS);

        let gotAccounts = false, gotOrderId = false;
        const maybeDone = () => {
          if (gotAccounts && gotOrderId) { clearTimeout(timer); resolve(); }
        };

        api.on(EventName.managedAccounts, (accounts) => {
          const first = String(accounts).split(",")[0].trim();
          if (!first.startsWith("D")) {
            clearTimeout(timer);
            try { api.disconnect(); } catch {}
            reject(new Error(
              `refusing account "${first}": not an IBKR paper account (paper ids start with "D"). ` +
              `Log the gateway into your paper account.`
            ));
            return;
          }
          this.account = first;
          gotAccounts = true;
          maybeDone();
        });
        api.on(EventName.nextValidId, (orderId) => {
          this.nextOrderId = orderId;
          gotOrderId = true;
          maybeDone();
        });
        api.on(EventName.error, (err, code, reqId) => {
          const msg = err?.message || String(err);
          // informational codes (2104, 2106, 2158 = farm connection OK) are not failures
          if (typeof code === "number" && code >= 2000 && code < 3000) return;
          this.lastError = `${msg}${code != null ? ` (code ${code})` : ""}`;
          if (!this.connected && !gotAccounts) { clearTimeout(timer); reject(new Error(this.lastError)); }
        });
        api.on(EventName.orderStatus, (orderId, orderStatus, filled, remaining, avgFillPrice) => {
          this.pending.emit(`order:${orderId}`, { orderStatus, filled, remaining, avgFillPrice });
        });
        api.on(EventName.disconnected, () => {
          this.connected = false;
          this.connectPromise = null;
        });

        api.connect();
      });

      this.connected = true;
      this.lastError = null;
      return true;
    })().catch((err) => {
      this.lastError = err.message;
      this.connected = false;
      this.connectPromise = null;
      throw err;
    });

    return this.connectPromise;
  }

  // TradingView symbols look like "NASDAQ:AAPL" or "JSE:NPN" or plain "AAPL".
  parseSymbol(tvSymbol) {
    const raw = String(tvSymbol || "").trim();
    const parts = raw.split(":");
    return parts.length === 2 ? { exchange: parts[0], symbol: parts[1] } : { exchange: null, symbol: raw };
  }

  // Place a whole-share market order on the paper account.
  async placeOrder({ tvSymbol, side, quantity, currency, exchange }) {
    if (!this.enabled) throw new Error("IBKR adapter disabled");
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty < 1) {
      return { skipped: true, reason: "quantity below 1 whole share" };
    }
    await this.connect();

    const { symbol } = this.parseSymbol(tvSymbol);
    const contract = {
      symbol,
      secType: "STK",
      exchange: exchange || this.exchange,
      currency: currency || this.currency,
    };
    const order = {
      action: side === "buy" ? "BUY" : "SELL",
      orderType: "MKT",
      totalQuantity: qty,
      transmit: true,
      tif: "DAY",
    };

    const orderId = this.nextOrderId++;
    const statusPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.removeAllListeners(`order:${orderId}`);
        resolve({ orderStatus: "Submitted (no status callback yet)" });
      }, ORDER_TIMEOUT_MS);
      this.pending.once(`order:${orderId}`, (s) => { clearTimeout(timer); resolve(s); });
    });

    this.api.placeOrder(orderId, contract, order);
    const status = await statusPromise;
    return {
      orderId,
      account: this.account,
      symbol,
      side,
      quantity: qty,
      status: status.orderStatus,
      avgFillPrice: status.avgFillPrice ?? null,
    };
  }

  disconnect() {
    try { this.api?.disconnect(); } catch {}
    this.connected = false;
    this.connectPromise = null;
  }
}

// Event-name map used when a fake API is injected in tests (mirrors @stoqey/ib).
function fakeEventNames() {
  return {
    EventName: {
      connected: "connected",
      disconnected: "disconnected",
      error: "error",
      nextValidId: "nextValidId",
      managedAccounts: "managedAccounts",
      orderStatus: "orderStatus",
    },
  };
}
