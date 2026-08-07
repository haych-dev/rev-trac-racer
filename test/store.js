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

// verify() must never throw, even on a signature whose UTF-16 .length matches
// the real one but whose byte length does not (regression for a real bug: an
// astral-character signature has half as many UTF-16 code units as bytes).
function verifiesToNullWithoutThrowing(token) {
  try {
    return ps.verify(token) === null;
  } catch {
    return false;
  }
}

const astralSig = '\u{1F600}'.repeat(16); // 16 astral chars: .length 32, byte length 64
check('astral-length signature returns null instead of throwing',
  verifiesToNullWithoutThrowing(`${id}.${astralSig}`));
check('empty signature returns null', verifiesToNullWithoutThrowing(`${id}.`));
check('leading-dot token returns null', verifiesToNullWithoutThrowing('.abc'));

const astralCookieHeader = `${ps.COOKIE}=${id}.${encodeURIComponent(astralSig)}`;
const astralCookieToken = parseCookies(astralCookieHeader)[ps.COOKIE];
check('percent-encoded astral cookie round-trips through parseCookies',
  astralCookieToken === `${id}.${astralSig}`);
check('a percent-encoded astral cookie verifies to null instead of throwing',
  verifiesToNullWithoutThrowing(astralCookieToken));

// prototype-pollution guard: '__proto__' must never be treated as a real id
check('get(\'__proto__\') is not Object.prototype', ps.get('__proto__') === null);
const protoAttempt = ps.claim('__proto__', 'Hacker');
check('claim(\'__proto__\', ...) fails', protoAttempt.ok === false);
check('claim(\'__proto__\', ...) did not pollute Object.prototype',
  ({}).name === undefined && ({}).nameLower === undefined);

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
