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
