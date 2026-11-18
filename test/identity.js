'use strict';
/* Unit tests for the identity and rate-limit modules. No server, no sleeping:
 * the limiter takes an injected clock and the store uses throwaway files.
 * Usage: node test/identity.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLimiter } = require('../lib/ratelimit.js');
const { createStore } = require('../lib/store.js');
const { createProfiles, parseCookies } = require('../lib/profiles.js');
const { Records } = require('../lib/records.js');

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? ' ok ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-identity-'));
const tmp = (name) => path.join(dir, name);

// ---- rate limiter ----------------------------------------------------------
{
  const lim = createLimiter({ capacity: 3, refillPerSec: 1 });
  const t = 1_000_000;
  check('a fresh key gets its full burst', [1, 2, 3].every(() => lim.allow('a', t)));
  check('then it is refused', lim.allow('a', t) === false);
  check('other keys are unaffected', lim.allow('b', t) === true);
  check('one second buys one more', lim.allow('a', t + 1000) === true && lim.allow('a', t + 1000) === false);
  check('refill never exceeds capacity', (() => {
    let n = 0;
    while (lim.allow('a', t + 3_600_000)) n++;
    return n === 3;
  })());

  // A clock that jumps backwards (NTP) must not mint tokens on the way forward.
  const rew = createLimiter({ capacity: 1, refillPerSec: 1 });
  rew.allow('k', t);
  rew.allow('k', t - 60_000);
  check('a rewound clock does not inflate the bucket', rew.allow('k', t + 10) === false);

  lim.forget('b');
  check('forget() drops a key', lim.size() === 1);
  lim.sweep(1000, t + 10 * 3_600_000);
  check('sweep() drops idle keys', lim.size() === 0);
}

// ---- store -----------------------------------------------------------------
{
  const file = tmp('store.json');
  const a = createStore(file);
  a.data.profiles.x = { name: 'X' };
  a.save();
  check('save() writes the file and leaves no temp file', fs.existsSync(file) && !fs.existsSync(file + '.tmp'));
  const b = createStore(file);
  check('the secret survives a restart', b.data.secret === a.data.secret && b.data.secret.length >= 32);
  check('profiles survive a restart', b.data.profiles.x && b.data.profiles.x.name === 'X');

  const bad = tmp('corrupt.json');
  fs.writeFileSync(bad, '{ not json');
  const origError = console.error;
  console.error = () => {};
  const c = createStore(bad);
  console.error = origError;
  check('a corrupt file does not stop boot', c.data && typeof c.data.profiles === 'object');
  check('the corrupt file is kept aside', fs.readdirSync(dir).some((f) => f.startsWith('corrupt.json.corrupt-')));

  const partial = tmp('partial.json');
  fs.writeFileSync(partial, JSON.stringify({ secret: 'short' }));
  const d = createStore(partial);
  check('missing or weak fields are backfilled', d.data.secret.length >= 32 && typeof d.data.profiles === 'object');
}

// ---- profiles --------------------------------------------------------------
{
  const store = createStore(tmp('profiles.json'));
  const profiles = createProfiles(store, { reserved: ['Legacy Larry'] });

  const a = profiles.mint();
  check('a minted token verifies to its id', profiles.verify(a.token) === a.id);
  check('a new profile has no name', profiles.get(a.id).name === null);
  const [id, sig] = [a.token.slice(0, a.token.lastIndexOf('.')), a.token.slice(a.token.lastIndexOf('.') + 1)];
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  check('a tampered signature is rejected', profiles.verify(`${id}.${flipped}`) === null);
  check('a signature for another id is rejected', profiles.verify(`${profiles.mint().id}.${sig}`) === null);
  check('garbage tokens are rejected', [undefined, null, 42, '', 'nodot', '.sig', 'id.'].every((t) => profiles.verify(t) === null));
  // same UTF-16 length as a real signature, different byte length: must not throw
  let threw = false, multi = 'x';
  try { multi = profiles.verify(`${id}.${'é'.repeat(sig.length)}`); } catch (e) { threw = true; }
  check('a multi-byte signature is rejected without throwing', !threw && multi === null);

  check('__proto__ is not a profile', profiles.get('__proto__') === null && profiles.get('constructor') === null);
  check('claiming on a non-profile fails cleanly', profiles.claim('__proto__', 'Sneaky').ok === false);
  check('Object.prototype was not polluted', ({}).name === undefined && ({}).nameLower === undefined);

  check('too short is rejected', profiles.claim(a.id, 'ab').code === 400);
  check('too long is rejected', profiles.claim(a.id, 'x'.repeat(17)).code === 400);
  check('punctuation and markup are rejected', profiles.claim(a.id, 'Bad!').code === 400 && profiles.claim(a.id, '<b>hi</b>').code === 400);
  check('a valid name is claimed (trimmed)', profiles.claim(a.id, '  Michael  ').name === 'Michael');
  check('claiming again with your own name is fine', profiles.claim(a.id, 'michael').ok === true);

  const b = profiles.mint();
  check('a taken name is refused case-insensitively', profiles.claim(b.id, 'MICHAEL').code === 409);
  check('an AI driver name is reserved', profiles.claim(b.id, 'legacy larry').code === 409);
  check('renaming frees the old name', profiles.claim(a.id, 'Mike').ok && profiles.claim(b.id, 'Michael').ok);

  const reloaded = createProfiles(createStore(tmp('profiles.json')));
  check('tokens still verify after a restart', reloaded.verify(a.token) === a.id);
  check('names survive a restart', reloaded.get(a.id).name === 'Mike');

  const rel = reloaded.release('mike');
  check('release() frees a name but keeps the profile', rel.ok && reloaded.get(a.id) && reloaded.get(a.id).name === null);

  check('parseCookies reads a normal header', parseCookies('a=1; rtr_pid=abc.def; b=2').rtr_pid === 'abc.def');
  check('parseCookies survives junk', typeof parseCookies('%E0%A4%A; =x; novalue') === 'object' && typeof parseCookies(undefined) === 'object');
}

// ---- hall of fame is keyed by profile, not by name ---------------------------
{
  const rec = new Records(tmp('records.json'));
  const race = { mapId: 0, laps: 3, mode: 'race' };
  rec.submit(race, [
    { pid: 'p1', name: 'Alice', carId: 1, bot: false, pos: 1, finished: true, time: 30000, bestLap: 9000, points: 16 },
    { pid: null, name: 'Legacy Larry', carId: 2, bot: true, pos: 2, finished: true, time: 31000, bestLap: 9500, points: 12 },
    { name: 'NoProfile', carId: 3, bot: false, pos: 3, finished: true, time: 32000, bestLap: 8000, points: 10 },
  ]);
  let s = rec.summary();
  check('bots and profile-less rows are left out', s.drivers.length === 1 && s.drivers[0].name === 'Alice');
  check('the lap record belongs to the profiled driver', s.tracks[0].lap.name === 'Alice' && s.tracks[0].lap.time === 9000);

  // Alice renames; someone else takes "Alice" and races.
  rec.submit(race, [{ pid: 'p2', name: 'Alice', carId: 4, bot: false, pos: 1, finished: true, time: 40000, bestLap: 9900, points: 15 }]);
  const current = { p1: 'Alicia', p2: 'Alice' };
  s = rec.summary((pid) => current[pid] || null);
  const alicia = s.drivers.find((d) => d.name === 'Alicia');
  const alice = s.drivers.find((d) => d.name === 'Alice');
  check('a rename keeps its history', !!alicia && alicia.wins === 1 && alicia.points === 16);
  check('taking a freed name does not inherit its wins', !!alice && alice.races === 1 && alice.points === 15);
  check('records show the holder\'s current name', s.tracks[0].lap.name === 'Alicia');
  check('profile ids are never exposed', !JSON.stringify(s).includes('p1') && !JSON.stringify(s).includes('pid'));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL IDENTITY TESTS PASSED');
process.exit(failures ? 1 : 0);
