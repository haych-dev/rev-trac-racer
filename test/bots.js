/**
 * Automated smoke test: N bot drivers create a room, ready up, race,
 * pick up items, use them, and (hopefully) finish laps.
 *
 * Usage: node test/bots.js [serverUrl] [numBots] [mapId]
 * Run the server with LAPS=1 for a quick test.
 */
const { io } = require('socket.io-client');
const RTMaps = require('../public/maps.js');
const { makeProfile } = require('./helpers/profile.js');

const URL = process.argv[2] || 'http://localhost:4100';
const NUM_BOTS = Math.min(8, Number(process.argv[3]) || 3);
const MAP_ID = Number(process.argv[4]) || 0;
const MAP = RTMaps.MAPS.find((m) => m.id === MAP_ID) || RTMaps.MAPS[0];

let roomCode = null;
const bots = [];
let raceOverReceived = false;
let sawItemPickup = false;
let sawItemUse = false;
let stateCount = 0;
let raceStatus = 'lobby';
// Every bot's profile id, collected as each one bootstraps. Populated before
// the race ever starts, so finish() can check the leaderboard for leaks.
const createdPids = [];

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

// Bootstraps a profile and also captures its id (makeProfile only returns the
// cookie). The extra GET reuses the cookie just set, so it reads the existing
// profile rather than minting a second one.
async function makeProfileWithId(name) {
  const cookie = await makeProfile(URL, name);
  const body = await (await fetch(`${URL}/api/profile/me`, { headers: { cookie } })).json();
  createdPids.push(body.id);
  return cookie;
}

function makeBot(name, isHost, cookie) {
  const socket = io(URL, { transports: ['websocket'], extraHeaders: { Cookie: cookie } });
  const bot = { name, socket, id: null, input: { up: false, down: false, left: false, right: false }, lastItem: null };
  bots.push(bot);

  socket.on('connect', () => {
    bot.id = socket.id;
    if (isHost) {
      socket.emit('createRoom', {}, (res) => {
        if (!res.ok) { console.error('createRoom failed', res); process.exit(1); }
        roomCode = res.code;
        log(`${name} created room ${roomCode} on map ${MAP.name}`);
        socket.emit('selectMap', { mapId: MAP.id });
        // spawn the rest once the room exists
        (async () => {
          for (let i = 1; i < NUM_BOTS; i++) {
            const c = await makeProfileWithId(`Bot${i}`);
            makeBot(`Bot${i}`, false, c);
          }
        })().catch((e) => { console.error(e.message); process.exit(1); });
      });
    } else {
      socket.emit('joinRoom', { code: roomCode }, (res) => {
        if (!res.ok) { console.error('joinRoom failed', res); process.exit(1); }
        log(`${name} joined ${roomCode}`);
        socket.emit('toggleReady');
      });
    }
  });

  socket.on('lobby', (lobby) => {
    if (!isHost) return;
    const others = lobby.players.filter((p) => p.id !== bot.id);
    if (lobby.status === 'lobby' && others.length === NUM_BOTS - 1 && others.every((p) => p.ready)) {
      log('all ready — host starting race');
      socket.emit('startRace');
    }
  });

  socket.on('state', (state) => {
    raceStatus = state.status;
    if (!isHost) return;
    stateCount++;

    // track closest approach to any pad (diagnostics)
    if (state.status === 'racing' && state.pads) {
      for (const p of state.players) {
        for (const pad of state.pads) {
          const d = Math.hypot(p.x - pad.x, p.y - pad.y);
          if (d < (global.minPadDist || Infinity)) global.minPadDist = d;
        }
      }
    }

    // every bot steers toward a point ahead on the loop
    if (state.status === 'racing') {
      for (const b of bots) {
        const me = state.players.find((p) => p.id === b.id);
        if (!me || me.finished) continue;

        if (me.item && !b.usedAt) { sawItemPickup = true; b.socket.emit('useItem'); b.usedAt = Date.now(); sawItemUse = true; }
        if (b.usedAt && Date.now() - b.usedAt > 3000) b.usedAt = null;

        // steer toward a point ahead on the track centerline
        const near = RTMaps.closest(MAP.path, me.x, me.y);
        const tgt = RTMaps.pointAt(MAP.path, near.u + 0.035);
        const desired = Math.atan2(tgt.y - me.y, tgt.x - me.x);
        let da = desired - me.angle;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;

        const input = { up: true, down: false, left: da < -0.06, right: da > 0.06 };
        if (JSON.stringify(input) !== JSON.stringify(b.input)) {
          b.input = input;
          b.socket.emit('input', input);
        }
      }
    }
  });

  socket.on('raceOver', ({ results }) => {
    if (!isHost) return;
    raceOverReceived = true;
    log('RACE OVER');
    results.forEach((r, i) => log(`  ${i + 1}. ${r.name} — ${r.finished ? (r.time / 1000).toFixed(1) + 's' : 'DNF (laps ' + r.laps + ')'}`));
    finish(results).catch((e) => { console.error(e.message); process.exit(1); });
  });

  return bot;
}

async function finish(results) {
  // The board is populated only now that a race has completed, so this is the
  // one place a pid leak in view() would actually be visible.
  let lbOk = false, lbPopulated = false, lbNoPid = false;
  try {
    const body = await (await fetch(`${URL}/api/leaderboard`)).json();
    lbOk = true;
    lbPopulated = Array.isArray(body.standings) && body.standings.length > 0;
    const serialized = JSON.stringify(body);
    lbNoPid = createdPids.length > 0 && createdPids.every((pid) => !serialized.includes(pid));
    log(`leaderboard: standings=${body.standings.length} recordsMaps=${Object.keys(body.records).length}`);
  } catch (e) {
    log(`leaderboard fetch failed: ${e.message}`);
  }

  const pass =
    raceOverReceived &&
    stateCount > 50 &&
    sawItemPickup &&
    results.some((r) => r.finished) &&
    lbOk && lbPopulated && lbNoPid;
  log('--- RESULTS ---');
  log(`states received: ${stateCount}`);
  log(`item picked up: ${sawItemPickup}, item used: ${sawItemUse}`);
  log(`closest approach to a pad: ${Math.round(global.minPadDist || -1)}px`);
  log(`race finished cleanly: ${raceOverReceived}`);
  log(`leaderboard ok=${lbOk} populated=${lbPopulated} noPid=${lbNoPid}`);
  log(pass ? 'PASS' : 'FAIL');
  bots.forEach((b) => b.socket.disconnect());
  process.exit(pass ? 0 : 1);
}

setTimeout(() => {
  console.error(`TIMEOUT — race did not complete in 120s (status=${raceStatus}, states=${stateCount})`);
  const anyState = stateCount > 0;
  log(`item picked up: ${sawItemPickup}`);
  process.exit(anyState ? 2 : 1);
}, 120000);

makeProfileWithId('HostBot')
  .then((cookie) => makeBot('HostBot', true, cookie))
  .catch((e) => { console.error(e.message); process.exit(1); });
