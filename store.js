/**
 * One JSON file, written atomically. A single Node process owns it, so there
 * is no cross-process locking to worry about — the only failure this guards
 * against is a crash partway through a write.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_RACES = 200;
const DEFAULT_PATH =
  process.env.RTR_STORE_PATH || path.join(__dirname, 'data', 'store.json');

function emptyStore() {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
    profiles: {},
    records: {},
    races: [],
  };
}

// Backfill anything missing so a hand-edited or older file cannot crash boot.
function migrate(data) {
  const base = emptyStore();
  const secretOk = typeof data.secret === 'string' && data.secret.length >= 32;
  return {
    version: 1,
    secret: secretOk ? data.secret : base.secret,
    profiles: data.profiles && typeof data.profiles === 'object' ? data.profiles : {},
    records: data.records && typeof data.records === 'object' ? data.records : {},
    races: Array.isArray(data.races) ? data.races.slice(-MAX_RACES) : [],
  };
}

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyStore();
    throw e;
  }
  try {
    return migrate(JSON.parse(raw));
  } catch (e) {
    // Losing a leaderboard is bad; refusing to boot the game is worse. Keep the
    // damaged file for inspection and carry on with an empty one.
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* best effort */ }
    console.error(`[store] ${file} is not valid JSON — moved to ${aside}, starting fresh`);
    return emptyStore();
  }
}

function writeAtomic(data, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

function createStore(file = DEFAULT_PATH) {
  const data = load(file);
  return {
    data,
    file,
    save() { writeAtomic(data, file); },
  };
}

module.exports = { createStore, MAX_RACES, DEFAULT_PATH };
