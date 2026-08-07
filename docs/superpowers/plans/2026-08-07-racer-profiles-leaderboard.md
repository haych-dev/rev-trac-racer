# Rev-Trac Racer: Profiles, Leaderboard & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lobby controls, cookie-backed owned driver profiles, a per-track-records + standings leaderboard, and close the cheating routes that would make that leaderboard meaningless.

**Architecture:** Four new dependency-injected modules (`store`, `profiles`, `leaderboard`, `ratelimit`) keep `server.js` from growing past 1000 lines. `server.js` keeps owning the 30 Hz simulation and gains HTTP routes plus a socket handshake that resolves identity from a signed cookie. The client becomes a consumer of server-owned identity: it no longer sends a name at all.

**Tech Stack:** Node.js 22, Express 4, Socket.IO 4, plain HTML5 Canvas client, no build step. Persistence is one JSON file in a Docker named volume.

**Spec:** `docs/superpowers/specs/2026-08-07-racer-profiles-leaderboard-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **No new npm dependencies.** HMAC comes from `node:crypto`; cookie parsing is hand-rolled; JSON body parsing uses built-in `express.json()`. Do not add `cookie-parser`, `cookie`, or any test framework.
- **Tests are plain node scripts**, matching the existing `test/` convention: print diagnostics, print `PASS` or `FAIL`, `process.exit(pass ? 0 : 1)`. There is no vitest/jest/mocha in this repo. Do not introduce one.
- **Name rules, exact:** trimmed, regex `/^[A-Za-z0-9 _-]{3,16}$/`. Uniqueness is case-insensitive via a stored `nameLower`.
- **Cookie:** name `rtr_pid`, value `<uuid>.<hmac-hex-32>`, flags `httpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=157680000` (5y). **Never set `Secure`** — mktools serves plain HTTP over LAN and a Secure cookie would never be sent, silently breaking all identity.
- **Canonical laps for records is 3.** When `TOTAL_LAPS !== 3`, write no track records at all.
- **`BOOST_SPEED = 660` lives in `constants.js`** and is imported by both `server.js` and `leaderboard.js`. Do not redeclare the literal in either file — `leaderboard.js` cannot `require('./server.js')` (that would boot an HTTP listener), so a shared module is what keeps the plausibility floor and the physics honest without a sync-by-comment invariant.
- **Profile IDs are never sent to a client.** Not in `lobby`, not in `state`, not in `raceOver`, not in `/api/leaderboard`.
- **Port stays 3005** on mktools (`PORT` env, published in compose).
- Store path is overridable with `RTR_STORE_PATH`; default `<repo>/data/store.json`.

---

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `constants.js` | Physics values shared by the simulation and the leaderboard's plausibility floor |
| `store.js` | Load/save one JSON file atomically; own the schema + migration |
| `profiles.js` | Mint IDs, sign/verify cookies, validate/claim/release names, parse cookie headers |
| `leaderboard.js` | Record a finished race; derive standings + track records; plausibility floor |
| `ratelimit.js` | Token bucket keyed by an arbitrary string |
| `scripts/admin.js` | CLI to release a name orphaned by cleared cookies |
| `test/helpers/profile.js` | Test helper: bootstrap a profile over HTTP, return its cookie |
| `test/store.js` | Unit tests for `store.js` + `profiles.js` |
| `test/leaderboard.js` | Unit tests for `leaderboard.js` |
| `test/security.js` | Integration tests for the hardening claims |

**Modify:**

| File | Change |
|---|---|
| `server.js` | Wire modules; HTTP routes; socket handshake auth; drop client-supplied names; gate `/debug/rooms`; rate limits; record races in `checkRaceEnd` |
| `public/index.html` | Required-name gate, shared controls containers, leaderboard screen |
| `public/game.js` | Bootstrap profile before connecting; claim flow; render controls; leaderboard screen |
| `public/style.css` | Styles for the controls block, name gate, leaderboard tables |
| `package.json` | Add a `test` script for the server-free tests |
| `docker-compose.yml` | Named volume `rtr-data:/app/data` |
| `README.md` | Profiles, leaderboard, new env vars, admin script |
| `test/bots.js`, `test/capacity.js`, `test/exit.js` | Bootstrap profiles; use `RTR_STORE_PATH`; rename `P2`→`Player2` (2 chars fails the 3-char minimum) |

---

### Task 1: Atomic JSON store

**Files:**
- Create: `store.js`
- Test: `test/store.js`

**Interfaces:**
- Consumes: nothing
- Produces: `createStore(file?) -> { data, file, save() }` where `data` is `{ version:1, secret:string, profiles:{}, records:{}, races:[] }`. `MAX_RACES = 200` exported. Consumed by Tasks 2, 4, 5.

- [ ] **Step 1: Write the failing test**

Create `test/store.js`:

```js
/** Unit tests for store.js and profiles.js. Usage: node test/store.js */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-store-'));
const file = path.join(tmpdir, 'store.json');

const { createStore, MAX_RACES } = require('../store.js');

const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

console.log('store.js');

// fresh store
const s1 = createStore(file);
check('fresh store has version 1', s1.data.version === 1);
check('fresh store generates a secret', typeof s1.data.secret === 'string' && s1.data.secret.length >= 32);
check('fresh store has empty collections',
  Object.keys(s1.data.profiles).length === 0 && s1.data.races.length === 0);
check('no file written until save()', !fs.existsSync(file));

// round-trip
s1.data.profiles.abc = { name: 'Michael', nameLower: 'michael', createdAt: 1, races: 2, wins: 1, podiums: 1 };
s1.save();
check('save() creates the file', fs.existsSync(file));
check('save() leaves no .tmp behind', !fs.existsSync(file + '.tmp'));
const s2 = createStore(file);
check('reload round-trips a profile', s2.data.profiles.abc.name === 'Michael');
check('reload keeps the same secret', s2.data.secret === s1.data.secret);

// races cap
const s3 = createStore(path.join(tmpdir, 'cap.json'));
for (let i = 0; i < MAX_RACES + 50; i++) s3.data.races.push({ at: i });
s3.save();
const s4 = createStore(path.join(tmpdir, 'cap.json'));
check(`load caps races at ${MAX_RACES}`, s4.data.races.length === MAX_RACES);
check('load keeps the most recent races', s4.data.races[s4.data.races.length - 1].at === MAX_RACES + 49);

// a stale .tmp from a crashed write must not be loaded as the real file
const crashFile = path.join(tmpdir, 'crash.json');
const good = createStore(crashFile);
good.data.profiles.keep = { name: 'Keeper', nameLower: 'keeper', createdAt: 1, races: 0, wins: 0, podiums: 0 };
good.save();
fs.writeFileSync(crashFile + '.tmp', '{ this is a half-written file');
const afterCrash = createStore(crashFile);
check('a stale .tmp does not corrupt the load', afterCrash.data.profiles.keep.name === 'Keeper');

// corrupt main file is moved aside, not fatal
const badFile = path.join(tmpdir, 'bad.json');
fs.writeFileSync(badFile, 'not json at all');
const recovered = createStore(badFile);
check('corrupt store recovers to a fresh one', Object.keys(recovered.data.profiles).length === 0);
check('corrupt store is preserved alongside',
  fs.readdirSync(tmpdir).some((f) => f.startsWith('bad.json.corrupt-')));

// missing keys are backfilled rather than crashing
const partialFile = path.join(tmpdir, 'partial.json');
fs.writeFileSync(partialFile, JSON.stringify({ version: 1, profiles: { x: {} } }));
const partial = createStore(partialFile);
check('missing records/races are backfilled',
  typeof partial.data.records === 'object' && Array.isArray(partial.data.races));
check('missing secret is regenerated', typeof partial.data.secret === 'string' && partial.data.secret.length >= 32);

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/store.js`
Expected: FAIL — `Cannot find module '../store.js'`

- [ ] **Step 3: Write minimal implementation**

Create `store.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/store.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add store.js test/store.js
git commit -m "feat(store): atomic JSON persistence with schema backfill"
```

---

### Task 2: Profile identity — signing, claiming, releasing

**Files:**
- Create: `profiles.js`, `scripts/admin.js`
- Modify: `test/store.js` (append a `profiles.js` section)

**Interfaces:**
- Consumes: `createStore` from Task 1.
- Produces: `createProfiles(store) -> { COOKIE, sign(id), verify(token), mint(), get(id), claim(id, raw), release(name), validateName(raw) }` and a standalone `parseCookies(header) -> object`.
  - `mint()` returns `{ id, token }`. `verify(token)` returns an id string or `null`.
  - `claim` / `release` return `{ ok:true, name }` / `{ ok:false, error, code? }`.
  - Consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Append to `test/store.js`, immediately **before** the final `const failed = ...` block:

```js
// ---------------------------------------------------------------------------
console.log('profiles.js');
const { createProfiles, parseCookies } = require('../profiles.js');

const ps = createProfiles(createStore(path.join(tmpdir, 'profiles.json')));

check('parseCookies reads one pair', parseCookies('rtr_pid=abc').rtr_pid === 'abc');
check('parseCookies reads among many',
  parseCookies('a=1; rtr_pid=xyz; b=2').rtr_pid === 'xyz');
check('parseCookies tolerates junk', Object.keys(parseCookies('')).length === 0);

const { id, token } = ps.mint();
check('mint creates a profile', !!ps.get(id));
check('minted profile starts nameless', ps.get(id).name === null);
check('minted profile starts with zeroed stats',
  ps.get(id).races === 0 && ps.get(id).wins === 0 && ps.get(id).podiums === 0);
check('verify accepts a freshly minted token', ps.verify(token) === id);
check('verify rejects a tampered id', ps.verify(`other.${token.split('.')[1]}`) === null);
check('verify rejects a tampered signature', ps.verify(`${id}.deadbeef`) === null);
check('verify rejects junk', ps.verify('nonsense') === null && ps.verify(undefined) === null);

// name validation
check('name too short is rejected', ps.validateName('ab').ok === false);
check('name too long is rejected', ps.validateName('x'.repeat(17)).ok === false);
check('name with punctuation is rejected', ps.validateName('Bad!Name').ok === false);
check('name is trimmed', ps.validateName('  Michael  ').name === 'Michael');
check('spaces, underscore and dash are allowed', ps.validateName('Basis_Bandit-2').ok === true);

// claiming
check('claim succeeds on a free name', ps.claim(id, 'Michael').ok === true);
check('claim stores the trimmed name', ps.get(id).name === 'Michael');
check('claim stores a lowercased index', ps.get(id).nameLower === 'michael');

const other = ps.mint();
const taken = ps.claim(other.id, 'MICHAEL');
check('claim rejects a taken name case-insensitively', taken.ok === false);
check('taken name reports 409', taken.code === 409);
check('claim on unknown profile fails', ps.claim('no-such-id', 'Whoever').ok === false);

// renaming frees the old name
check('rename succeeds', ps.claim(id, 'Michael2').ok === true);
check('rename frees the previous name', ps.claim(other.id, 'Michael').ok === true);
check('renamed profile keeps its id', ps.get(id).name === 'Michael2');

// stats survive a rename — this is the whole point of keying on the id
ps.get(id).wins = 3;
ps.claim(id, 'Renamed');
check('stats survive a rename', ps.get(id).wins === 3);

// release
check('release frees an orphaned name', ps.release('Renamed').ok === true);
check('released profile is nameless', ps.get(id).name === null);
check('released name can be reclaimed', ps.claim(other.id, 'Renamed').ok === true);
check('release of an unheld name fails', ps.release('NobodyHasThis').ok === false);

// persistence across reloads
const persistFile = path.join(tmpdir, 'persist.json');
const p1 = createProfiles(createStore(persistFile));
const minted = p1.mint();
p1.claim(minted.id, 'Persisted');
const p2 = createProfiles(createStore(persistFile));
check('profiles persist across reload', p2.get(minted.id).name === 'Persisted');
check('a token still verifies after reload', p2.verify(minted.token) === minted.id);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/store.js`
Expected: FAIL — `Cannot find module '../profiles.js'`

- [ ] **Step 3: Write minimal implementation**

Create `profiles.js`:

```js
/**
 * Driver identity. A profile is a random id held by the browser in a signed
 * httpOnly cookie; a name is *owned* by that id. This is what makes the
 * leaderboard meaningful — impersonation needs cookie theft, not a text field.
 */
const crypto = require('crypto');

const COOKIE = 'rtr_pid';
const NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function createProfiles(store) {
  // Persisted so a restart does not invalidate everyone's identity. The env
  // override exists for the case where you want to rotate it deliberately.
  const secret = process.env.RTR_SECRET || store.data.secret;

  function sign(id) {
    return crypto.createHmac('sha256', secret).update(String(id)).digest('hex').slice(0, 32);
  }

  function verify(token) {
    if (typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const id = token.slice(0, i);
    const sig = token.slice(i + 1);
    const want = sign(id);
    if (sig.length !== want.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    return id;
  }

  function mint() {
    const id = crypto.randomUUID();
    store.data.profiles[id] = {
      name: null, nameLower: null, createdAt: Date.now(),
      races: 0, wins: 0, podiums: 0,
    };
    store.save();
    return { id, token: `${id}.${sign(id)}` };
  }

  function get(id) {
    return (id && store.data.profiles[id]) || null;
  }

  function validateName(raw) {
    const name = String(raw ?? '').trim();
    if (!NAME_RE.test(name)) {
      return {
        ok: false, code: 400,
        error: 'Name must be 3-16 characters: letters, numbers, space, _ or -',
      };
    }
    return { ok: true, name };
  }

  function holderOf(nameLower, exceptId) {
    for (const [pid, p] of Object.entries(store.data.profiles)) {
      if (pid !== exceptId && p.nameLower === nameLower) return pid;
    }
    return null;
  }

  function claim(id, raw) {
    const p = get(id);
    if (!p) return { ok: false, code: 400, error: 'No profile' };
    const v = validateName(raw);
    if (!v.ok) return v;
    const lower = v.name.toLowerCase();
    if (holderOf(lower, id)) {
      return { ok: false, code: 409, error: 'That name is taken' };
    }
    // Overwriting nameLower is what frees the previous name.
    p.name = v.name;
    p.nameLower = lower;
    store.save();
    return { ok: true, name: v.name };
  }

  function release(name) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return { ok: false, error: 'Give a name to release' };
    const pid = holderOf(lower, null);
    if (!pid) return { ok: false, error: 'No profile holds that name' };
    const p = store.data.profiles[pid];
    const had = p.name;
    p.name = null;
    p.nameLower = null;
    store.save();
    return { ok: true, id: pid, name: had };
  }

  return { COOKIE, sign, verify, mint, get, claim, release, validateName };
}

module.exports = { createProfiles, parseCookies, COOKIE, NAME_RE };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/store.js`
Expected: PASS

- [ ] **Step 5: Add the admin CLI**

Create `scripts/admin.js`:

```js
#!/usr/bin/env node
/**
 * Admin CLI for the one manual operation the cookie-only identity design
 * creates: a name orphaned by someone clearing their cookies.
 *
 *   node scripts/admin.js list
 *   node scripts/admin.js release "Michael"
 *
 * On mktools:
 *   docker exec rev-trac-racer node scripts/admin.js release "Michael"
 */
const { createStore } = require('../store.js');
const { createProfiles } = require('../profiles.js');

const store = createStore();
const profiles = createProfiles(store);
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'list') {
  const rows = Object.entries(store.data.profiles)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.wins - a.wins) || (b.races - a.races));
  if (!rows.length) return console.log('no profiles yet');
  console.log('name              races  wins  podiums  id');
  for (const r of rows) {
    console.log(
      `${String(r.name ?? '(unclaimed)').padEnd(17)}${String(r.races).padStart(5)}` +
      `${String(r.wins).padStart(6)}${String(r.podiums).padStart(9)}  ${r.id}`
    );
  }
} else if (cmd === 'release') {
  const res = profiles.release(arg);
  console.log(res.ok ? `released "${res.name}" (profile ${res.id} kept its stats)` : `error: ${res.error}`);
  process.exit(res.ok ? 0 : 1);
} else {
  console.log('usage: node scripts/admin.js list | release "<name>"');
  process.exit(1);
}
```

- [ ] **Step 6: Verify the CLI runs**

Run: `RTR_STORE_PATH=/tmp/rtr-admin-check.json node scripts/admin.js list`
Expected: prints `no profiles yet`, exit 0

- [ ] **Step 7: Commit**

```bash
git add profiles.js scripts/admin.js test/store.js
git commit -m "feat(profiles): cookie-signed owned driver names"
```

---

### Task 3: Token-bucket rate limiter

**Files:**
- Create: `ratelimit.js`
- Test: append to `test/store.js`

**Interfaces:**
- Consumes: nothing
- Produces: `createLimiter({ capacity, refillPerSec }) -> { allow(key, now?), forget(key), sweep(maxIdleMs, now?), size() }`. `allow` returns boolean. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Append to `test/store.js`, before the final `const failed = ...` block:

```js
// ---------------------------------------------------------------------------
console.log('ratelimit.js');
const { createLimiter } = require('../ratelimit.js');

const lim = createLimiter({ capacity: 3, refillPerSec: 1 });
const t0 = 1_000_000;
check('allows up to capacity',
  lim.allow('a', t0) && lim.allow('a', t0) && lim.allow('a', t0));
check('blocks past capacity', lim.allow('a', t0) === false);
check('keys are independent', lim.allow('b', t0) === true);
check('refills over time', lim.allow('a', t0 + 1000) === true);
check('refill does not exceed capacity',
  lim.allow('a', t0 + 60000) && lim.allow('a', t0 + 60000) &&
  lim.allow('a', t0 + 60000) && lim.allow('a', t0 + 60000) === false);

const lim2 = createLimiter({ capacity: 1, refillPerSec: 1 });
lim2.allow('gone', t0);
check('forget drops a key', (lim2.forget('gone'), lim2.size() === 0));
lim2.allow('old', t0);
lim2.allow('new', t0 + 50_000);
lim2.sweep(10_000, t0 + 60_000);
check('sweep drops idle keys only', lim2.size() === 1);

// A rewound clock must not credit refill for time that never passed. Both
// limiters see the same real elapsed span (t0 -> t0+500) and must agree; the
// skewed one only differs by a denied call at an earlier timestamp.
const mkEmpty = () => {
  const L = createLimiter({ capacity: 1, refillPerSec: 1 });
  L.allow('k', t0); // drains the bucket, so later denied calls consume nothing
  return L;
};
const clean = mkEmpty();
const skewed = mkEmpty();
skewed.allow('k', t0 - 500); // backward jump, denied because the bucket is empty
// Capture each result exactly once. Calling allow() a second time inside a
// later assertion would re-query already-advanced state and pass regardless of
// whether the rewind guard exists.
const cleanAt500 = clean.allow('k', t0 + 500);
const skewedAt500 = skewed.allow('k', t0 + 500);
check('a rewound clock does not grant a token early', skewedAt500 === cleanAt500);
// Anchors the check above: without it, both sides returning true would pass too.
check('500ms of a 1/s bucket is still not enough', cleanAt500 === false);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/store.js`
Expected: FAIL — `Cannot find module '../ratelimit.js'`

- [ ] **Step 3: Write minimal implementation**

Create `ratelimit.js`:

```js
/**
 * Token bucket. `now` is injectable so the tests do not need to sleep.
 *
 * These are DoS backstops, not security boundaries — see the spec. The real
 * integrity guarantees come from signed profile ownership and the 2+ distinct
 * profile rule, neither of which depends on request rate or IP.
 */
function createLimiter({ capacity, refillPerSec }) {
  const buckets = new Map(); // key -> { tokens, last }

  function allow(key, now = Date.now()) {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }
    const elapsed = Math.max(0, now - b.last) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerSec);
    // Never let a rewound clock regress the stored timestamp. Date.now() moves
    // backward under NTP correction, and a plain `b.last = now` would then
    // credit the next forward call with refill for time that never passed.
    b.last = Math.max(now, b.last);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  return {
    allow,
    forget(key) { buckets.delete(key); },
    // Buckets are created per socket id and per IP; without this the map grows
    // for the process lifetime.
    sweep(maxIdleMs, now = Date.now()) {
      for (const [k, b] of buckets) {
        if (now - b.last > maxIdleMs) buckets.delete(k);
      }
    },
    size() { return buckets.size; },
  };
}

module.exports = { createLimiter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/store.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ratelimit.js test/store.js
git commit -m "feat(ratelimit): injectable-clock token bucket"
```

---

### Task 4: Leaderboard recording and queries

**Files:**
- Create: `leaderboard.js`, `constants.js`
- Modify: `server.js:55-63` (source `BOOST_SPEED` from `constants.js` instead of its own literal)
- Test: `test/leaderboard.js`

**Interfaces:**
- Consumes: `createStore` (Task 1), `createProfiles` (Task 2).
- Produces: `constants.js` exporting `{ BOOST_SPEED: 660 }`, imported by both `leaderboard.js` and `server.js`.
- Produces: `createLeaderboard(store, profiles) -> { recordRace({ mapId, laps, entries, at? }), view(), minPlausibleMs(mapId, laps) }`.
  - `entries` is `[{ pid, name, pos, timeMs, finished, retired }]`, `pos` 1-based.
  - `recordRace` returns `{ standings: boolean, records: string[] }` (`records` = pids whose record improved).
  - `view()` returns `{ standings: [{ name, races, wins, podiums, bestByMap }], records: { [mapId]: [{ name, timeMs, at }] } }` — **never** any pid.
  - Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/leaderboard.js`:

```js
/** Unit tests for leaderboard.js. Usage: node test/leaderboard.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const RTMaps = require('../public/maps.js');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-lb-'));
const { createStore, MAX_RACES } = require('../store.js');
const { createProfiles } = require('../profiles.js');
const { createLeaderboard } = require('../leaderboard.js');

const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

let n = 0;
function fixture() {
  const store = createStore(path.join(tmpdir, `s${n++}.json`));
  const profiles = createProfiles(store);
  const lb = createLeaderboard(store, profiles);
  return { store, profiles, lb };
}
function driver(profiles, name) {
  const { id } = profiles.mint();
  profiles.claim(id, name);
  return id;
}

// A realistic finishing time for map 0: bots run ~46.9s, the floor is ~13.5s.
const GOOD = 46_900;

console.log('solo race');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Solo');
  const res = lb.recordRace({
    mapId: 0, laps: 3,
    entries: [{ pid: a, name: 'Solo', pos: 1, timeMs: GOOD, finished: true, retired: false }],
  });
  check('solo race does not count for standings', res.standings === false);
  check('solo race still sets a track record', res.records.includes(a));
  check('solo race leaves races at 0', profiles.get(a).races === 0);
  check('solo race leaves wins at 0', profiles.get(a).wins === 0);
  check('the record is visible', lb.view().records['0'][0].timeMs === GOOD);
}

console.log('two-driver race');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'First');
  const b = driver(profiles, 'Second');
  const res = lb.recordRace({
    mapId: 0, laps: 3,
    entries: [
      { pid: a, name: 'First', pos: 1, timeMs: GOOD, finished: true, retired: false },
      { pid: b, name: 'Second', pos: 2, timeMs: GOOD + 2000, finished: true, retired: false },
    ],
  });
  check('two distinct profiles count for standings', res.standings === true);
  check('winner gets a race', profiles.get(a).races === 1);
  check('winner gets a win', profiles.get(a).wins === 1);
  check('winner gets a podium', profiles.get(a).podiums === 1);
  check('runner-up gets a race', profiles.get(b).races === 1);
  check('runner-up gets no win', profiles.get(b).wins === 0);
  check('runner-up gets a podium', profiles.get(b).podiums === 1);
}

console.log('retired driver');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Finisher');
  const q = driver(profiles, 'Quitter');
  lb.recordRace({
    mapId: 0, laps: 3,
    entries: [
      { pid: a, name: 'Finisher', pos: 1, timeMs: GOOD, finished: true, retired: false },
      { pid: q, name: 'Quitter', pos: 2, timeMs: null, finished: true, retired: true },
    ],
  });
  check('retiring still counts a race', profiles.get(q).races === 1);
  check('retiring earns no win', profiles.get(q).wins === 0);
  check('retiring earns no podium', profiles.get(q).podiums === 0);
  check('retiring sets no record', (lb.view().records['0'] || []).every((r) => r.name !== 'Quitter'));
}

console.log('4th place gets no podium');
{
  const { profiles, lb } = fixture();
  const ids = ['P1', 'P2c', 'P3c', 'P4c'].map((nm) => driver(profiles, nm + 'x'));
  lb.recordRace({
    mapId: 0, laps: 3,
    entries: ids.map((pid, i) => ({
      pid, name: `d${i}`, pos: i + 1, timeMs: GOOD + i * 1000, finished: true, retired: false,
    })),
  });
  check('3rd place gets a podium', profiles.get(ids[2]).podiums === 1);
  check('4th place gets no podium', profiles.get(ids[3]).podiums === 0);
  check('4th place still gets a race', profiles.get(ids[3]).races === 1);
}

console.log('plausibility floor');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Cheater');
  const floor = lb.minPlausibleMs(0, 3);
  check('floor is below a real time', floor < GOOD);
  check('floor matches track length / boost speed',
    Math.round(floor) === Math.round((RTMaps.MAPS[0].path.total * 3) / 660 * 1000));
  const res = lb.recordRace({
    mapId: 0, laps: 3,
    entries: [{ pid: a, name: 'Cheater', pos: 1, timeMs: Math.floor(floor) - 1, finished: true, retired: false }],
  });
  check('an impossible time sets no record', res.records.length === 0);
  check('an impossible time leaves the board empty', (lb.view().records['0'] || []).length === 0);
}

console.log('non-canonical lap counts');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Tester');
  const res = lb.recordRace({
    mapId: 0, laps: 1,
    entries: [{ pid: a, name: 'Tester', pos: 1, timeMs: 20_000, finished: true, retired: false }],
  });
  check('a 1-lap race sets no record', res.records.length === 0);
  check('a 1-lap board stays empty', (lb.view().records['0'] || []).length === 0);
}

console.log('best-only records');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Improver');
  lb.recordRace({ mapId: 0, laps: 3, entries: [{ pid: a, name: 'Improver', pos: 1, timeMs: 60_000, finished: true, retired: false }] });
  lb.recordRace({ mapId: 0, laps: 3, entries: [{ pid: a, name: 'Improver', pos: 1, timeMs: 50_000, finished: true, retired: false }] });
  lb.recordRace({ mapId: 0, laps: 3, entries: [{ pid: a, name: 'Improver', pos: 1, timeMs: 70_000, finished: true, retired: false }] });
  const list = lb.view().records['0'];
  check('one row per profile', list.length === 1);
  check('the row holds the best time', list[0].timeMs === 50_000);
}

console.log('top-10-per-map truncation');
{
  const { profiles, lb } = fixture();
  // 14 distinct profiles each set a record on map 0, progressively slower.
  for (let i = 0; i < 14; i++) {
    const name = `Driver${i + 10}`;
    const pid = driver(profiles, name);
    lb.recordRace({
      mapId: 0, laps: 3,
      entries: [{ pid, name, pos: 1, timeMs: GOOD + i * 100, finished: true, retired: false }],
    });
  }
  const list = lb.view().records['0'];
  check('records cap at 10 per map', list.length === 10);
  check('the kept rows are the 10 fastest',
    list[0].timeMs === GOOD && list[9].timeMs === GOOD + 900);
  check('kept rows stay sorted ascending',
    list.every((r, i) => i === 0 || list[i - 1].timeMs <= r.timeMs));

  // A newcomer faster than the slowest kept row must displace it.
  const fastPid = driver(profiles, 'Latecomer');
  lb.recordRace({
    mapId: 0, laps: 3,
    entries: [{ pid: fastPid, name: 'Latecomer', pos: 1, timeMs: GOOD - 500, finished: true, retired: false }],
  });
  const after = lb.view().records['0'];
  check('a faster newcomer enters a full board', after[0].timeMs === GOOD - 500);
  check('a full board stays at 10 after a displacement', after.length === 10);
  check('the slowest row was evicted', after.every((r) => r.timeMs <= GOOD + 800));

  // ...and one slower than every kept row must not appear at all.
  const slowPid = driver(profiles, 'Slowpoke');
  lb.recordRace({
    mapId: 0, laps: 3,
    entries: [{ pid: slowPid, name: 'Slowpoke', pos: 1, timeMs: GOOD + 5000, finished: true, retired: false }],
  });
  check('a slower newcomer does not appear on a full board',
    lb.view().records['0'].every((r) => r.name !== 'Slowpoke'));
}

console.log('view() shape and leakage');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Alpha');
  const b = driver(profiles, 'Beta');
  lb.recordRace({
    mapId: 2, laps: 3,
    entries: [
      { pid: a, name: 'Alpha', pos: 1, timeMs: GOOD, finished: true, retired: false },
      { pid: b, name: 'Beta', pos: 2, timeMs: GOOD + 1000, finished: true, retired: false },
    ],
  });
  const v = lb.view();
  check('standings are sorted with the winner first', v.standings[0].name === 'Alpha');
  check('standings expose bestByMap', v.standings[0].bestByMap['2'] === GOOD);
  const json = JSON.stringify(v);
  check('view() leaks no profile id', !json.includes(a) && !json.includes(b));
  check('records are keyed by map id', Object.keys(v.records).includes('2'));
  check('unraced drivers are omitted from standings',
    (driver(profiles, 'Lurker'), lb.view().standings.every((s) => s.name !== 'Lurker')));
}

console.log('unknown profiles are ignored');
{
  const { profiles, lb } = fixture();
  const a = driver(profiles, 'Real');
  const res = lb.recordRace({
    mapId: 0, laps: 3,
    entries: [
      { pid: a, name: 'Real', pos: 1, timeMs: GOOD, finished: true, retired: false },
      { pid: 'ghost-id', name: 'Ghost', pos: 2, timeMs: GOOD + 1, finished: true, retired: false },
    ],
  });
  check('a ghost entry does not create standings', res.standings === false);
  check('a ghost entry is not stored', !JSON.stringify(lb.view()).includes('Ghost'));
}

console.log('race history cap');
{
  const { store, profiles, lb } = fixture();
  const a = driver(profiles, 'Grinder');
  for (let i = 0; i < MAX_RACES + 10; i++) {
    lb.recordRace({ mapId: 0, laps: 3, entries: [{ pid: a, name: 'Grinder', pos: 1, timeMs: GOOD + i, finished: true, retired: false }] });
  }
  check(`race history caps at ${MAX_RACES}`, store.data.races.length === MAX_RACES);
}

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/leaderboard.js`
Expected: FAIL — `Cannot find module '../leaderboard.js'`

- [ ] **Step 3: Create the shared constants module**

`leaderboard.js` needs `BOOST_SPEED` for its plausibility floor, and `server.js` needs it for the simulation. `leaderboard.js` cannot `require('./server.js')` — that would boot an HTTP listener — so the value lives in its own module and both import it.

Create `constants.js`:

```js
/**
 * Physics values shared by the simulation (server.js) and the leaderboard's
 * plausibility floor (leaderboard.js).
 *
 * These live here rather than in server.js because requiring server.js starts
 * an HTTP listener as a side effect, so nothing else can import from it.
 */
module.exports = {
  // Top speed while a Chevron Boost is active. The leaderboard's minimum
  // plausible race time assumes a car holding this the whole way — which no
  // real run can do, making the floor safe against false rejections.
  BOOST_SPEED: 660,
};
```

Then in `server.js`, replace the `const BOOST_SPEED = 660;` line (`server.js:59`) so the value has one home. Add the require next to the other module requires:

```js
const { BOOST_SPEED } = require('./constants.js');
```

and delete the `const BOOST_SPEED = 660;` line from the physics block, leaving the surrounding constants (`ACCEL`, `BRAKE`, `MAX_SPEED`, …) untouched.

Verify the server still boots and races before moving on:

```bash
PORT=4102 LAPS=1 node server.js > /tmp/rtr-const.log 2>&1 &
sleep 1 && node test/bots.js http://localhost:4102 2 0 | tail -2; kill %1
```

Expected: PASS — boost still works, so the constant is wired correctly.

- [ ] **Step 4: Write minimal implementation**

Create `leaderboard.js`:

```js
/**
 * Turns a finished race into durable standings and track records.
 *
 * Two deliberate asymmetries, both from the spec:
 *   - Track records count solo runs. A fast time is fast whether or not
 *     anyone else was on track.
 *   - Standings need 2+ distinct profiles, which is what stops someone
 *     farming wins in an empty room.
 */
const RTMaps = require('./public/maps.js');
const { MAX_RACES } = require('./store.js');
// Shared with the simulation. The floor is only safe because it assumes a car
// boosting the entire way, which no real run can do.
const { BOOST_SPEED } = require('./constants.js');

const CANON_LAPS = 3;
const RECORDS_PER_MAP = 10;

function mapById(mapId) {
  return RTMaps.MAPS.find((m) => m.id === mapId) || RTMaps.MAPS[0];
}

function createLeaderboard(store, profiles) {
  function minPlausibleMs(mapId, laps) {
    return (mapById(mapId).path.total * laps) / BOOST_SPEED * 1000;
  }

  function upsertRecord(mapId, pid, name, timeMs, at) {
    const key = String(mapId);
    const list = store.data.records[key] || (store.data.records[key] = []);
    const existing = list.find((r) => r.pid === pid);
    if (existing) {
      if (timeMs >= existing.timeMs) return false;
      existing.timeMs = timeMs;
      existing.name = name;
      existing.at = at;
    } else {
      list.push({ pid, name, timeMs, at });
    }
    list.sort((a, b) => a.timeMs - b.timeMs);
    if (list.length > RECORDS_PER_MAP) list.length = RECORDS_PER_MAP;
    return true;
  }

  function recordRace({ mapId, laps, entries, at = Date.now() }) {
    // A pid with no profile behind it cannot earn anything, and must not count
    // toward the 2-driver threshold either.
    const valid = (entries || []).filter((e) => e && profiles.get(e.pid));
    const distinct = new Set(valid.map((e) => e.pid));
    const forStandings = distinct.size >= 2;
    const canRecord = laps === CANON_LAPS;
    const floor = minPlausibleMs(mapId, laps);
    const improved = [];

    for (const e of valid) {
      const p = profiles.get(e.pid);
      const trueFinish = !!e.finished && !e.retired;

      if (forStandings) {
        p.races += 1;                                  // retiring still counts
        if (trueFinish) {
          if (e.pos === 1) p.wins += 1;
          if (e.pos <= 3) p.podiums += 1;
        }
      }

      if (canRecord && trueFinish && typeof e.timeMs === 'number' && e.timeMs >= floor) {
        if (upsertRecord(mapId, e.pid, p.name, e.timeMs, at)) improved.push(e.pid);
      }
    }

    store.data.races.push({
      at, mapId, laps,
      players: valid.map((e) => ({
        pid: e.pid, name: e.name, pos: e.pos,
        timeMs: e.timeMs, finished: !!e.finished && !e.retired,
      })),
    });
    if (store.data.races.length > MAX_RACES) {
      store.data.races = store.data.races.slice(-MAX_RACES);
    }

    store.save();
    return { standings: forStandings, records: improved };
  }

  function view() {
    // Best time per profile per map, so standings can show a personal best
    // without the client having to join the two tables itself.
    const bestByPid = {};
    for (const [key, list] of Object.entries(store.data.records)) {
      for (const r of list) {
        (bestByPid[r.pid] || (bestByPid[r.pid] = {}))[key] = r.timeMs;
      }
    }

    const standings = Object.entries(store.data.profiles)
      .filter(([, p]) => p.name && p.races > 0)
      .map(([pid, p]) => ({
        name: p.name,
        races: p.races,
        wins: p.wins,
        podiums: p.podiums,
        bestByMap: bestByPid[pid] || {},
      }))
      .sort((a, b) => (b.wins - a.wins) || (b.podiums - a.podiums) || (a.races - b.races));

    const records = {};
    for (const [key, list] of Object.entries(store.data.records)) {
      // pid is deliberately dropped — it is a bearer-ish identifier.
      records[key] = list.map((r) => ({ name: r.name, timeMs: r.timeMs, at: r.at }));
    }

    return { standings, records };
  }

  return { recordRace, view, minPlausibleMs };
}

module.exports = { createLeaderboard, CANON_LAPS, RECORDS_PER_MAP };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node test/leaderboard.js`
Expected: PASS

- [ ] **Step 6: Add a test script and run the whole server-free suite**

Modify `package.json` — add to `"scripts"`:

```json
"test": "node test/store.js && node test/leaderboard.js && node test/validate-maps.js"
```

Run: `npm test`
Expected: three PASS lines, exit 0

- [ ] **Step 7: Commit**

```bash
git add leaderboard.js test/leaderboard.js package.json
git commit -m "feat(leaderboard): track records and standings with farming guards"
```

---

### Task 5: Wire the server — identity, routes, hardening

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: all four modules from Tasks 1-4.
- Produces:
  - `GET /api/profile/me` → `{ id, name }`, sets the cookie when absent
  - `POST /api/profile/name` `{ name }` → `{ ok, name }` | 400 | 409 | 429
  - `GET /api/leaderboard` → `leaderboard.view()`
  - Socket refusals `'No profile'` / `'Invalid profile'` / `'Claim a name first'`
  - Room players carry a non-broadcast `pid`
  - Consumed by Tasks 6 and 7.

- [ ] **Step 1: Add the module wiring and HTTP routes**

In `server.js`, after the existing `const { CARS } = require('./public/cars.js');` line, add:

```js
const { createStore } = require('./store.js');
const { createProfiles, parseCookies } = require('./profiles.js');
const { createLeaderboard } = require('./leaderboard.js');
const { createLimiter } = require('./ratelimit.js');

const store = createStore();
const profiles = createProfiles(store);
const leaderboard = createLeaderboard(store, profiles);

const MAX_ROOMS = 200;
const COOKIE_MAX_AGE = 157680000; // 5 years, in seconds

// Per-socket buckets: one socket is one player, so these can be tight.
const limInput = createLimiter({ capacity: 60, refillPerSec: 60 });
const limItem = createLimiter({ capacity: 10, refillPerSec: 10 });
const limJoin = createLimiter({ capacity: 5, refillPerSec: 0.5 }); // 5 per 10s
// Per-IP buckets: deliberately loose. mktools is LAN/VPN-only, so a whole
// office can share one NAT address — tight per-IP limits would punish the
// normal case. These are DoS backstops, not the integrity mechanism.
const limName = createLimiter({ capacity: 30, refillPerSec: 0.5 }); // 30/min
const MAX_SOCKETS_PER_IP = 64;
const socketsPerIp = new Map();

setInterval(() => {
  const idle = 10 * 60 * 1000;
  limInput.sweep(idle); limItem.sweep(idle);
  limJoin.sweep(idle); limName.sweep(idle);
}, 60 * 1000).unref();

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'unknown';
}
```

Replace the existing `/debug/rooms` route (currently `server.js:9-16`) with a gated version, and add the new routes. The debug route must move **below** `const app = express()` but its behaviour is what matters:

```js
app.use(express.json({ limit: '4kb' }));

// Leaks every room code, socket id and player name — off unless asked for.
app.get('/debug/rooms', (req, res) => {
  if (process.env.RTR_DEBUG !== '1') return res.status(404).end();
  res.json([...rooms.values()].map((r) => ({
    code: r.code,
    status: r.status,
    hostId: r.hostId,
    players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, carId: p.carId, ready: p.ready })),
  })));
});

app.get('/api/profile/me', (req, res) => {
  const token = parseCookies(req.headers.cookie)[profiles.COOKIE];
  const id = profiles.verify(token);
  if (id && profiles.get(id)) {
    return res.json({ id, name: profiles.get(id).name });
  }
  const minted = profiles.mint();
  // res.cookie() is native to Express — only *reading* req.cookies would need
  // cookie-parser, and we parse the header ourselves instead.
  //
  // No Secure flag: mktools serves plain HTTP over LAN, and a Secure cookie
  // would never be sent, silently breaking identity for everyone. maxAge here
  // is milliseconds, hence the *1000 on the seconds constant.
  res.cookie(profiles.COOKIE, minted.token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE * 1000,
  });
  res.json({ id: minted.id, name: null });
});

app.post('/api/profile/name', (req, res) => {
  if (!limName.allow(ipOf(req))) {
    return res.status(429).json({ ok: false, error: 'Too many name changes — wait a moment' });
  }
  const token = parseCookies(req.headers.cookie)[profiles.COOKIE];
  const id = profiles.verify(token);
  if (!id || !profiles.get(id)) {
    return res.status(400).json({ ok: false, error: 'No profile — reload the page' });
  }
  const result = profiles.claim(id, req.body && req.body.name);
  if (!result.ok) return res.status(result.code || 400).json(result);
  res.json({ ok: true, name: result.name });
});

app.get('/api/leaderboard', (req, res) => res.json(leaderboard.view()));
```

- [ ] **Step 2: Write the failing security test**

Create `test/security.js`:

```js
/**
 * Integration tests for the hardening claims in the spec.
 * Start a server first:
 *   RTR_STORE_PATH=/tmp/rtr-sec.json PORT=4200 LAPS=1 node server.js
 * Then: node test/security.js http://localhost:4200
 */
const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:4200';
const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

async function bootstrap() {
  const res = await fetch(`${URL}/api/profile/me`);
  const setCookie = res.headers.get('set-cookie') || '';
  const body = await res.json();
  return { cookie: setCookie.split(';')[0], body };
}
async function claim(cookie, name) {
  const res = await fetch(`${URL}/api/profile/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
  return { status: res.status, body: await res.json() };
}
function connect(cookie) {
  return new Promise((resolve, reject) => {
    const opts = { transports: ['websocket'], reconnection: false };
    if (cookie) opts.extraHeaders = { Cookie: cookie };
    const s = io(URL, opts);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
function emit(sock, event, payload) {
  return new Promise((resolve) => sock.emit(event, payload, resolve));
}

(async () => {
  const sockets = [];
  try {
    console.log('profile bootstrap');
    const first = await bootstrap();
    check('bootstrap sets a cookie', first.cookie.startsWith('rtr_pid='));
    check('a new profile starts nameless', first.body.name === null);
    const again = await fetch(`${URL}/api/profile/me`, { headers: { cookie: first.cookie } });
    const againBody = await again.json();
    check('an existing cookie keeps its id', againBody.id === first.body.id);

    console.log('name claiming');
    check('a 2-char name is rejected', (await claim(first.cookie, 'ab')).status === 400);
    check('punctuation is rejected', (await claim(first.cookie, 'Bad!')).status === 400);
    const ok = await claim(first.cookie, 'SecTester');
    check('a valid name is accepted', ok.status === 200 && ok.body.name === 'SecTester');
    const second = await bootstrap();
    const dupe = await claim(second.cookie, 'sectester');
    check('a taken name returns 409 case-insensitively', dupe.status === 409);

    console.log('socket refusals');
    const nameless = await connect(second.cookie);
    sockets.push(nameless);
    const r1 = await emit(nameless, 'createRoom', {});
    check('a valid cookie with no name is refused', r1.ok === false);
    check('...with "Claim a name first"', r1.error === 'Claim a name first');

    const anon = await connect(null);
    sockets.push(anon);
    const r2 = await emit(anon, 'createRoom', {});
    check('a cookieless socket is refused', r2.ok === false && r2.error === 'No profile');

    const forged = await connect('rtr_pid=11111111-1111-1111-1111-111111111111.deadbeefdeadbeefdeadbeefdeadbeef');
    sockets.push(forged);
    const r3 = await emit(forged, 'createRoom', {});
    check('a forged cookie is refused', r3.ok === false && r3.error === 'Invalid profile');

    console.log('the client cannot choose its own name');
    const good = await connect(first.cookie);
    sockets.push(good);
    const created = await emit(good, 'createRoom', { name: 'Imposter' });
    check('createRoom succeeds with a claimed profile', created.ok === true);
    const lobby = await new Promise((res) => good.once('lobby', res));
    check('the server ignores a client-supplied name',
      lobby.players.length === 1 && lobby.players[0].name === 'SecTester');
    check('lobby state leaks no profile id',
      !JSON.stringify(lobby).includes(first.body.id));

    console.log('rate limiting');
    for (let i = 0; i < 400; i++) good.emit('input', { up: true, down: false, left: false, right: false });
    await new Promise((r) => setTimeout(r, 300));
    check('an input flood does not kill the socket', good.connected === true);
    const stillWorks = await emit(good, 'joinRoom', { code: created.code });
    check('the socket still answers after a flood', typeof stillWorks === 'object');

    console.log('debug route');
    const dbg = await fetch(`${URL}/debug/rooms`);
    check('/debug/rooms 404s without RTR_DEBUG=1', dbg.status === 404);

    console.log('leaderboard read path');
    const lb = await fetch(`${URL}/api/leaderboard`);
    const lbBody = await lb.json();
    check('/api/leaderboard responds 200', lb.status === 200);
    check('/api/leaderboard has the expected shape',
      Array.isArray(lbBody.standings) && typeof lbBody.records === 'object');
    check('/api/leaderboard leaks no profile id',
      !JSON.stringify(lbBody).includes(first.body.id));
  } catch (e) {
    console.error('threw:', e && e.message);
    check('no exception during the run', false);
  }

  sockets.forEach((s) => s.disconnect());
  const failed = checks.filter((c) => !c.cond);
  console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
  process.exit(failed.length ? 1 : 0);
})();
```

- [ ] **Step 3: Run it to verify it fails**

```bash
RTR_STORE_PATH=/tmp/rtr-sec.json PORT=4200 LAPS=1 node server.js &
sleep 1 && node test/security.js http://localhost:4200; kill %1
```

Expected: FAIL — `createRoom` still accepts a client name and the socket refusals do not exist yet.

- [ ] **Step 4: Add handshake auth and the profile gate**

In `server.js`, immediately after `const io = new Server(server);`, add:

```js
// Resolve identity once per connection. A nameless-but-valid profile is a
// normal state, not an attack: the client opens its socket on page load,
// before the player has typed anything.
io.use((socket, next) => {
  const ip = ipOf(socket.request);
  const open = socketsPerIp.get(ip) || 0;
  if (open >= MAX_SOCKETS_PER_IP) return next(new Error('Too many connections'));
  socketsPerIp.set(ip, open + 1);
  socket.data.ip = ip;

  const raw = parseCookies(socket.request.headers.cookie)[profiles.COOKIE];
  if (!raw) socket.data.authErr = 'No profile';
  else {
    const id = profiles.verify(raw);
    if (!id) socket.data.authErr = 'Invalid profile';
    else socket.data.pid = id;
  }
  next();
});

// Returns the profile, or answers the callback and returns null.
function requireProfile(socket, cb) {
  const reply = typeof cb === 'function' ? cb : () => {};
  if (socket.data.authErr) { reply({ ok: false, error: socket.data.authErr }); return null; }
  const p = profiles.get(socket.data.pid);
  if (!p) { reply({ ok: false, error: 'Invalid profile' }); return null; }
  if (!p.name) { reply({ ok: false, error: 'Claim a name first' }); return null; }
  return p;
}
```

- [ ] **Step 5: Stop trusting client names and apply the limits**

Replace the `createRoom` and `joinRoom` handlers (currently `server.js:527-547`):

```js
  socket.on('createRoom', (_payload, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!limJoin.allow(socket.id)) return reply({ ok: false, error: 'Slow down' });
    const prof = requireProfile(socket, reply);
    if (!prof) return;
    if (rooms.size >= MAX_ROOMS) return reply({ ok: false, error: 'Server is busy — too many rooms' });
    if (socket.data.roomCode) removePlayer(socket);
    // The name comes from the verified profile; any name in the payload is ignored.
    const room = createRoom(socket, prof.name);
    reply({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    if (!limJoin.allow(socket.id)) return reply({ ok: false, error: 'Slow down' });
    const prof = requireProfile(socket, reply);
    if (!prof) return;
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return reply({ ok: false, error: 'Room not found' });
    if (room.players.size >= MAX_PLAYERS) return reply({ ok: false, error: 'Room is full (8 max)' });
    if (room.status !== 'lobby' && room.status !== 'finished') {
      return reply({ ok: false, error: 'Race in progress — try again shortly' });
    }
    if (socket.data.roomCode) removePlayer(socket);
    addPlayer(room, socket, prof.name);
    reply({ ok: true, code: room.code });
    broadcastLobby(room);
  });
```

Add a limiter guard to each of the two hot handlers. These are one-line inserts — add the `if` as the new first statement and leave the rest of each handler exactly as it is (`input` is `server.js:594-603`, `useItem` is `server.js:619-625`):

```js
  socket.on('input', (input) => {
    if (!limInput.allow(socket.id)) return; // dropped, not disconnected
    const room = rooms.get(socket.data.roomCode);   // <- existing first line
    /* rest of the existing handler body stays exactly as it is */
  });

  socket.on('useItem', () => {
    if (!limItem.allow(socket.id)) return;
    const room = rooms.get(socket.data.roomCode);   // <- existing first line
    /* rest of the existing handler body stays exactly as it is */
  });
```

Dropping rather than disconnecting is deliberate: the tick reads whichever input value arrived last, so a flood was never a speed advantage — only a resource cost.

In `addPlayer`, record the profile id on the player (it must never be broadcast). Change the `room.players.set(socket.id, {` object to include, right after `id: socket.id,`:

```js
    pid: socket.data.pid || null,
```

Extend the `disconnect` handler to release bucket memory and the per-IP count:

```js
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason}`);
    limInput.forget(socket.id);
    limItem.forget(socket.id);
    limJoin.forget(socket.id);
    const ip = socket.data.ip;
    if (ip) {
      const n = (socketsPerIp.get(ip) || 1) - 1;
      if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
    }
    removePlayer(socket);
  });
```

- [ ] **Step 6: Record finished races**

Replace the results block inside `checkRaceEnd` (currently `server.js:235-249`). Sorting the player objects once — rather than sorting a projection — is what lets the leaderboard see each finisher's `pid` while the wire format keeps hiding it:

```js
    const ordered = racers.slice().sort((a, b) => {
      const aDone = a.finished && !a.retired;
      const bDone = b.finished && !b.retired;
      if (aDone && bDone) return (a.finishTime - room.raceStart) - (b.finishTime - room.raceStart);
      if (aDone) return -1;
      if (bDone) return 1;
      return b.lap - a.lap;
    });

    const results = ordered.map((p) => ({
      name: p.name,
      carId: p.carId,
      finished: p.finished && !p.retired,
      time: p.finished && !p.retired ? p.finishTime - room.raceStart : null,
      laps: p.lap,
    }));
    room.results = results;

    // Durable stats. Never trusts anything a client sent — every field here
    // comes from the simulation this process just ran.
    try {
      leaderboard.recordRace({
        mapId: room.mapId,
        laps: TOTAL_LAPS,
        entries: ordered.map((p, i) => ({
          pid: p.pid,
          name: p.name,
          pos: i + 1,
          timeMs: p.finished && !p.retired ? p.finishTime - room.raceStart : null,
          finished: p.finished,
          retired: p.retired,
        })),
      });
    } catch (e) {
      // A leaderboard write must never take the race down with it.
      console.error('[leaderboard] failed to record race:', e && e.message);
    }
```

- [ ] **Step 7: Run the security test to verify it passes**

```bash
rm -f /tmp/rtr-sec.json
RTR_STORE_PATH=/tmp/rtr-sec.json PORT=4200 LAPS=1 node server.js &
sleep 1 && node test/security.js http://localhost:4200; kill %1
```

Expected: PASS

- [ ] **Step 8: Confirm the debug route still works when asked for**

```bash
RTR_STORE_PATH=/tmp/rtr-dbg.json PORT=4201 RTR_DEBUG=1 node server.js &
sleep 1 && curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4201/debug/rooms; kill %1
```

Expected: `200`

- [ ] **Step 9: Commit**

```bash
git add server.js test/security.js
git commit -m "feat(server): server-owned identity, leaderboard recording, rate limits"
```

---

### Task 6: Update the existing bot harnesses

**Files:**
- Create: `test/helpers/profile.js`
- Modify: `test/bots.js`, `test/capacity.js`, `test/exit.js`

**Interfaces:**
- Consumes: the HTTP routes from Task 5.
- Produces: `makeProfile(url, name) -> Promise<string>` returning a `Cookie` header value. Used by all three harnesses.

- [ ] **Step 1: Write the helper**

Create `test/helpers/profile.js`:

```js
/**
 * Bootstraps a driver profile over HTTP and returns a Cookie header value for
 * socket.io-client's extraHeaders. Rooms now require a claimed name, so every
 * scripted client needs one.
 *
 * Always run harnesses with RTR_STORE_PATH pointed at a throwaway file so test
 * drivers never land on the real leaderboard.
 */
async function makeProfile(url, name) {
  const res = await fetch(`${url}/api/profile/me`);
  if (!res.ok) throw new Error(`profile bootstrap failed: HTTP ${res.status}`);
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('server did not set a profile cookie');

  const claim = await fetch(`${url}/api/profile/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
  if (!claim.ok) {
    const body = await claim.text();
    throw new Error(`claiming "${name}" failed: HTTP ${claim.status} ${body}`);
  }
  return cookie;
}

module.exports = { makeProfile };
```

- [ ] **Step 2: Update `test/bots.js`**

Add the require after the existing `RTMaps` require:

```js
const { makeProfile } = require('./helpers/profile.js');
```

Change `makeBot` to take a cookie and pass it to `io`. Replace the signature and the `io(...)` line:

```js
function makeBot(name, isHost, cookie) {
  const socket = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
```

Replace the spawn of the remaining bots inside the `createRoom` callback (the `for` loop) with a profile-aware version:

```js
        // spawn the rest once the room exists
        (async () => {
          for (let i = 1; i < NUM_BOTS; i++) {
            const c = await makeProfile(URL, `Bot${i}`);
            makeBot(`Bot${i}`, false, c);
          }
        })().catch((e) => { console.error(e.message); process.exit(1); });
```

Replace the final line `makeBot('HostBot', true);` with:

```js
makeProfile(URL, 'HostBot')
  .then((cookie) => makeBot('HostBot', true, cookie))
  .catch((e) => { console.error(e.message); process.exit(1); });
```

Also drop the now-ignored `name` from both emits: `socket.emit('createRoom', {}, ...)` and `socket.emit('joinRoom', { code: roomCode }, ...)`.

- [ ] **Step 3: Update `test/capacity.js`**

Add the require, make `connect` take a cookie, and **rename the players** — `P2` is 2 characters and fails the 3-character minimum:

```js
const { io } = require('socket.io-client');
const { makeProfile } = require('./helpers/profile.js');
const URL = process.argv[2] || 'http://localhost:4100';

const sockets = [];
function connect(cookie) {
  return new Promise((res) => {
    const s = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
    sockets.push(s);
    s.on('connect', () => res(s));
  });
}

(async () => {
  const host = await connect(await makeProfile(URL, 'HostPlayer'));
  const code = await new Promise((res) => host.emit('createRoom', {}, (r) => res(r.code)));
  console.log('room', code);

  let joined = 1;
  for (let i = 2; i <= 8; i++) {
    const s = await connect(await makeProfile(URL, `Player${i}`));
    const ok = await new Promise((res) => s.emit('joinRoom', { code }, (r) => res(r.ok)));
    if (ok) joined++;
  }
  console.log(`players joined: ${joined} (expect 8)`);

  const ninth = await connect(await makeProfile(URL, 'Player9'));
  const r9 = await new Promise((res) => ninth.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`9th join rejected: ${!r9.ok} (${r9.error || 'no error'})`);

  sockets.slice(1, 8).forEach((s) => s.emit('toggleReady'));
  await new Promise((r) => setTimeout(r, 300));
  host.emit('startRace');
  await new Promise((r) => setTimeout(r, 500));
  const rMid = await new Promise((res) => ninth.emit('joinRoom', { code }, (r) => res(r)));
  console.log(`mid-race join rejected: ${!rMid.ok} (${rMid.error || 'no error'})`);

  const pass = joined === 8 && !r9.ok && !rMid.ok;
  console.log(pass ? 'PASS' : 'FAIL');
  sockets.forEach((s) => s.disconnect());
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 4: Update `test/exit.js`**

Both clients need a profile, and the sockets can only be built after the async bootstrap — so the handlers move inside a `wire()` function. Replace the whole file:

```js
/** Exit-race test: one of two racers exits mid-race; the other finishes.
 * Expect: finisher ranked 1st with a time, quitter listed as DNF.
 * Usage: node test/exit.js [url]  (run server with LAPS=1)
 */
const { io } = require('socket.io-client');
const RTMaps = require('../public/maps.js');
const { makeProfile } = require('./helpers/profile.js');

const URL = process.argv[2] || 'http://localhost:4100';
const MAP = RTMaps.MAPS[0];

let host, quitter;
let code = null;
let exited = false;
let sawQuitterRetired = false;

function wire() {
  host.on('connect', () => {
    host.emit('createRoom', {}, (r) => {
      if (!r.ok) { console.error('createRoom failed', r); process.exit(1); }
      code = r.code;
      quitter.emit('joinRoom', { code }, (j) => {
        if (!j.ok) { console.error('joinRoom failed', j); process.exit(1); }
        quitter.emit('toggleReady');
        setTimeout(() => host.emit('startRace'), 200);
      });
    });
  });

  host.on('state', (state) => {
    if (state.status !== 'racing') return;
    const me = state.players.find((p) => p.id === host.id);
    const q = state.players.find((p) => p.id === quitter.id);
    if (q && q.retired) sawQuitterRetired = true;

    if (!exited && state.now - state.raceStart > 2000) {
      exited = true;
      quitter.emit('exitRace');
      console.log('quitter exited at 2s');
    }

    if (me && !me.finished) {
      const near = RTMaps.closest(MAP.path, me.x, me.y);
      const tgt = RTMaps.pointAt(MAP.path, near.u + 0.035);
      const desired = Math.atan2(tgt.y - me.y, tgt.x - me.x);
      let da = desired - me.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      host.emit('input', { up: true, down: false, left: da < -0.06, right: da > 0.06 });
    }
  });

  host.on('raceOver', ({ results }) => {
    console.log(JSON.stringify(results, null, 1));
    const pass =
      sawQuitterRetired &&
      results[0].name === 'Finisher' && results[0].finished && results[0].time > 0 &&
      results[1].name === 'Quitter' && !results[1].finished;
    console.log(pass ? 'PASS' : 'FAIL');
    host.disconnect(); quitter.disconnect();
    process.exit(pass ? 0 : 1);
  });
}

(async () => {
  const hostCookie = await makeProfile(URL, 'Finisher');
  const quitCookie = await makeProfile(URL, 'Quitter');
  host = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: hostCookie } });
  quitter = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: quitCookie } });
  wire();
})().catch((e) => { console.error(e.message); process.exit(1); });

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
```

- [ ] **Step 5: Run all three harnesses against a throwaway store**

```bash
rm -f /tmp/rtr-harness.json
RTR_STORE_PATH=/tmp/rtr-harness.json PORT=4100 LAPS=1 node server.js &
sleep 1
node test/bots.js http://localhost:4100 4 0
node test/capacity.js http://localhost:4100
node test/exit.js http://localhost:4100
kill %1
```

Expected: three PASS lines

- [ ] **Step 6: Verify the real store was untouched**

Run: `node -e "const s=require('./store.js').createStore(); console.log('profiles:', Object.keys(s.data.profiles).length)"`
Expected: `profiles: 0` — no test driver leaked into the real store

- [ ] **Step 7: Commit**

```bash
git add test/helpers/profile.js test/bots.js test/capacity.js test/exit.js
git commit -m "test: bootstrap profiles in the bot harnesses"
```

---

### Task 7: Client — name gate, lobby controls, leaderboard screen

**Files:**
- Modify: `public/index.html`, `public/game.js`, `public/style.css`

**Interfaces:**
- Consumes: the HTTP routes and socket refusals from Task 5.
- Produces: user-visible UI. Nothing else depends on it.

- [ ] **Step 1: Restructure the home screen and add the containers**

In `public/index.html`, replace the name input and the `.howto` block (currently lines 26-49) with a gated version plus a shared controls container:

```html
      <label for="name-input">Driver name</label>
      <div class="name-row">
        <input id="name-input" maxlength="16" placeholder="e.g. Basis Bandit" autocomplete="off" />
        <button id="btn-claim" class="btn">Save</button>
      </div>
      <p id="name-status" class="hint"></p>

      <button id="btn-create" class="btn primary" disabled>Create Room</button>

      <div class="divider"><span>or join a room</span></div>

      <div class="join-row">
        <input id="code-input" maxlength="4" placeholder="CODE" autocomplete="off" />
        <button id="btn-join" class="btn" disabled>Join</button>
      </div>
      <p id="home-error" class="error"></p>

      <button id="btn-leaderboard" class="btn subtle">&#127942; Leaderboard</button>

      <div id="controls-home" class="howto"></div>
```

In the lobby panel, add a collapsible controls block just above `<div class="lobby-actions">`:

```html
      <details class="howto-details" open>
        <summary>How to play</summary>
        <div id="controls-lobby" class="howto"></div>
      </details>
```

Add a leaderboard screen after the results screen:

```html
  <!-- LEADERBOARD SCREEN -->
  <div id="screen-leaderboard" class="screen">
    <div class="panel wide">
      <h2>&#127942; Leaderboard</h2>
      <h3>Standings <span class="soft-hint">races with 2+ drivers</span></h3>
      <table id="standings-table">
        <thead><tr><th>#</th><th>Driver</th><th>Races</th><th>Wins</th><th>Podiums</th><th>Best</th></tr></thead>
        <tbody></tbody>
      </table>
      <p id="standings-empty" class="hint"></p>

      <h3>Track records</h3>
      <div id="records-wrap"></div>

      <div class="lobby-actions">
        <button id="btn-lb-back" class="btn primary">Back</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Register the new screen**

`public/game.js:35-37` holds the screen registry and `game.js:38` defines `showScreen(name)` — note the name, it is **not** `show()`. Add the leaderboard to the registry:

```js
  const screens = {
    home: $('screen-home'), lobby: $('screen-lobby'),
    game: $('screen-game'), results: $('screen-results'),
    leaderboard: $('screen-leaderboard'),
  };
```

- [ ] **Step 3: Bootstrap the profile before connecting the socket**

`public/game.js:3` currently does `const socket = io();` at module scope. It must not connect until the cookie exists, or the handshake resolves no profile and every join is refused.

Replace that line with `let socket = null;` and add near the top:

```js
  let socket = null;
  let profile = { id: null, name: null };

  async function bootstrap() {
    const res = await fetch('/api/profile/me');
    profile = await res.json();
    // Only now is the cookie guaranteed to exist, so the handshake can resolve it.
    socket = io();
    wireSocket();
    renderNameGate();
  }

  function renderNameGate() {
    const claimed = !!profile.name;
    $('name-input').value = profile.name || '';
    $('btn-create').disabled = !claimed;
    $('btn-join').disabled = !claimed;
    $('name-status').textContent = claimed
      ? `Racing as ${profile.name}`
      : 'Pick a name to start racing';
    $('name-status').className = claimed ? 'hint ok' : 'hint';
  }

  async function claimName() {
    const name = $('name-input').value.trim();
    $('name-status').textContent = 'Saving…';
    try {
      const res = await fetch('/api/profile/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) {
        $('name-status').textContent = body.error || 'Could not save that name';
        $('name-status').className = 'hint error';
        return;
      }
      profile.name = body.name;
      renderNameGate();
    } catch {
      $('name-status').textContent = 'Network error — try again';
      $('name-status').className = 'hint error';
    }
  }
```

Wire the button and drop the old localStorage name handling (currently `game.js:207-212`) — the server is now the single source of truth:

```js
  $('btn-claim').onclick = claimName;
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') claimName(); });
```

Change both room emits to stop sending a name, and handle the profile refusals:

```js
  function handleRoomError(res) {
    if (res.error === 'Claim a name first' || res.error === 'No profile' || res.error === 'Invalid profile') {
      profile.name = null;
      showScreen('home');
      renderNameGate();
      $('home-error').textContent = 'Please save a driver name first.';
      return true;
    }
    return false;
  }

  $('btn-create').onclick = () => {
    socket.emit('createRoom', {}, (res) => {
      if (!res.ok) { if (!handleRoomError(res)) $('home-error').textContent = res.error; return; }
      showScreen('lobby');
    });
  };
```

Apply the same `{ code }`-only payload and `handleRoomError` treatment to the join handler.

- [ ] **Step 4: Render the controls block into both screens**

Add to `public/game.js` — one source, injected twice, so home and lobby cannot drift:

```js
  // Rendered into both the home screen and the lobby; keep it one template so
  // the two copies cannot drift apart.
  const CONTROLS_HTML = `
    <h3>Controls</h3>
    <table class="controls-table">
      <tr><td>Accelerate / brake</td><td><kbd>W</kbd><kbd>S</kbd> or <kbd>&uarr;</kbd><kbd>&darr;</kbd></td></tr>
      <tr><td>Steer</td><td><kbd>A</kbd><kbd>D</kbd> or <kbd>&larr;</kbd><kbd>&rarr;</kbd></td></tr>
      <tr><td>Use powerup</td><td><kbd>Space</kbd></td></tr>
      <tr><td>Exit race</td><td><kbd>Esc</kbd></td></tr>
    </table>
    <h3>Powerups</h3>
    <ul>
      <li><b class="c-boost">&#10095;&#10095;&#10095; Chevron Boost</b> — hit warp speed for a couple of seconds</li>
      <li><b class="c-cab">&#128203; CAB Meeting</b> — drop it behind you; whoever hits it gets stuck in review (spin out)</li>
      <li><b class="c-lock">&#128274; Transport Lock</b> — freeze the car ahead of you</li>
      <li><b class="c-shield">&#9889; Emergency Change</b> — shield that skips the red tape (5s immunity)</li>
      <li><b class="c-oops">&#128165; OOPS!</b> — everyone ahead of you spins out</li>
    </ul>
    <p class="controls">Races are <b>3 laps</b>. Stay on the asphalt — grass is slow.
       Drive through the <b>?</b> boxes to grab a powerup.</p>`;

  function renderControls() {
    $('controls-home').innerHTML = CONTROLS_HTML;
    $('controls-lobby').innerHTML = CONTROLS_HTML;
  }
```

Call `renderControls()` from `bootstrap()`.

- [ ] **Step 5: Add the leaderboard screen**

```js
  function fmtTime(ms) {
    return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—';
  }

  async function showLeaderboard() {
    showScreen('leaderboard');
    const tbody = document.querySelector('#standings-table tbody');
    tbody.innerHTML = '';
    $('standings-empty').textContent = 'Loading…';
    $('records-wrap').innerHTML = '';
    try {
      const data = await (await fetch('/api/leaderboard')).json();

      data.standings.forEach((s, i) => {
        const best = Object.values(s.bestByMap || {});
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.races}</td>` +
          `<td>${s.wins}</td><td>${s.podiums}</td>` +
          `<td>${best.length ? fmtTime(Math.min(...best)) : '—'}</td>`;
        tbody.appendChild(tr);
      });
      $('standings-empty').textContent = data.standings.length
        ? '' : 'No races yet — a race needs 2+ drivers to count.';

      // One block per track that has any record, in map order.
      const wrap = $('records-wrap');
      const ids = Object.keys(data.records).map(Number).sort((a, b) => a - b);
      if (!ids.length) wrap.innerHTML = '<p class="hint">No track records yet.</p>';
      for (const id of ids) {
        const map = RTMaps.MAPS.find((m) => m.id === id);
        const rows = data.records[String(id)]
          .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${fmtTime(r.timeMs)}</td></tr>`)
          .join('');
        const div = document.createElement('div');
        div.className = 'record-block';
        div.innerHTML = `<h4>${esc(map ? map.name : `Map ${id}`)}</h4>` +
          `<table class="record-table"><tbody>${rows}</tbody></table>`;
        wrap.appendChild(div);
      }
    } catch {
      $('standings-empty').textContent = 'Could not load the leaderboard.';
    }
  }

  // Names are server-validated to [A-Za-z0-9 _-], but escape anyway — the
  // leaderboard is the one place one player's text reaches another's DOM.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  $('btn-leaderboard').onclick = showLeaderboard;
  $('btn-lb-back').onclick = () => show(socket && socket.connected && lobby ? 'lobby' : 'home');
```

Ensure `show()` recognises the new `leaderboard` screen id, and that `bootstrap()` runs on load in place of the previous immediate socket creation.

- [ ] **Step 6: Style the new pieces**

Append to `public/style.css`:

```css
.name-row { display: flex; gap: 8px; }
.name-row input { flex: 1; }
.hint.ok { color: #4ade80; }
.hint.error { color: #f87171; }
.btn.subtle { background: transparent; border: 1px solid rgba(255,255,255,.25); }

.howto-details { margin: 14px 0; border-top: 1px solid rgba(255,255,255,.12); padding-top: 10px; }
.howto-details summary { cursor: pointer; font-weight: 600; }
.controls-table { width: 100%; margin: 6px 0 12px; border-collapse: collapse; }
.controls-table td { padding: 3px 0; vertical-align: middle; }
.controls-table td:last-child { text-align: right; }

.record-block { margin-bottom: 14px; }
.record-block h4 { margin: 6px 0 4px; }
.record-table { width: 100%; border-collapse: collapse; }
.record-table td { padding: 2px 0; }
.record-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
#standings-table td:nth-child(n+3) { text-align: right; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 7: Verify in a browser**

```bash
rm -f /tmp/rtr-ui.json
RTR_STORE_PATH=/tmp/rtr-ui.json PORT=3006 node server.js
```

Open `http://localhost:3006` and confirm:
- Create Room and Join are disabled until a name is saved
- a 2-character name is refused with a readable message
- a second browser profile claiming the same name is refused as taken
- the controls block appears on both home and lobby
- the leaderboard page loads and shows the empty-state copy

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/game.js public/style.css
git commit -m "feat(client): required driver name, lobby controls, leaderboard screen"
```

---

### Task 8: Persist on mktools and document

**Files:**
- Modify: `docker-compose.yml`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed, persistent leaderboard on `http://mktools:3005`.

- [ ] **Step 1: Add the named volume**

Replace `docker-compose.yml`:

```yaml
services:
  racer:
    build: .
    container_name: rev-trac-racer
    ports:
      # 3005 because the marketing dashboard (3000) and campaign dashboard
      # (3001) already hold their ports on this host.
      - "3005:3005"
    environment:
      PORT: "3005"
    volumes:
      # Profiles and the leaderboard. A named volume rather than a bind mount:
      # the racer needs no credentials and nothing hand-edits this file, and it
      # avoids both the SELinux ':z' relabel and the setfacl uid-100 dance the
      # two dashboards need on the Rocky host.
      - rtr-data:/app/data
    restart: unless-stopped

volumes:
  rtr-data:
```

- [ ] **Step 2: Verify persistence survives a rebuild locally**

```bash
docker compose up -d --build
sleep 3
curl -s -c /tmp/rtr-c.txt http://localhost:3005/api/profile/me > /dev/null
curl -s -b /tmp/rtr-c.txt -X POST -H 'content-type: application/json' \
  -d '{"name":"VolumeCheck"}' http://localhost:3005/api/profile/name
docker compose up -d --build --force-recreate
sleep 3
curl -s -b /tmp/rtr-c.txt http://localhost:3005/api/profile/me
```

Expected: the final response still reports `"name":"VolumeCheck"`, proving the volume outlived a forced recreate. Then `docker compose down` to clean up.

- [ ] **Step 3: Update the README**

Add a section after **Rooms**:

````markdown
## Driver profiles

A driver name is required, and it belongs to you. On your first visit the server
sets a signed `rtr_pid` cookie and your name is claimed by that profile, so
nobody else can race under it — the server never accepts a name from the client
when you create or join a room. Renaming keeps your stats, because they are held
against the profile rather than the name.

Clearing your cookies orphans the name. Release it with:

```bash
docker exec rev-trac-racer node scripts/admin.js release "Old Name"
docker exec rev-trac-racer node scripts/admin.js list
```

## Leaderboard

Two boards, at **Leaderboard** on the home screen:

- **Track records** — the fastest race time per track. Solo runs count; a fast
  time is fast whether or not anyone else was on track. Records are only written
  for standard 3-lap races, so a `LAPS=1` test run can never set one.
- **Standings** — races, wins and podiums, counted only for races with 2 or more
  distinct profiles, so an empty room earns nothing.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port (3005 on mktools) |
| `LAPS` | 3 | Laps per race; any value other than 3 disables record-keeping |
| `RTR_STORE_PATH` | `data/store.json` | Where profiles and the leaderboard live — point it at a temp file when running tests |
| `RTR_DEBUG` | unset | `1` exposes `/debug/rooms`, which leaks room codes and names |
| `RTR_SECRET` | generated | Cookie signing key; generated on first boot and persisted in the store |
````

Update the **Tests** section to reflect the profile requirement:

````markdown
## Tests

Server-free unit tests:

```bash
npm test        # store, profiles, ratelimit, leaderboard, map validation
```

The socket harnesses need a running server. Always point `RTR_STORE_PATH` at a
throwaway file so test drivers never reach the real leaderboard:

```bash
RTR_STORE_PATH=/tmp/rtr-test.json PORT=4100 LAPS=1 node server.js
```

```bash
node test/bots.js http://localhost:4100 8 0   # full race with 8 bot drivers
node test/capacity.js http://localhost:4100   # 8-player cap, mid-race join
node test/exit.js http://localhost:4100       # mid-race exit
node test/security.js http://localhost:4100   # identity and hardening
```
````

- [ ] **Step 4: Run the full suite one final time**

```bash
npm test
rm -f /tmp/rtr-final.json
RTR_STORE_PATH=/tmp/rtr-final.json PORT=4100 LAPS=1 node server.js &
sleep 1
node test/bots.js http://localhost:4100 4 0
node test/capacity.js http://localhost:4100
node test/exit.js http://localhost:4100
node test/security.js http://localhost:4100
kill %1
```

Expected: every one reports PASS

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml README.md
git commit -m "feat(deploy): persist profiles and leaderboard in a named volume"
```

- [ ] **Step 6: Deploy to mktools and verify**

```bash
rsync -az --delete --exclude='.git/' --exclude='node_modules/' --exclude='data/' \
  ./ mfreeman@mktools:~/rev-trac-racer/
ssh mfreeman@mktools "cd ~/rev-trac-racer && docker compose up -d --build"
sleep 5
curl -s -o /dev/null -w 'home        HTTP %{http_code}\n' http://mktools:3005/
curl -s -o /dev/null -w 'leaderboard HTTP %{http_code}\n' http://mktools:3005/api/leaderboard
curl -s -o /dev/null -w 'debug(404)  HTTP %{http_code}\n' http://mktools:3005/debug/rooms
curl -si http://mktools:3005/api/profile/me | grep -i '^set-cookie'
```

Expected: `200`, `200`, `404`, and a `set-cookie: rtr_pid=...; HttpOnly; SameSite=Lax` line with **no** `Secure` flag.

- [ ] **Step 7: Prove a real race lands on the leaderboard**

```bash
node test/bots.js http://mktools:3005 4 0
curl -s http://mktools:3005/api/leaderboard | python3 -m json.tool
```

Expected: the race PASSes, `standings` holds the four bot drivers with one win
between them, and `records["0"]` holds their times. Then clear the bots out so
the real board starts empty:

```bash
for n in HostBot Bot1 Bot2 Bot3; do
  ssh mfreeman@mktools "docker exec rev-trac-racer node scripts/admin.js release $n"
done
```

Note this only releases the names; the bot profiles keep their stats. If you
would rather start completely clean, remove the volume instead:

```bash
ssh mfreeman@mktools "cd ~/rev-trac-racer && docker compose down && docker volume rm rev-trac-racer_rtr-data && docker compose up -d --build"
```

- [ ] **Step 8: Commit any deploy-time fixes**

If steps 6-7 surfaced changes, commit them:

```bash
git add -A && git commit -m "fix(deploy): corrections found verifying on mktools"
```

---

## Verification checklist

Run before calling the work done:

- [ ] `npm test` passes
- [ ] all four socket harnesses pass against a throwaway store
- [ ] the real `data/store.json` has no test drivers in it
- [ ] `http://mktools:3005` serves, and `/debug/rooms` 404s
- [ ] the profile cookie is `HttpOnly`, `SameSite=Lax`, and **not** `Secure`
- [ ] a redeploy (`up -d --build --force-recreate`) preserves the leaderboard
- [ ] Create/Join stay disabled until a name is saved
- [ ] a duplicate name is refused as taken
- [ ] controls appear on both the home screen and in the lobby
