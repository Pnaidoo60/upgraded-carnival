// TradingView -> Claude webhook forwarder + live dashboard.
//
// Flow:
//   TradingView alert (webhook) -> POST /webhook -> stored immediately
//     -> analyzed by Claude in the background -> record updated
//     -> GET /api/signals feeds the dashboard at GET /
//
// Nothing is persisted to disk: signals live in an in-memory ring buffer and
// reset when the process restarts. That keeps the project dependency-free and
// easy to run; swap `signals` for a database if you need durability.

require('dotenv').config();

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const HAS_API_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

const anthropic = HAS_API_KEY ? new Anthropic() : null;

// In-memory ring buffer of the most recent signals (newest first).
const MAX_SIGNALS = 100;
const signals = [];
let nextId = 1;

function recordSignal(payload) {
  const signal = {
    id: nextId++,
    receivedAt: new Date().toISOString(),
    payload,
    status: HAS_API_KEY ? 'analyzing' : 'no_api_key',
    analysis: null,
    error: null,
  };
  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.pop();
  return signal;
}

// Ask Claude to classify the alert and return a structured recommendation.
// Uses structured outputs so the response is guaranteed-parseable JSON.
async function analyzeSignal(signal) {
  const prompt = [
    'You are a trading-signal analyst. A TradingView alert just fired.',
    'Assess it and return your recommendation. Be conservative — this may',
    'drive real decisions. Do not invent data that is not in the alert.',
    '',
    'Alert payload:',
    JSON.stringify(signal.payload, null, 2),
  ].join('\n');

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['buy', 'sell', 'hold', 'close', 'ignore'],
              description: 'Recommended action based on the alert.',
            },
            confidence: {
              type: 'number',
              description: 'Confidence from 0 (none) to 1 (certain).',
            },
            risk_level: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
            },
            reasoning: {
              type: 'string',
              description: 'One or two sentences explaining the call.',
            },
          },
          required: ['action', 'confidence', 'risk_level', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text content');
  return JSON.parse(textBlock.text);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// TradingView posts here. We validate, store, respond 200 fast (so TradingView
// does not retry), then analyze in the background.
app.post('/webhook', (req, res) => {
  const payload = req.body || {};

  if (WEBHOOK_SECRET && payload.secret !== WEBHOOK_SECRET) {
    console.warn('Rejected webhook with bad/missing secret');
    return res.status(401).json({ error: 'invalid secret' });
  }

  // Don't store the shared secret alongside the signal.
  const { secret, ...safePayload } = payload;
  const signal = recordSignal(safePayload);
  res.status(200).json({ ok: true, id: signal.id });

  if (!anthropic) {
    console.log(`Signal #${signal.id} stored (no ANTHROPIC_API_KEY — skipping analysis)`);
    return;
  }

  analyzeSignal(signal)
    .then((analysis) => {
      signal.analysis = analysis;
      signal.status = 'done';
      console.log(`Signal #${signal.id} analyzed:`, analysis.action, `(${analysis.confidence})`);
    })
    .catch((err) => {
      signal.status = 'error';
      signal.error = err.message;
      console.error(`Signal #${signal.id} analysis failed:`, err.message);
    });
});

// Dashboard data source.
app.get('/api/signals', (req, res) => {
  res.json({
    configured: HAS_API_KEY,
    model: CLAUDE_MODEL,
    signals,
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n  TradingView -> Claude forwarder running`);
  console.log(`  Dashboard:  http://localhost:${PORT}/`);
  console.log(`  Webhook:    http://localhost:${PORT}/webhook`);
  console.log(`  Claude:     ${HAS_API_KEY ? `enabled (${CLAUDE_MODEL})` : 'DISABLED — set ANTHROPIC_API_KEY in .env'}`);
  console.log(`  Secret:     ${WEBHOOK_SECRET ? 'required' : 'not set (open — fine for local testing)'}\n`);
});
