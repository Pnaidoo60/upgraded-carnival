// Self-contained smoke test for CI (and local use: `npm run smoke`).
// Spawns the server, exercises the full pipeline, asserts the results, then
// shuts down. Exits 0 on success, 1 on any failure.

const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.SMOKE_PORT || 3999;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch (_) {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not become healthy in time');
}

async function main() {
  // Run with no API key so the paper engine trades on the alert's `side`
  // (deterministic — no external Claude call in CI).
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ANTHROPIC_API_KEY: '', PAPER_TRADE_NOTIONAL: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  let failed = null;
  try {
    await waitForHealth();
    console.log('server healthy');

    // 1. Webhook accepts a signal.
    const post = await fetch(`${BASE}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSD', price: 50000, side: 'buy' }),
    });
    const posted = await post.json();
    assert(post.status === 200 && posted.ok, 'POST /webhook returns 200 ok');

    await new Promise((r) => setTimeout(r, 300));

    // 2. Signal + paper trade recorded and portfolio updated.
    const data = await (await fetch(`${BASE}/api/signals`)).json();
    assert(data.signals.length === 1, 'one signal recorded');
    assert(data.signals[0].trade && data.signals[0].trade.side === 'buy', 'paper buy trade attached');
    assert(data.portfolio.positions.length === 1, 'one open position');
    assert(Math.abs(data.portfolio.positions[0].qty - 10000 / 50000) < 1e-9, 'position sized to notional');
    assert(data.portfolio.equityCurve.length >= 1, 'equity curve has points');

    // 3. Secret enforcement (set via a second signal path is overkill; check reset instead).
    const reset = await (await fetch(`${BASE}/api/reset`, { method: 'POST' })).json();
    assert(reset.ok, 'POST /api/reset returns ok');
    assert(reset.portfolio.positions.length === 0, 'reset clears positions');
    assert(Math.abs(reset.portfolio.equity - reset.portfolio.startingCash) < 1e-9, 'reset restores starting equity');

    // 4. Signal history survives reset.
    const after = await (await fetch(`${BASE}/api/signals`)).json();
    assert(after.signals.length === 1, 'signal history kept after reset');

    console.log('\nSMOKE TEST PASSED');
  } catch (err) {
    failed = err;
    console.error('\nSMOKE TEST FAILED:', err.message);
    console.error('--- server log ---\n' + serverLog);
  } finally {
    server.kill('SIGTERM');
  }
  process.exit(failed ? 1 : 0);
}

main();
