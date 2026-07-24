// Tests for the public scheduled-event module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MarketEvents } from "../lib/events.js";

async function withEvents(events, windowDays, fn) {
  const file = path.join(tmpdir(), `events-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify({ events }));
  try {
    const me = new MarketEvents(file, windowDays);
    await me.load();
    await fn(me);
  } finally {
    await rm(file, { force: true });
  }
}

const iso = (d) => d.toISOString().slice(0, 10);

test("contextFor flags an event inside the window and ignores ones outside", async () => {
  const now = new Date("2026-07-24T09:00:00Z");
  const inTwo = iso(new Date(now.getTime() + 2 * 86400000));
  const inTen = iso(new Date(now.getTime() + 10 * 86400000));
  await withEvents([
    { date: inTen, label: "Far event" },
    { date: inTwo, label: "SARB MPC rate decision" },
  ], 3, async (me) => {
    const ctx = me.contextFor(now);
    assert.ok(ctx);
    assert.equal(ctx.label, "SARB MPC rate decision");
    assert.equal(ctx.daysUntil, 2);
  });
});

test("contextFor returns null when nothing is within the window", async () => {
  const now = new Date("2026-07-24T09:00:00Z");
  const past = iso(new Date(now.getTime() - 2 * 86400000));
  const far = iso(new Date(now.getTime() + 30 * 86400000));
  await withEvents([{ date: past, label: "Yesterday" }, { date: far, label: "Next month" }], 3, async (me) => {
    assert.equal(me.contextFor(now), null);
  });
});

test("upcoming returns future events sorted nearest-first", async () => {
  const now = new Date("2026-07-24T09:00:00Z");
  const d = (n) => iso(new Date(now.getTime() + n * 86400000));
  await withEvents([
    { date: d(20), label: "C" }, { date: d(-1), label: "past" }, { date: d(5), label: "A" }, { date: d(12), label: "B" },
  ], 3, async (me) => {
    const up = me.upcoming(5, now);
    assert.deepEqual(up.map((e) => e.label), ["A", "B", "C"]);
    assert.equal(up[0].daysUntil, 5);
  });
});

test("empty events file is inert (no context, no upcoming)", async () => {
  await withEvents([], 3, async (me) => {
    assert.equal(me.contextFor(new Date()), null);
    assert.deepEqual(me.upcoming(), []);
  });
});
