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

const SYSTEM_PROMPT = `You are a trading signal analyst. You receive raw alert payloads from TradingView webhooks (Pine Script alerts). Assess each alert on its own merits: the stated side, price context, timeframe, and any strategy metadata included in the payload.

Be conservative: if the payload is thin or ambiguous, prefer "hold" with lower confidence and say what information is missing. Never assume data that is not in the payload. Clamp confidence to [0, 1]. This is decision support, not financial advice, and downstream systems treat it as advisory only.`;

let client = null;

export function isLiveMode() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export async function analyzeSignal(alert) {
  if (!isLiveMode()) return mockAnalysis(alert);

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
        content: `Analyze this TradingView alert payload and return your structured assessment:\n\n${JSON.stringify(alert, null, 2)}`,
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
  return analysis;
}

// Deterministic heuristic used when no API key is configured. Mirrors the
// live schema exactly so the dashboard renders identically in both modes.
function mockAnalysis(alert) {
  const side = String(alert.side || alert.action || "").toLowerCase();
  const hasPrice = alert.price !== undefined && alert.price !== null && alert.price !== "";
  const hasSymbol = Boolean(alert.symbol || alert.ticker);
  const richness = [hasSymbol, hasPrice, Boolean(alert.timeframe), Boolean(alert.strategy)]
    .filter(Boolean).length;

  const action = side === "buy" || side === "long" ? "buy"
    : side === "sell" || side === "short" ? "sell"
    : "hold";
  const confidence = action === "hold" ? 0.3 : 0.4 + richness * 0.12;
  const risk = richness >= 3 ? "medium" : "high";

  const factors = [];
  factors.push(hasSymbol ? `Symbol present: ${alert.symbol || alert.ticker}` : "No symbol in payload");
  factors.push(side ? `Alert side: ${side}` : "No side/direction in payload");
  factors.push(hasPrice ? `Price context: ${alert.price}` : "No price context");
  if (alert.timeframe) factors.push(`Timeframe: ${alert.timeframe}`);

  return {
    action,
    confidence: clamp01(confidence),
    risk,
    summary: action === "hold"
      ? "Payload lacks a clear direction; holding until a better-formed signal arrives."
      : `Heuristic ${action} assessment based on the alert's stated side and available context (mock mode — set ANTHROPIC_API_KEY for live Claude analysis).`,
    factors,
    model: "mock",
    mode: "mock",
  };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
