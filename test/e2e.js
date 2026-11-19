'use strict';
/* End-to-end test over real HTTP and sockets. Starts its own server on a spare
 * port with throwaway data files, then walks identity, the room lifecycle and
 * the hardening claims (rate limits, owned names, nothing leaking).
 * Usage: node test/e2e.js */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const { makeProfile, mintProfile, claimName } = require('./helpers/profile.js');
const RTMaps = require('../public/maps.js');

const PORT = 4100 + Math.floor(Math.random() * 400);
const URL = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtr-e2e-'));

let failures = 0;
const sockets = [];
function check(cond, msg) {
  console.log(`${cond ? ' ok ' : 'FAIL'} ${msg}`);
  if (!cond) failures++;
}

// Open a socket carrying `cookie` (or none). Does not wait for a name.
function open(cookie) {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : {} });
    sockets.push(s);
    s.lobby = null;
    s.cookie = cookie;
    s.on('lobby', (l) => { s.lobby = l; });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
// A driver with a claimed name, connected and ready to join rooms.
const driver = async (name) => open(await makeProfile(URL, name));
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
const getJson = async (p) => (await fetch(URL + p)).json();

// Steer a client's own car around the track from the snapshots it receives.
// Returns a function that stops driving.
function autodrive(s, idx, mapId) {
  const trackPath = RTMaps.MAPS.find((m) => m.id === mapId).path;
  let last = '';
  const onState = (snap) => {
    if (snap.st !== 'racing') return;
    const me = snap.p[idx];
    const near = RTMaps.closest(trackPath, me.x, me.y);
    const aim = RTMaps.pointAt(trackPath, near.u + (90 + me.v * 0.28) / trackPath.total);
    const da = RTMaps.angNorm(Math.atan2(aim.y - me.y, aim.x - me.x) - me.a);
    const input = { u: me.v < 300, l: da < -0.07, r: da > 0.07 };
    const key = JSON.stringify(input);
    if (key !== last) { last = key; s.emit('input', input); }
  };
  s.on('state', onState);
  return () => s.off('state', onState);
}
// How far round the lap a car is (0..1), from a snapshot.
const lapFraction = (snap, idx, mapId) => {
  const p = snap.p[idx];
  return RTMaps.closest(RTMaps.MAPS.find((m) => m.id === mapId).path, p.x, p.y).u;
};

async function main() {
  // ---- identity over HTTP -------------------------------------------------
  const first = await mintProfile(URL);
  check(first.cookie.startsWith('rtr_pid='), 'first visit sets a profile cookie');
  check(first.body.name === null, 'a new profile starts nameless');
  check(/HttpOnly/i.test(first.raw) && /SameSite=Lax/i.test(first.raw), 'the cookie is HttpOnly and SameSite=Lax');
  check(/Max-Age=157680000/.test(first.raw), 'the cookie lasts 5 years');
  check(!/;\s*Secure/i.test(first.raw), 'the cookie is not Secure unless RTR_COOKIE_SECURE=1 (plain-HTTP setups keep working)');
  const again = await (await fetch(`${URL}/api/profile/me`, { headers: { cookie: first.cookie } })).json();
  check(again.id === first.body.id, 'an existing cookie keeps its id');

  check((await claimName(URL, first.cookie, 'ab')).status === 400, 'a 2-character name is rejected');
  check((await claimName(URL, first.cookie, 'Bad!<b>')).status === 400, 'punctuation and markup are rejected');
  check((await claimName(URL, first.cookie, 'legacy larry')).status === 409, 'an AI driver name cannot be claimed');
  check((await claimName(URL, 'rtr_pid=forged.0000', 'Forger')).status === 400, 'a forged cookie cannot claim a name');
  const badJson = await fetch(`${URL}/api/profile/name`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: first.cookie }, body: '{nope' });
  check(badJson.status === 400 && (await badJson.json().catch(() => null))?.ok === false, 'malformed JSON gets a clean 400');

  // ---- sockets without a usable identity ------------------------------------
  const nameless = await open(first.cookie);
  const r1 = await emitAck(nameless, 'createRoom', {});
  check(r1.ok === false && r1.error === 'Claim a name first', 'a profile with no name cannot create a room');
  const cookieless = await open(null);
  const r2 = await emitAck(cookieless, 'createRoom', { name: 'Anon' });
  check(r2.ok === false && r2.error === 'No profile', 'a socket with no cookie is refused');
  const forged = await open('rtr_pid=11111111-2222-3333-4444-555555555555.deadbeefdeadbeefdeadbeefdeadbeef');
  const r3 = await emitAck(forged, 'createRoom', {});
  check(r3.ok === false && r3.error === 'Invalid profile', 'a forged cookie is refused');
  for (const s of [nameless, cookieless, forged]) s.disconnect();

  // ---- lobby --------------------------------------------------------------
  const host = await driver('Tester');
  const created = await emitAck(host, 'createRoom', { name: 'Impostor' });
  check(created.ok && /^[A-Z0-9]{4}$/.test(created.code), `room created (${created.code})`);
  await sleep(150);
  check(host.lobby.players[0].name === 'Tester', 'the name comes from the profile; a client-supplied name is ignored');
  check(host.lobby.settings.chaos === true && host.lobby.botCount === 3, 'lobby defaults: chaos on, 3 bots');
  const hostPid = host.cookie.slice('rtr_pid='.length).split('.')[0];
  check(hostPid.length === 36 && !JSON.stringify(host.lobby).includes(hostPid) && !/"pid"/.test(JSON.stringify(host.lobby)), 'lobby state carries no profile ids');

  check((await claimName(URL, (await mintProfile(URL)).cookie, 'TESTER')).status === 409, 'a taken name is refused, case-insensitively');
  check((await claimName(URL, host.cookie, 'Tester2')).status === 409, 'a seated driver cannot rename');

  const twin = await open(host.cookie);
  const twinJoin = await emitAck(twin, 'joinRoom', { code: created.code });
  check(twinJoin.ok === false && /another tab/i.test(twinJoin.error), 'one profile, one seat: a second tab cannot join');
  twin.disconnect();

  host.emit('settings', { laps: 1, bots: 2, botSkill: 'hard', mapId: 8, mode: 'race', chaos: true });
  await sleep(150);
  const st = host.lobby.settings;
  check(st.laps === 1 && st.bots === 2 && st.botSkill === 'hard' && st.mapId === 8, 'host can change settings');
  host.emit('settings', { laps: 999, mapId: 99, botSkill: '__proto__' });
  await sleep(150);
  check(host.lobby.settings.laps === 1 && host.lobby.settings.mapId === 8 && host.lobby.settings.botSkill === 'hard', 'invalid settings are ignored');

  const guest = await driver('Guest');
  check((await emitAck(guest, 'joinRoom', { code: created.code })).ok, 'guest joined');
  guest.emit('settings', { laps: 12 });
  await sleep(150);
  check(host.lobby.settings.laps === 1, 'non-host cannot change settings');

  // capacity
  const extras = [];
  for (let i = 0; i < 6; i++) {
    const s = await driver('Extra' + i);
    if ((await emitAck(s, 'joinRoom', { code: created.code })).ok) extras.push(s);
  }
  await sleep(150);
  check(extras.length === 6 && host.lobby.players.length === 8, '8 players fit in a room');
  check(host.lobby.botCount === 0, 'bots make way when the room is full of people');
  const ninth = await driver('Ninth');
  const r9 = await emitAck(ninth, 'joinRoom', { code: created.code });
  check(!r9.ok && /full/i.test(r9.error), 'ninth player is rejected');
  check(new Set(host.lobby.players.map((p) => p.carId)).size === 8, 'every player has a unique car');
  extras.forEach((s) => s.disconnect());
  ninth.disconnect();
  await sleep(250);
  check(host.lobby.players.length === 2 && host.lobby.botCount === 2, 'bots return when people leave');

  // ---- rate limits on a live socket -----------------------------------------
  const burst = await Promise.all(Array.from({ length: 8 }, () => emitAck(guest, 'joinRoom', { code: 'ZZZZ' })));
  check(burst.some((r) => r.error === 'Slow down') && burst.some((r) => r.error === 'Room not found'), 'a join burst is rate limited after its allowance');

  for (let i = 0; i < 2000; i++) guest.emit('input', { u: true, l: i % 2 === 0 });
  let rebroadcasts = 0;
  const count = () => { rebroadcasts++; };
  guest.on('lobby', count);
  for (let i = 0; i < 300; i++) host.emit('settings', { chaos: i % 2 === 0 });
  await sleep(600);
  guest.off('lobby', count);
  check(rebroadcasts > 0 && rebroadcasts < 40, `a lobby-action flood is throttled (300 sent, ${rebroadcasts} rebroadcast to the room)`);
  check(host.connected && guest.connected, 'flooding sockets are throttled, not disconnected');
  await sleep(4500); // let the host's lobby bucket refill
  host.emit('settings', { chaos: true });
  await sleep(150);
  check(host.lobby.settings.chaos === true, 'the socket works normally again once its bucket refills');

  // ---- race ---------------------------------------------------------------
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

  const late = await driver('Latecomer');
  const lateStart = waitFor(late, 'raceStart', () => true, 5000);
  const lateJoin = await emitAck(late, 'joinRoom', { code: created.code });
  const lateInfo = await lateStart.catch(() => null);
  check(lateJoin.ok && lateInfo && lateInfo.spectate === true, 'mid-race joiner is let in as a spectator');

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
  check(!/"pid"/.test(JSON.stringify(over)), 'race results carry no profile ids');
  await sleep(200);
  check(host.lobby.status === 'lobby' && host.lobby.raceNo === 1, 'room returns to the lobby');

  // ---- hall-of-fame farming guards ------------------------------------------
  // Race 1 had one driver who moved (the host) and one parked on the grid.
  check(over.counted === false, 'a race where the second driver never moved is flagged as not counting');
  let rec = await getJson('/api/records');
  check(rec.drivers.length === 0, 'a parked second profile does not put anyone on the all-time board');

  // second race: elimination, and this time two people really drive
  host.emit('settings', { mode: 'elimination', bots: 3, mapId: 0 });
  guest.emit('toggleReady');
  late.emit('toggleReady');
  await sleep(200);
  const start2 = waitFor(host, 'raceStart');
  host.emit('startRace');
  const info2 = await start2;
  check(info2.mode === 'elimination' && info2.roster.length === 6, 'second race: elimination with 3 humans + 3 bots');
  const idx2 = (s) => info2.roster.findIndex((r) => r.id === s.id);
  const stopHost = autodrive(host, idx2(host), 0);
  const stopGuest = autodrive(guest, idx2(guest), 0);
  const inRange = (u) => u > 0.15 && u < 0.6; // past the first sector, on lap one
  const bothDrove = await waitFor(host, 'state', (s) => inRange(lapFraction(s, idx2(host), 0)) && inRange(lapFraction(s, idx2(guest), 0)), 20000).catch(() => null);
  stopHost(); stopGuest();
  check(!!bothDrove, 'two clients drive their own cars round the first part of the lap');
  const over2P = waitFor(host, 'raceOver', () => true, 120000);
  for (const s of [host, guest, late]) s.emit('exitRace');
  const over2 = await over2P;
  check(over2.raceNo === 2 && over2.standings.some((s) => s.races === 2), 'standings accumulate across races');
  check(over2.counted === true, 'a race with two people driving counts toward the hall of fame');
  rec = await getJson('/api/records');
  const board = Object.fromEntries(rec.drivers.map((d) => [d.name, d]));
  check(['Tester', 'Guest', 'Latecomer'].every((nm) => board[nm] && board[nm].races === 1), 'everyone in a counted race gets the race on their record');
  check(rec.drivers.every((d) => d.wins === 0 && d.podiums === 0 && d.points === 0), 'quitting earns no win, podium or points, however it is classified');

  host.emit('resetStandings');
  await sleep(150);
  check(host.lobby.standings.length === 0 && host.lobby.raceNo === 0, 'host can reset the championship');

  // ---- names are owned: history follows the profile, not the text -----------
  host.emit('leaveRoom');
  await sleep(150);
  check((await claimName(URL, host.cookie, 'Renamed')).status === 200, 'a driver can rename once out of the room');
  rec = await getJson('/api/records');
  const names = rec.drivers.map((d) => d.name);
  check(names.includes('Renamed') && !names.includes('Tester'), 'the hall of fame follows the rename');
  const taker = await mintProfile(URL);
  check((await claimName(URL, taker.cookie, 'Tester')).status === 200, 'the freed name can be claimed by someone else…');
  rec = await getJson('/api/records');
  check(!rec.drivers.some((d) => d.name === 'Tester'), '…without inheriting any history');

  // ---- per-IP limits (last: this deliberately burns the mint budget) ---------
  let limited = 0, okd = 0;
  for (let i = 0; i < 45; i++) {
    const res = await fetch(`${URL}/api/profile/me`, { headers: { 'x-forwarded-for': `10.9.8.${i}` } });
    if (res.status === 429) limited++; else if (res.ok) okd++;
  }
  check(limited > 0 && okd > 0, `profile minting is rate limited, and a rotating X-Forwarded-For buys nothing (${okd} minted, ${limited} refused)`);
  const known = await fetch(`${URL}/api/profile/me`, { headers: { cookie: host.cookie } });
  check(known.status === 200, 'a returning driver with a valid cookie is never throttled');
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env, PORT: String(PORT), LAPS: '',
    RECORDS_FILE: path.join(dataDir, 'records.json'),
    RTR_STORE_PATH: path.join(dataDir, 'store.json'),
    RTR_TRUST_PROXY: '', RTR_COOKIE_SECURE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let started = false;
server.stderr.on('data', (d) => process.stderr.write(d));
server.stdout.on('data', (d) => {
  if (started || !String(d).includes('running at')) return;
  started = true;
  main()
    .catch((err) => { failures++; console.log('FAIL exception:', err.stack || err.message); })
    .finally(() => {
      sockets.forEach((s) => s.disconnect());
      server.kill();
      setTimeout(() => {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
        console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL E2E TESTS PASSED');
        process.exit(failures ? 1 : 0);
      }, 300);
    });
});
setTimeout(() => { console.log('FAIL: global timeout'); server.kill(); process.exit(1); }, 240000);
