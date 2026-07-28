// Paper-only safety guarantee — single source of truth.
//
// This codebase never places real-money orders. Every execution target is
// paper by construction: the built-in simulator (lib/paper.js) moves virtual
// cash only, and the optional IBKR mirror (lib/brokers/ibkr.js) is hard-locked
// to paper ports and paper account ids. To make that guarantee loud and
// impossible to flip by accident, this module:
//   1. refuses to boot if any env var hints at enabling real trading, and
//   2. exposes a constant trading mode that the startup banner, /health, and
//      the dashboard all read from.
// Real execution is intentionally not implemented anywhere in this repo.

export const TRADING_MODE = "paper";
export const TRADING_MODE_LABEL = "PAPER — real execution not implemented";

// Env vars that would only make sense if someone were trying to switch on real
// money. None of them are wired to anything — but if one is set truthy we
// refuse to boot, so the intent is caught loudly instead of silently ignored.
const REAL_TRADING_FLAGS = [
  "ALLOW_REAL_TRADING",
  "ENABLE_REAL_TRADING",
  "REAL_TRADING",
  "LIVE_TRADING",
  "ENABLE_REAL_MONEY",
  "REAL_MONEY",
  "ALLOW_LIVE_TRADING",
  "IBKR_ALLOW_LIVE",
];

const truthy = (v) => v != null && /^(1|true|yes|on)$/i.test(String(v).trim());

// Throws if any real-trading flag is set. Call once, before the server starts.
export function assertPaperOnly(env = process.env) {
  const tripped = REAL_TRADING_FLAGS.filter((name) => truthy(env[name]));
  if (tripped.length) {
    throw new Error(
      `Refusing to start: real-money trading is not implemented in this codebase, ` +
      `but these env var(s) request it: ${tripped.join(", ")}. ` +
      `Unset them — this service is paper-only by design.`
    );
  }
  return true;
}
