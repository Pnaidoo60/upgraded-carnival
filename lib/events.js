// Public scheduled-event awareness.
//
// Loads a user-maintained list of PUBLIC scheduled market events (SARB MPC
// decision dates, CPI/GDP releases, etc.) and tells the analyzer when a signal
// is firing close to one. Price often gaps on the announcement, so signals in
// that window are treated more cautiously.
//
// This uses only publicly-known scheduled dates. It has nothing to do with
// non-public information — you populate it from official public calendars.

import { readFile } from "node:fs/promises";

const DAY_MS = 86_400_000;

export class MarketEvents {
  constructor(filePath, windowDays) {
    this.filePath = filePath;
    this.windowDays = Number(windowDays ?? process.env.EVENT_WINDOW_DAYS ?? 3);
    this.events = [];
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8"));
      this.events = (raw.events || []).filter((e) => e && e.date && e.label);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.events = [];
    }
  }

  // Days from `now` (date-only) to an ISO yyyy-mm-dd date. Negative = past.
  daysTo(dateStr, now) {
    const today = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z");
    const target = Date.parse(dateStr + "T00:00:00Z");
    if (Number.isNaN(target)) return null;
    return Math.round((target - today) / DAY_MS);
  }

  // Nearest upcoming event within the caution window, or null.
  contextFor(now = new Date()) {
    let best = null;
    for (const e of this.events) {
      const days = this.daysTo(e.date, now);
      if (days == null || days < 0 || days > this.windowDays) continue;
      if (!best || days < best.daysUntil) {
        best = { label: e.label, date: e.date, daysUntil: days, windowDays: this.windowDays };
      }
    }
    return best;
  }

  // Next few upcoming events (for the dashboard banner).
  upcoming(limit = 5, now = new Date()) {
    return this.events
      .map((e) => ({ label: e.label, date: e.date, daysUntil: this.daysTo(e.date, now) }))
      .filter((e) => e.daysUntil != null && e.daysUntil >= 0)
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .slice(0, limit);
  }
}
