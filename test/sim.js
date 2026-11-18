'use strict';
/* Headless simulation tests: races run flat-out with no sockets or timers.
 * Usage: node test/sim.js [--verbose] */
const RTMaps = require('../public/maps.js');
const { CARS, BODIES } = require('../public/cars.js');
const { ITEM_KEYS } = require('../public/items.js');
const { Race } = require('../lib/race.js');

const verbose = process.argv.includes('--verbose');
let failures = 0;
const fmt = (ms) => (ms == null ? '  DNF' : (ms / 1000).toFixed(1).padStart(5) + 's');

function check(cond, msg) {
  if (!cond) { failures++; console.log('   FAIL: ' + msg); }
  return cond;
}

function entrants(n, skills, carIds) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'bot' + i,
    name: 'Bot ' + i,
    carId: carIds ? carIds[i % carIds.length] : (i * 3) % CARS.length,
    bot: { skill: skills[i % skills.length] },
  }));
}

function run(opts, maxSimMs = 7 * 60 * 1000) {
  const race = new Race(opts);
  let ticks = 0;
  while (!race.over && race.t < maxSimMs) {
    race.tick();
    ticks++;
    if (ticks % 30 === 0) race.snapshot(); // drain events like the server does
  }
  for (const p of race.players) {
    if (![p.x, p.y, p.vx, p.vy, p.angle, p.u].every(Number.isFinite)) {
      check(false, `non-finite state for ${p.name} on ${race.map.name}`);
    }
  }
  return race;
}

// ---------------------------------------------------------------------------
console.log('1. Full 8-bot race on every track (no chaos)');
for (const map of RTMaps.MAPS) {
  const race = run({ mapId: map.id, laps: 3, mode: 'race', chaos: false, seed: 42 + map.id,
    entrants: entrants(8, ['hard', 'hard', 'medium', 'hard', 'medium', 'easy', 'medium', 'easy']) });
  const res = race.results();
  const finished = res.filter((r) => r.finished);
  const best = Math.min(...res.filter((r) => r.bestLap).map((r) => r.bestLap));
  console.log(`   ${map.name.padEnd(19)} winner ${fmt(res[0].time)}  best lap ${fmt(best)}  finishers ${finished.length}/8`);
  check(race.over, `${map.name}: race did not end`);
  check(finished.length >= 6, `${map.name}: only ${finished.length} finishers`);
  check(res.every((r) => r.laps >= 2), `${map.name}: a bot completed fewer than 2 laps`);
  check(res[0].time > 25000 && res[0].time < 150000, `${map.name}: implausible winning time ${res[0].time}`);
  if (verbose) res.forEach((r) => console.log(`      ${r.pos}. ${r.name} ${fmt(r.time)} laps=${r.laps} best=${fmt(r.bestLap)} hits=${r.stats.hitsTaken}`));
}

// ---------------------------------------------------------------------------
console.log('2. Chaos mode on every track');
for (const map of RTMaps.MAPS) {
  const race = run({ mapId: map.id, laps: 3, mode: 'race', chaos: true, seed: 900 + map.id,
    entrants: entrants(8, ['hard', 'medium', 'easy']) });
  const res = race.results();
  console.log(`   ${map.name.padEnd(19)} winner ${fmt(res[0].time)}  finishers ${res.filter((r) => r.finished).length}/8`);
  check(race.over, `${map.name} (chaos): race did not end`);
  check(res.filter((r) => r.finished).length >= 4, `${map.name} (chaos): too few finishers`);
}

// ---------------------------------------------------------------------------
console.log('3. Elimination mode');
{
  const race = run({ mapId: 0, laps: 3, mode: 'elimination', chaos: false, seed: 7,
    entrants: entrants(6, ['hard', 'medium', 'easy']) });
  const res = race.results();
  console.log(`   winner ${res[0].name}, order: ${res.map((r) => r.name.replace('Bot ', '#')).join(' ')}`);
  check(race.over, 'elimination did not end');
  check(res.filter((r) => r.finished).length === 1, 'elimination should have exactly one survivor');
  check(res.filter((r) => r.out === 'elim').length === 5, 'elimination should eliminate 5 of 6');
}

// ---------------------------------------------------------------------------
console.log('4. Every powerup fires without error');
for (const item of ITEM_KEYS) {
  const race = new Race({ mapId: 4, laps: 3, mode: 'race', chaos: false, seed: 5,
    entrants: entrants(5, ['medium']) });
  let ok = true;
  try {
    while (race.t < 9000) race.tick();
    const user = race.order[race.order.length - 1]; // last place: everyone is "ahead"
    while (user.spinUntil > race.t || user.lockedUntil > race.t) race.tick(); // wait until it can act
    race.snapshot();
    user.item = item;
    user.botItemAt = Infinity;
    const before = user.stats.items;
    race.useItem(user.id);
    const evs = race.snapshot().ev;
    check(user.stats.items === before + 1, `${item}: was not consumed`);
    check(evs.some((e) => e.k === 'use' && e.it === item), `${item}: no use event`);
    for (let i = 0; i < 600; i++) race.tick();
  } catch (err) {
    ok = false;
    check(false, `${item}: threw ${err.stack}`);
  }
  if (ok) process.stdout.write(`   ${item}`);
}
console.log('');

// ---------------------------------------------------------------------------
console.log('5. Car body balance (solo hard bot, best lap, 3 tracks)');
{
  const bodies = Object.keys(BODIES);
  const totals = {};
  for (const body of bodies) {
    const car = CARS.find((c) => c.body === body);
    let sum = 0;
    for (const mapId of [0, 4, 5]) {
      const race = run({ mapId, laps: 2, mode: 'race', chaos: false, seed: 1,
        entrants: entrants(1, ['hard'], [car.id]) });
      sum += race.results()[0].bestLap || 99999;
    }
    totals[body] = sum;
  }
  const vals = Object.values(totals);
  const min = Math.min(...vals), max = Math.max(...vals);
  for (const b of bodies) console.log(`   ${b.padEnd(9)} ${(totals[b] / 1000).toFixed(2)}s  (+${(((totals[b] / min) - 1) * 100).toFixed(1)}%)`);
  check(max / min < 1.09, `bodies are unbalanced: spread ${(((max / min) - 1) * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
console.log('6. Determinism');
{
  const mk = () => run({ mapId: 1, laps: 2, mode: 'race', chaos: true, seed: 1234,
    entrants: entrants(6, ['hard', 'medium']) }).results().map((r) => `${r.name}:${r.time}`).join('|');
  check(mk() === mk(), 'same seed produced different results');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SIM TESTS PASSED');
process.exit(failures ? 1 : 0);
