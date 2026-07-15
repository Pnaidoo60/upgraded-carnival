// Self-contained daily chart report.
//
// renderReportHTML(data) turns a getCandles() result into a standalone HTML
// page (inline SVG, no external requests, theme-aware) with three stacked
// panels — price + EMA 20/50, RSI(14), MACD(12,26,9) — and a plain-language
// read of where the indicators sit. Pure string building: no browser, no
// server, so a scheduled job can generate it with just `node`.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => new Date(iso).toISOString().slice(0, 10);

// Layout shared across the three panels so they align on one time axis.
const W = 760, PADL = 52, PADR = 14;
const PLOTW = W - PADL - PADR;

function geometry(candles) {
  const n = candles.length;
  const band = PLOTW / n;
  const idxByT = new Map(candles.map((c, i) => [c.t, i]));
  return { n, band, cx: (i) => PADL + band * (i + 0.5), idx: (t) => idxByT.get(t) };
}

function pricePanel(candles, ema20, ema50, top, h) {
  let vMin = Math.min(...candles.map((c) => c.l));
  let vMax = Math.max(...candles.map((c) => c.h));
  const padV = (vMax - vMin) * 0.06 || 1;
  vMin -= padV; vMax += padV;
  const g = geometry(candles);
  const y = (v) => top + h - ((v - vMin) / (vMax - vMin)) * h;
  const bodyW = Math.max(1, Math.min(g.band * 0.6, 10));

  let s = "";
  for (let i = 0; i <= 4; i++) {
    const v = vMin + (vMax - vMin) * (i / 4);
    s += `<line class="grid" x1="${PADL}" x2="${W - PADR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` +
         `<text class="ax" x="${PADL - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${v.toFixed(0)}</text>`;
  }
  for (const c of candles) {
    const col = c.c >= c.o ? "var(--up)" : "var(--down)";
    const x = g.cx(g.idx(c.t));
    s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(c.h).toFixed(1)}" y2="${y(c.l).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    const t2 = Math.min(y(c.o), y(c.c)), bh = Math.max(0.5, Math.abs(y(c.c) - y(c.o)));
    s += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${t2.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`;
  }
  const line = (pts, colorVar) => {
    if (!pts || pts.length < 2) return "";
    const d = pts.map((p, k) => `${k ? "L" : "M"}${g.cx(g.idx(p.t)).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${colorVar}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  };
  s += line(ema20, "var(--ema-fast)");
  s += line(ema50, "var(--ema-slow)");
  return s;
}

function rsiPanel(candles, rsi, top, h) {
  const g = geometry(candles);
  const y = (v) => top + h - (v / 100) * h;
  let s = `<rect x="${PADL}" y="${y(70).toFixed(1)}" width="${PLOTW}" height="${(y(30) - y(70)).toFixed(1)}" fill="var(--accent)" opacity="0.06"/>`;
  for (const lv of [30, 50, 70]) {
    const dash = lv === 50 ? ' stroke-dasharray="2 3"' : "";
    s += `<line class="grid" x1="${PADL}" x2="${W - PADR}" y1="${y(lv).toFixed(1)}" y2="${y(lv).toFixed(1)}"${dash}/>` +
         `<text class="ax" x="${PADL - 6}" y="${(y(lv) + 3.5).toFixed(1)}" text-anchor="end">${lv}</text>`;
  }
  if (rsi && rsi.length >= 2) {
    const d = rsi.map((p, k) => `${k ? "L" : "M"}${g.cx(g.idx(p.t)).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    s += `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  return s;
}

function macdPanel(candles, macd, signal, hist, top, h) {
  const g = geometry(candles);
  const vals = [...macd, ...signal, ...hist].map((p) => p.v);
  const maxAbs = Math.max(1e-6, ...vals.map((v) => Math.abs(v)));
  const y = (v) => top + h / 2 - (v / maxAbs) * (h / 2);
  const bodyW = Math.max(1, Math.min(g.band * 0.6, 10));
  let s = `<line class="base" x1="${PADL}" x2="${W - PADR}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` +
          `<text class="ax" x="${PADL - 6}" y="${(y(0) + 3.5).toFixed(1)}" text-anchor="end">0</text>`;
  for (const p of hist) {
    const x = g.cx(g.idx(p.t));
    const col = p.v >= 0 ? "var(--up)" : "var(--down)";
    const t2 = Math.min(y(0), y(p.v)), bh = Math.max(0.5, Math.abs(y(p.v) - y(0)));
    s += `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${t2.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" opacity="0.55"/>`;
  }
  const line = (pts, colorVar) => {
    if (!pts || pts.length < 2) return "";
    const d = pts.map((p, k) => `${k ? "L" : "M"}${g.cx(g.idx(p.t)).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    return `<path d="${d}" fill="none" stroke="${colorVar}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  };
  s += line(macd, "var(--ema-fast)");
  s += line(signal, "var(--ema-slow)");
  return s;
}

// Plain-language read of the latest indicator state.
export function summarize(data) {
  const c = data.candles;
  const last = c[c.length - 1];
  const val = (arr) => (arr && arr.length ? arr[arr.length - 1].v : null);
  const e20 = val(data.ema["20"]), e50 = val(data.ema["50"]);
  const rsi = val(data.rsi);
  const macd = val(data.macd.macd), sig = val(data.macd.signal), hist = val(data.macd.hist);

  const trend = e20 == null || e50 == null ? "n/a"
    : e20 > e50 ? "bullish — EMA 20 above EMA 50" : "bearish — EMA 20 below EMA 50";
  const rsiZone = rsi == null ? "n/a" : rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : "neutral";
  const macdState = macd == null || sig == null ? "n/a"
    : macd > sig ? "bullish — MACD above signal" : "bearish — MACD below signal";

  return {
    date: fmtDate(last.t),
    close: last.c,
    trend,
    ema20: e20, ema50: e50,
    rsi, rsiZone,
    macd, signal: sig, hist, macdState,
  };
}

export function renderReportSVG(data) {
  const candles = data.candles || [];
  const pTop = 24, pH = 250;
  const rTop = pTop + pH + 46, rH = 100;
  const mTop = rTop + rH + 50, mH = 110;
  const H = mTop + mH + 26;

  const g = geometry(candles);
  let axis = "";
  [0, Math.floor(g.n / 2), g.n - 1].forEach((i) => {
    const anchor = i === 0 ? "start" : i === g.n - 1 ? "end" : "middle";
    const xp = i === 0 ? PADL : i === g.n - 1 ? W - PADR : g.cx(i);
    axis += `<text class="ax" x="${xp.toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="${anchor}">${fmtDate(candles[i].t)}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(data.symbol)} indicators">
  <text class="title" x="${PADL}" y="16">Price &amp; EMA 20 / 50</text>
  ${pricePanel(candles, data.ema["20"], data.ema["50"], pTop, pH)}
  <text class="title" x="${PADL}" y="${rTop - 8}">RSI (14)</text>
  ${rsiPanel(candles, data.rsi, rTop, rH)}
  <text class="title" x="${PADL}" y="${mTop - 8}">MACD (12, 26, 9)</text>
  ${macdPanel(candles, data.macd.macd, data.macd.signal, data.macd.hist, mTop, mH)}
  ${axis}
</svg>`;
}

export function renderReportHTML(data, { generatedAt = new Date() } = {}) {
  const s = summarize(data);
  const sourceNote = data.source === "synthetic"
    ? "Synthetic demo data — no live market feed was reachable when this report was generated."
    : "Live daily candles via Stooq.";
  const fmt = (v, d = 2) => (v == null ? "—" : v.toFixed(d));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.symbol)} — daily indicators ${s.date}</title>
<style>
  :root {
    --page:#f9f9f7; --surface:#fcfcfb; --text:#0b0b0b; --muted:#898781; --border:rgba(11,11,11,0.10);
    --grid:#e1e0d9; --base:#c3c2b7; --up:#008300; --down:#e34948; --accent:#2a78d6;
    --ema-fast:#2a78d6; --ema-slow:#e8710a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page:#0d0d0d; --surface:#1a1a19; --text:#fff; --muted:#898781; --border:rgba(255,255,255,0.10);
      --grid:#2c2c2a; --base:#383835; --up:#0aa30a; --down:#e66767; --accent:#3987e5;
      --ema-fast:#3987e5; --ema-slow:#ff9f45;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--page); color:var(--text); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; font-size:14px; line-height:1.45; }
  .wrap { max-width:820px; margin:0 auto; padding:24px 20px 40px; }
  h1 { font-size:20px; font-weight:650; margin:0 0 2px; }
  .sub { color:var(--muted); font-size:12px; margin:0 0 16px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; margin-bottom:14px; }
  .read { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:14px; }
  .tile { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .tile .l { font-size:12px; color:var(--muted); margin-bottom:3px; }
  .tile .v { font-size:20px; font-weight:650; }
  svg { display:block; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .base { stroke:var(--base); stroke-width:1; }
  .ax { font-size:10.5px; fill:var(--muted); }
  .title { font-size:12px; font-weight:600; fill:var(--text); }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; color:var(--muted); margin:0 0 8px; }
  .sw { width:10px; height:10px; border-radius:3px; display:inline-block; margin-right:5px; vertical-align:middle; }
</style></head>
<body><div class="wrap">
  <h1>${esc(data.symbol)} — daily indicator snapshot</h1>
  <p class="sub">${s.date} · ${esc(sourceNote)} · generated ${esc(generatedAt.toISOString().slice(0, 16).replace("T", " "))} UTC</p>

  <div class="read">
    <div class="tile"><div class="l">Close</div><div class="v">${fmt(s.close)}</div></div>
    <div class="tile"><div class="l">Trend (EMA)</div><div class="v" style="font-size:14px">${esc(s.trend)}</div></div>
    <div class="tile"><div class="l">RSI (14)</div><div class="v">${fmt(s.rsi, 1)} <span style="font-size:12px;color:var(--muted)">${esc(s.rsiZone)}</span></div></div>
    <div class="tile"><div class="l">MACD</div><div class="v" style="font-size:14px">${esc(s.macdState)}</div></div>
  </div>

  <div class="card">
    <div class="legend">
      <span><span class="sw" style="background:var(--up)"></span>Up</span>
      <span><span class="sw" style="background:var(--down)"></span>Down</span>
      <span><span class="sw" style="background:var(--ema-fast)"></span>EMA 20 / MACD</span>
      <span><span class="sw" style="background:var(--ema-slow)"></span>EMA 50 / Signal</span>
    </div>
    ${renderReportSVG(data)}
  </div>
</div></body></html>`;
}
