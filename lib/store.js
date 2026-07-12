// Simple JSON-file-backed signal store.
// Keeps the newest MAX_SIGNALS signals; writes are serialized through a queue
// so concurrent webhook bursts can't interleave file writes.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

const MAX_SIGNALS = 500;

export class SignalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.signals = [];
    this.writeQueue = Promise.resolve();
    this.nextId = 1;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.signals = JSON.parse(raw);
      this.nextId = this.signals.reduce((m, s) => Math.max(m, s.id), 0) + 1;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.signals = [];
    }
  }

  add(alert) {
    const signal = {
      id: this.nextId++,
      receivedAt: new Date().toISOString(),
      alert,
      analysis: null,
      analysisStatus: "pending",
    };
    this.signals.push(signal);
    if (this.signals.length > MAX_SIGNALS) {
      this.signals.splice(0, this.signals.length - MAX_SIGNALS);
    }
    this.persist();
    return signal;
  }

  setAnalysis(id, analysis, status = "done") {
    const signal = this.signals.find((s) => s.id === id);
    if (!signal) return null;
    signal.analysis = analysis;
    signal.analysisStatus = status;
    this.persist();
    return signal;
  }

  list(limit = 100) {
    return this.signals.slice(-limit).reverse();
  }

  stats() {
    const total = this.signals.length;
    const byAction = { buy: 0, sell: 0, hold: 0 };
    let confidenceSum = 0;
    let analyzed = 0;
    for (const s of this.signals) {
      if (s.analysis && s.analysisStatus === "done") {
        analyzed++;
        if (s.analysis.action in byAction) byAction[s.analysis.action]++;
        confidenceSum += s.analysis.confidence ?? 0;
      }
    }
    return {
      total,
      analyzed,
      pending: this.signals.filter((s) => s.analysisStatus === "pending").length,
      failed: this.signals.filter((s) => s.analysisStatus === "failed").length,
      byAction,
      avgConfidence: analyzed ? confidenceSum / analyzed : null,
      lastSignalAt: total ? this.signals[total - 1].receivedAt : null,
    };
  }

  persist() {
    // Chain writes; atomic replace via temp file so a crash never leaves
    // a half-written store on disk.
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = this.filePath + ".tmp";
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.signals, null, 2));
      await rename(tmp, this.filePath);
    }).catch((err) => {
      console.error("store: persist failed:", err.message);
    });
    return this.writeQueue;
  }
}
