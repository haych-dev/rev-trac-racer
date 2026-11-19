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

// ---- hall of fame: farming guards ------------------------------------------
{
  const { minPlausibleMs } = require('../lib/records.js');
  const RTMaps = require('../public/maps.js');
  const { P } = require('../lib/race.js');
  const RACE = { mapId: 0, laps: 3, mode: 'race' };
  const GOOD_LAP = 9000, GOOD_RACE = 30000;
  let n = 0;
  const fresh = () => new Records(tmp(`records-${n++}.json`));
  // A human row as the server builds it. Defaults: finished, drove, plausible times.
  const row = (pid, pos, extra = {}) => ({
    pid, name: 'Driver ' + pid, carId: 1, bot: false, pos, finished: true, out: null,
    time: GOOD_RACE + pos * 1000, bestLap: GOOD_LAP + pos * 100, points: [15, 12, 10, 8][pos - 1] || 0,
    progressed: true, ...extra,
  });
  const bot = (pos) => ({ pid: null, name: 'Legacy Larry', carId: 2, bot: true, pos, finished: true, out: null, time: 31000, bestLap: 8000, points: 12, progressed: true });
  const driver = (rec, pid) => rec.data.drivers[pid] || { races: 0, wins: 0, podiums: 0, points: 0 };

  // -- solo against the AI
  let rec = fresh();
  let res = rec.submit(RACE, [row('a', 1), bot(2), bot(3)]);
  check('a solo race against AI drivers does not count for standings', res.standings === false);
  check('…and earns no race, win or points', driver(rec, 'a').races === 0 && driver(rec, 'a').wins === 0 && rec.summary().drivers.length === 0);
  check('…but still sets track records', res.records.some((r) => r.type === 'lap') && res.records.some((r) => r.type === 'race'));
  check('a bot never holds a record, however fast', rec.summary().tracks[0].lap.name === 'Driver a');

  // -- two real drivers
  rec = fresh();
  res = rec.submit(RACE, [row('a', 1), row('b', 2), bot(3)]);
  check('two distinct profiles that drove count for standings', res.standings === true);
  check('the winner gets a race, a win, a podium and points', JSON.stringify(driver(rec, 'a')) === JSON.stringify({ name: 'Driver a', races: 1, wins: 1, podiums: 1, points: 15 }));
  check('the runner-up gets a race and a podium but no win', driver(rec, 'b').races === 1 && driver(rec, 'b').wins === 0 && driver(rec, 'b').podiums === 1);

  // -- podium boundary
  rec = fresh();
  rec.submit(RACE, [row('a', 1), row('b', 2), row('c', 3), row('d', 4)]);
  check('3rd place gets a podium, 4th does not', driver(rec, 'c').podiums === 1 && driver(rec, 'd').podiums === 0 && driver(rec, 'd').races === 1);

  // -- a parked second profile
  rec = fresh();
  res = rec.submit(RACE, [row('farmer', 1), row('puppet', 2, { progressed: false, finished: false, time: null, bestLap: null, points: 12 })]);
  check('a profile that never moved does not open the standings gate', res.standings === false);
  check('…so neither the driver nor the puppet earns anything', driver(rec, 'farmer').races === 0 && driver(rec, 'puppet').races === 0);
  check('…while the genuine run still sets a record', res.records.some((r) => r.type === 'lap'));

  // -- one profile in several seats
  rec = fresh();
  res = rec.submit(RACE, [row('farmer', 1), row('farmer', 2), row('farmer', 3)]);
  check('many seats held by one profile do not open standings', res.standings === false && driver(rec, 'farmer').races === 0);
  rec = fresh();
  res = rec.submit(RACE, [row('farmer', 2), row('farmer', 1), row('rival', 3), row('farmer', 4)]);
  check('with a genuine rival, three seats earn one race, one win, one podium', driver(rec, 'farmer').races === 1 && driver(rec, 'farmer').wins === 1 && driver(rec, 'farmer').podiums === 1);
  check('…and points for the best seat only', driver(rec, 'farmer').points === 15);
  check('the rival is unaffected', driver(rec, 'rival').races === 1 && driver(rec, 'rival').wins === 0);

  // -- retiring
  rec = fresh();
  res = rec.submit(RACE, [row('a', 1), row('q', 2, { out: 'retired', finished: false, time: null, points: 0, bestLap: 8500 })]);
  check('retiring after driving still opens standings', res.standings === true);
  check('the retiree gets a race but no podium and no points', driver(rec, 'q').races === 1 && driver(rec, 'q').podiums === 0 && driver(rec, 'q').points === 0);
  rec = fresh();
  rec.submit(RACE, [row('q', 1, { out: 'retired', finished: false, time: null, points: 0 }), row('b', 2)]);
  check('a retiree classified first earns no win', driver(rec, 'q').wins === 0 && driver(rec, 'q').races === 1);
  rec = fresh();
  res = rec.submit(RACE, [row('q', 1, { out: 'retired', finished: true })]);
  check('retiring sets no race record', !res.records.some((r) => r.type === 'race'));

  // -- running out of time is not a finish
  rec = fresh();
  rec.submit(RACE, [row('a', 1), row('slow', 2, { finished: false, time: null })]);
  check('an unfinished driver keeps their points but gets no podium', driver(rec, 'slow').points === 12 && driver(rec, 'slow').podiums === 0);

  // -- elimination: placings are earned by surviving
  rec = fresh();
  rec.submit({ mapId: 0, laps: 3, mode: 'elimination' }, [row('a', 1, { time: 60000 }), row('b', 2, { finished: false, out: 'elim', time: null }), row('c', 3, { finished: false, out: 'elim', time: null }), row('d', 4, { finished: false, out: 'retired', time: null, points: 0 })]);
  check('in elimination the survivor wins and knocked-out drivers keep their podiums', driver(rec, 'a').wins === 1 && driver(rec, 'b').podiums === 1 && driver(rec, 'c').podiums === 1);
  check('…but a quitter does not', driver(rec, 'd').podiums === 0 && driver(rec, 'd').races === 1);
  check('elimination sets no race-time record', !rec.data.tracks[0].race3);

  // -- plausibility floor
  const lapFloor = minPlausibleMs(0, 1);
  check('the floor is track length / boost speed, per lap', Math.abs(lapFloor - (RTMaps.MAPS[0].path.total / P.BOOST_MAX) * 1000) < 1e-6 && Math.abs(minPlausibleMs(0, 3) - lapFloor * 3) < 1e-6);
  check('the floor sits well below a real lap', lapFloor < GOOD_LAP * 0.6);
  rec = fresh();
  res = rec.submit(RACE, [row('cheat', 1, { bestLap: Math.floor(lapFloor) - 1, time: Math.floor(lapFloor * 3) - 1 })]);
  check('an impossible lap or race time sets no record', res.records.length === 0 && !rec.data.tracks[0].lap && !rec.data.tracks[0].race3);
  res = rec.submit(RACE, [row('legit', 1, { bestLap: Math.ceil(lapFloor), time: Math.ceil(lapFloor * 3) })]);
  check('a time right at the floor is accepted', res.records.length === 2);
  rec = fresh();
  res = rec.submit(RACE, [row('junk', 1, { bestLap: '1', time: NaN })]);
  check('non-numeric times set no record', res.records.length === 0);

  // -- ghosts
  rec = fresh();
  const real = new Set(['a']);
  res = rec.submit(RACE, [row('a', 1), row('ghost', 2)], (pid) => real.has(pid));
  check('an id with no profile behind it does not open standings', res.standings === false);
  check('…and is not stored', !JSON.stringify(rec.data).includes('ghost'));
  res = fresh().submit(RACE, null);
  check('an empty race is harmless', res.standings === false && res.records.length === 0);
}

// ---- hall of fame is keyed by profile, not by name ---------------------------
{
  const rec = new Records(tmp('records.json'));
  const race = { mapId: 0, laps: 3, mode: 'race' };
  const human = (pid, name, pos, extra = {}) => ({ pid, name, carId: 1, bot: false, pos, finished: true, out: null, time: 30000 + pos * 1000, bestLap: 9000 + pos * 100, points: pos === 1 ? 16 : 12, progressed: true, ...extra });
  rec.submit(race, [
    human('p1', 'Alice', 1),
    human('p9', 'Zed', 2),
    { pid: null, name: 'Legacy Larry', carId: 2, bot: true, pos: 3, finished: true, time: 31000, bestLap: 8000, points: 10, progressed: true },
    { name: 'NoProfile', carId: 3, bot: false, pos: 4, finished: true, time: 32000, bestLap: 8000, points: 8, progressed: true },
  ]);
  let s = rec.summary();
  check('bots and profile-less rows are left out', s.drivers.length === 2 && s.drivers[0].name === 'Alice');
  check('the lap record belongs to the profiled driver', s.tracks[0].lap.name === 'Alice' && s.tracks[0].lap.time === 9100);

  // Alice renames; someone else takes "Alice" and races.
  rec.submit(race, [human('p2', 'Alice', 1, { time: 40000, bestLap: 9900, points: 15 }), human('p9', 'Zed', 2)]);
  const current = { p1: 'Alicia', p2: 'Alice', p9: 'Zed' };
  s = rec.summary((pid) => (pid in current ? current[pid] : null));
  const alicia = s.drivers.find((d) => d.name === 'Alicia');
  const alice = s.drivers.find((d) => d.name === 'Alice');
  check('a rename keeps its history', !!alicia && alicia.wins === 1 && alicia.points === 16);
  check('taking a freed name does not inherit its wins', !!alice && alice.races === 1 && alice.points === 15);
  check('records show the holder\'s current name', s.tracks[0].lap.name === 'Alicia');
  check('profile ids are never exposed', !JSON.stringify(s).includes('p1') && !JSON.stringify(s).includes('pid'));

  // The record holder's name is released (admin) and picked up by a newcomer.
  current.p1 = '';
  s = rec.summary((pid) => (pid in current ? current[pid] : null));
  check('a driver with no current name leaves the board', !s.drivers.some((d) => d.name === 'Alicia' || d.name === ''));
  check('…and their record is not credited to anyone else', s.tracks[0].lap.name === '(name released)' && s.tracks[0].lap.time === 9100);
  check('the board is sorted with the most wins first', s.drivers[0].wins >= s.drivers[s.drivers.length - 1].wins);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL IDENTITY TESTS PASSED');
process.exit(failures ? 1 : 0);
