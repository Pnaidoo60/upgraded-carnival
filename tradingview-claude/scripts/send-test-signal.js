// Simulate a TradingView webhook so you can watch the dashboard react
// without waiting for a real alert to fire.
//
//   npm run test:signal
//
// Honors PORT and WEBHOOK_SECRET from your .env, just like the server.

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const samples = [
  { symbol: 'BTCUSD', timeframe: '1h', price: 64250.5, side: 'buy', strategy: 'SMA 10/30 crossover' },
  { symbol: 'ETHUSD', timeframe: '15m', price: 3120.0, side: 'sell', strategy: 'RSI overbought' },
  { symbol: 'AAPL', timeframe: '1D', price: 228.7, side: 'buy', strategy: 'breakout above resistance' },
];

const payload = {
  ...samples[Math.floor(Math.random() * samples.length)],
  time: new Date().toISOString(),
};
if (WEBHOOK_SECRET) payload.secret = WEBHOOK_SECRET;

async function main() {
  const res = await fetch(`http://localhost:${PORT}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log(`-> POST /webhook  ${res.status}`, body);
  console.log(`   payload:`, payload);
  console.log(`   Open http://localhost:${PORT}/ to watch Claude analyze it.`);
}

main().catch((err) => {
  console.error('Failed to reach the server. Is it running (npm start)?');
  console.error(err.message);
  process.exit(1);
});
