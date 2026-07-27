// Claude-powered signal analysis.
//
// Given a TradingView alert payload, asks Claude for a structured trading
// assessment (action / confidence / risk / summary / factors). Uses the
// Messages API with a JSON-schema-constrained output so the response is
// guaranteed parseable.
//
// When ANTHROPIC_API_KEY is not set, falls back to a deterministic mock
// analyzer so the dashboard and tests work without credentials.

import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["buy", "sell", "hold"],
      description: "Recommended action for this signal",
    },
    confidence: {
      type: "number",
      description: "Confidence in the recommendation, between 0 and 1",
    },
    risk: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Risk level of acting on this signal",
    },
    summary: {
      type: "string",
      description: "One or two sentence assessment of the signal",
    },
    factors: {
      type: "array",
      items: { type: "string" },
      description: "Key factors that informed the assessment",
    },
  },
  required: ["action", "confidence", "risk", "summary", "factors"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a trading signal analyst. You receive raw alert payloads from TradingView webhooks (Pine Script alerts). Assess each alert on its own merits: the stated side, price context, timeframe, strategy metadata, and any technical indicator values included in the payload.

Weigh the technical indicators when present, and let confidence reflect how well they AGREE with the alert's stated side. Common fields you may see: rsi (0-100), macd_hist (signed), trend ("up"/"down"/"flat"), volume_vs_avg (ratio, 1 = average), ema_fast/ema_slow. For a "buy", supporting evidence is e.g. an up trend, positive macd_hist, RSI rising but not overbought (roughly 45-70), above-average volume; for a "sell", the mirror. When most indicators align with the side, confidence should be high; when they conflict, confidence should be low and you may prefer "hold". Cite the specific indicator readings in "factors".

If an "event_context" object is present, a PUBLIC scheduled market event (e.g. a central-bank rate decision) is near. Prices often gap on such announcements, so be more cautious: lower confidence and raise risk for signals in that window, and say so.

Be conservative: if the payload is thin or ambiguous, prefer "hold" with lower confidence and say what information is missing. Never assume data that is not in the payload. Clamp confidence to [0, 1]. This is decision support, not financial advice, and downstream systems treat it as advisory only.`;

let client = null;

export function isLiveMode() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export async function analyzeSignal(alert, opts = {}) {
  const eventContext = opts.eventContext || null;
  if (!isLiveMode()) return mockAnalysis(alert, eventContext);

  const payload = eventContext ? { ...alert, event_context: eventContext } : alert;
  const response = await getClient().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Analyze this TradingView alert payload and return your structured assessment:\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to analyze this payload");
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("No text content in Claude response");
  const analysis = JSON.parse(text);
  analysis.confidence = clamp01(analysis.confidence);
  analysis.model = response.model;
  analysis.mode = "live";
  analysis.eventContext = eventContext;
  return analysis;
}

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

// How well the payload's technical indicators agree with the stated side.
// Returns null when no indicators are present (so richness-based scoring is
// used instead, preserving behaviour for indicator-free alerts).
function indicatorAgreement(alert, side) {
  const checks = [];
  const rsi = num(alert.rsi);
  if (rsi != null) {
    const ok = side === "buy" ? rsi > 45 && rsi < 70 : rsi < 55 && rsi > 30;
    checks.push({ ok, note: `RSI ${rsi}${ok ? " supportive" : " not supportive"}` });
  }
  const trend = String(alert.trend || "").toLowerCase();
  if (trend === "up" || trend === "down" || trend === "flat") {
    const ok = (side === "buy" && trend === "up") || (side === "sell" && trend === "down");
    checks.push({ ok, note: `Trend ${trend}${ok ? " aligns" : " conflicts"}` });
  }
  const macd = num(alert.macd_hist ?? alert.macd);
  if (macd != null) {
    const ok = side === "buy" ? macd > 0 : macd < 0;
    checks.push({ ok, note: `MACD histogram ${macd}${ok ? " aligns" : " conflicts"}` });
  }
  const vol = num(alert.volume_vs_avg ?? alert.volume_ratio);
  if (vol != null) {
    const ok = vol >= 1;
    checks.push({ ok, note: `Volume ${vol}× average${ok ? "" : " (thin)"}` });
  }
  const emaFast = num(alert.ema_fast);
  const emaSlow = num(alert.ema_slow);
  if (emaFast != null && emaSlow != null) {
    const ok = side === "buy" ? emaFast >= emaSlow : emaFast <= emaSlow;
    checks.push({ ok, note: `EMA ${emaFast}/${emaSlow}${ok ? " aligns" : " conflicts"}` });
  }
  if (checks.length === 0) return null;
  const agree = checks.filter((c) => c.ok).length;
  return { agree, total: checks.length, score: agree / checks.length, notes: checks.map((c) => c.note) };
}

// Deterministic heuristic used when no API key is configured. Mirrors the
// live schema exactly so the dashboard renders identically in both modes.
function mockAnalysis(alert, eventContext = null) {
  const side = String(alert.side || alert.action || "").toLowerCase();
  const hasPrice = alert.price !== undefined && alert.price !== null && alert.price !== "";
  const hasSymbol = Boolean(alert.symbol || alert.ticker);
  const richness = [hasSymbol, hasPrice, Boolean(alert.timeframe), Boolean(alert.strategy)]
    .filter(Boolean).length;

  const action = side === "buy" || side === "long" ? "buy"
    : side === "sell" || side === "short" ? "sell"
    : "hold";

  const factors = [];
  factors.push(hasSymbol ? `Symbol present: ${alert.symbol || alert.ticker}` : "No symbol in payload");
  factors.push(side ? `Alert side: ${side}` : "No side/direction in payload");
  factors.push(hasPrice ? `Price context: ${alert.price}` : "No price context");
  if (alert.timeframe) factors.push(`Timeframe: ${alert.timeframe}`);

  // Confidence: indicator agreement when indicators are present, else richness.
  let confidence;
  const agreement = action === "hold" ? null : indicatorAgreement(alert, action);
  if (action === "hold") {
    confidence = 0.3;
  } else if (agreement) {
    // 0 aligned -> 0.40, all aligned -> ~0.92
    confidence = 0.40 + 0.52 * agreement.score;
    factors.push(...agreement.notes);
    factors.push(`Indicators aligned: ${agreement.agree}/${agreement.total}`);
  } else {
    confidence = 0.4 + richness * 0.12;
  }

  let risk = agreement
    ? (agreement.score >= 0.75 ? "low" : agreement.score >= 0.4 ? "medium" : "high")
    : (richness >= 3 ? "medium" : "high");

  // Scheduled-event caution: prices gap on announcements, so trim confidence.
  if (eventContext) {
    confidence *= eventContext.daysUntil === 0 ? 0.7 : 0.85;
    risk = "high";
    factors.push(`Scheduled event in ${eventContext.daysUntil}d: ${eventContext.label} — reduced confidence`);
  }

  return {
    action,
    confidence: clamp01(confidence),
    risk,
    summary: action === "hold"
      ? "Payload lacks a clear direction; holding until a better-formed signal arrives."
      : `Heuristic ${action} assessment${agreement ? ` — ${agreement.agree}/${agreement.total} indicators aligned` : ""}${eventContext ? `, cautious near ${eventContext.label}` : ""} (mock mode — set ANTHROPIC_API_KEY for live Claude analysis).`,
    factors,
    eventContext,
    model: "mock",
    mode: "mock",
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
