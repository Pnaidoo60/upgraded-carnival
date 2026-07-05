// Tiny file-backed store so signal history survives restarts.
//
// Persists to data/signals.json. No database engine and no native build step
// (which keeps `npm install` and CI simple), just an atomic JSON write on
// every change. Fine for the last-N-signals use case; swap for SQLite/Postgres
// if you outgrow it.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'signals.json');
const MAX_SIGNALS = 100;

let signals = [];
let nextId = 1;

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    signals = Array.isArray(parsed.signals) ? parsed.signals : [];
    nextId = Number.isInteger(parsed.nextId) ? parsed.nextId : signals.length + 1;
    // Any signal left mid-analysis when the process died can't finish — mark it.
    for (const s of signals) {
      if (s.status === 'analyzing') {
        s.status = 'error';
        s.error = 'interrupted by restart';
      }
    }
    console.log(`Loaded ${signals.length} signal(s) from ${path.relative(__dirname, DATA_FILE)}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Could not read ${DATA_FILE}: ${err.message} — starting empty`);
    }
    signals = [];
    nextId = 1;
  }
}

// Atomic write: write to a temp file then rename, so a crash mid-write can't
// corrupt the store.
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ nextId, signals }, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error(`Failed to persist signals: ${err.message}`);
  }
}

function all() {
  return signals;
}

function add(signalData) {
  const signal = { id: nextId++, ...signalData };
  signals.unshift(signal);
  if (signals.length > MAX_SIGNALS) signals.pop();
  persist();
  return signal;
}

// Mutate a stored signal in place (e.g. once Claude's analysis lands) and
// flush to disk.
function update(signal, changes) {
  Object.assign(signal, changes);
  persist();
  return signal;
}

module.exports = { load, all, add, update, MAX_SIGNALS, DATA_FILE };
