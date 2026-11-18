'use strict';
/* End-to-end test over real sockets. Starts its own server on a spare port
 * with a throwaway records file, then walks the whole room lifecycle.
 * Usage: node test/e2e.js */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 4100 + Math.floor(Math.random() * 400);
const URL = `http://localhost:${PORT}`;
const recordsFile = path.join(os.tmpdir(), `rtr-e2e-records-${process.pid}.json`);

let failures = 0;
const sockets = [];
function check(cond, msg) {
  console.log(`${cond ? ' ok ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.lobby = null;
    s.on('lobby', (l) => { s.lobby = l; });
    s.on('connect', () => resolve(s));
  });
}
const emitAck = (s, ev, msg) => new Promise((res) => s.emit(ev, msg, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(s, ev, pred = () => true, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.off(ev, h); reject(new Error(`timeout waiting for ${ev}`)); }, timeout);
    const h = (payload) => {
      if (!pred(payload)) return;
      clearTimeout(timer); s.off(ev, h); resolve(payload);
    };
    s.on(ev, h);
  });
}
const getJson = (p) => new Promise((resolve, reject) => {
  http.get(URL + p, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});

async function main(server) {
  const host = await connect();
  const created = await emitAck(host, 'createRoom', { name: 'Tester' });
  check(created.ok && /^[A-Z0-9]{4}$/.test(created.code), `room created (${created.code})`);
  await sleep(150);
  check(host.lobby && host.lobby.settings.chaos === true && host.lobby.botCount === 3, 'lobby defaults: chaos on, 3 bots');

  host.emit('settings', { laps: 1, bots: 2, botSkill: 'hard', mapId: 8, mode: 'race', chaos: true });
  await sleep(150);
  const st = host.lobby.settings;
  check(st.laps === 1 && st.bots === 2 && st.botSkill === 'hard' && st.mapId === 8, 'host can change settings');
  host.emit('settings', { laps: 999, mapId: 99, botSkill: 'godlike' });
  await sleep(150);
  check(host.lobby.settings.laps === 1 && host.lobby.settings.mapId === 8 && host.lobby.settings.botSkill === 'hard', 'invalid settings are ignored');

  const guest = await connect();
  const joined = await emitAck(guest, 'joinRoom', { code: created.code, name: 'Tester' });
  await sleep(150);
  check(joined.ok, 'guest joined');
  const names = host.lobby.players.map((p) => p.name);
  check(names.includes('Tester') && names.includes('Tester 2'), `duplicate names are disambiguated (${names.join(', ')})`);
  guest.emit('settings', { laps: 12 });
  await sleep(100);
  check(host.lobby.settings.laps === 1, 'non-host cannot change settings');

  // capacity
  const extras = [];
  for (let i = 0; i < 6; i++) {
    const s = await connect();
    const r = await emitAck(s, 'joinRoom', { code: created.code, name: 'Extra' + i });
    if (r.ok) extras.push(s);
  }
  await sleep(150);
  check(extras.length === 6 && host.lobby.players.length === 8, '8 players fit in a room');
  check(host.lobby.botCount === 0, 'bots make way when the room is full of people');
  const ninth = await connect();
  const r9 = await emitAck(ninth, 'joinRoom', { code: created.code, name: 'Ninth' });
  check(!r9.ok && /full/i.test(r9.error), 'ninth player is rejected');
  const cars = host.lobby.players.map((p) => p.carId);
  check(new Set(cars).size === 8, 'every player has a unique car');
  extras.forEach((s) => s.disconnect());
  await sleep(250);
  check(host.lobby.players.length === 2 && host.lobby.botCount === 2, 'bots return when people leave');

  // start
  host.emit('startRace');
  await sleep(200);
  check(host.lobby.status === 'lobby', 'race does not start until guests are ready');
  guest.emit('toggleReady');
  await sleep(150);
  const startP = waitFor(guest, 'raceStart');
  host.emit('startRace');
  const info = await startP;
  check(info.roster.length === 4 && info.roster.filter((r) => r.bot).length === 2 && info.mapId === 8, 'race starts with 2 humans + 2 bots on the chosen track');
  check(new Set(info.roster.map((r) => r.carId)).size === 4, 'bots take cars nobody is using');

  // late joiner spectates
  const late = await connect();
  const lateStart = waitFor(late, 'raceStart', () => true, 5000);
  const lateJoin = await emitAck(late, 'joinRoom', { code: created.code, name: 'Latecomer' });
  const lateInfo = await lateStart.catch(() => null);
  check(lateJoin.ok && lateInfo && lateInfo.spectate === true, 'mid-race joiner is let in as a spectator');

  // drive a little, then both humans leave the race
  const hostIdx = info.roster.findIndex((r) => r.id === host.id);
  const guestIdx = info.roster.findIndex((r) => r.id === guest.id);
  await waitFor(host, 'state', (s) => s.st === 'racing', 10000);
  host.emit('input', { u: true });
  const moved = await waitFor(host, 'state', (s) => s.p[hostIdx].v > 150, 8000).catch(() => null);
  check(!!moved, 'throttle input moves the car');
  host.emit('honk');
  const honked = await waitFor(guest, 'state', (s) => s.ev.some((e) => e.k === 'honk' && e.i === hostIdx), 3000).catch(() => null);
  check(!!honked, 'horn is heard by other players');

  guest.emit('exitRace');
  const out = await waitFor(host, 'state', (s) => (s.p[guestIdx].f & 2048) !== 0, 3000).catch(() => null);
  check(!!out, 'exited player is flagged out');
  const overP = waitFor(host, 'raceOver', () => true, 60000);
  host.emit('exitRace');
  const over = await overP;
  check(over.results.length === 4, 'results cover all four racers');
  const humans = over.results.filter((r) => !r.bot);
  check(humans.every((r) => r.out === 'retired' && r.points === 0), 'quitters score nothing');
  check(over.results[0].bot && over.results[0].points >= 15, `winner is a bot with full points (${over.results[0].name}: ${over.results[0].points})`);
  check(over.standings.length === 4 && over.standings[0].points >= 15, 'standings are updated');
  check(Array.isArray(over.awards) && over.awards.some((a) => a.key === 'speed'), 'awards are handed out');
  await sleep(200);
  check(host.lobby.status === 'lobby' && host.lobby.raceNo === 1, 'room returns to the lobby');

  const rec = await getJson('/api/records');
  check(rec.drivers.length === 2 && rec.drivers.every((d) => d.races === 1), 'hall of fame tracks human drivers only');

  // second race: standings accumulate, elimination mode works over sockets
  host.emit('settings', { mode: 'elimination', bots: 3, mapId: 0 });
  guest.emit('toggleReady');
  late.emit('toggleReady');
  await sleep(200);
  const start2 = waitFor(host, 'raceStart');
  host.emit('startRace');
  const info2 = await start2;
  check(info2.mode === 'elimination' && info2.roster.length === 6, 'second race: elimination with 3 humans + 3 bots');
  const over2P = waitFor(host, 'raceOver', () => true, 120000);
  for (const s of [host, guest, late]) s.emit('exitRace');
  const over2 = await over2P;
  check(over2.raceNo === 2 && over2.standings.some((s) => s.races === 2), 'standings accumulate across races');

  host.emit('resetStandings');
  await sleep(150);
  check(host.lobby.standings.length === 0 && host.lobby.raceNo === 0, 'host can reset the championship');
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT), RECORDS_FILE: recordsFile, LAPS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
server.stderr.on('data', (d) => process.stderr.write(d));
server.stdout.on('data', (d) => {
  if (started || !String(d).includes('running at')) return;
  started = true;
  main(server)
    .catch((err) => { failures++; console.log('FAIL exception:', err.message); })
    .finally(() => {
      sockets.forEach((s) => s.disconnect());
      server.kill();
      try { fs.unlinkSync(recordsFile); } catch (e) { /* never written */ }
      console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E TESTS PASSED');
      process.exit(failures ? 1 : 0);
    });
});
setTimeout(() => { console.log('FAIL: global timeout'); server.kill(); process.exit(1); }, 240000);
