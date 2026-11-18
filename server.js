'use strict';
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { Server } = require('socket.io');

const RTMaps = require('./public/maps.js');
const { CARS } = require('./public/cars.js');
const { POINTS, FASTEST_LAP_BONUS } = require('./public/items.js');
const { Race, DT_MS } = require('./lib/race.js');
const { SKILLS } = require('./lib/bots.js');
const { Records } = require('./lib/records.js');
const { createStore } = require('./lib/store.js');
const { createProfiles, parseCookies } = require('./lib/profiles.js');
const { createLimiter } = require('./lib/ratelimit.js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const MAX_ROOMS = 200;
const MAX_SOCKETS_PER_IP = 64;
const COOKIE_MAX_AGE = 157680000; // 5 years, in seconds
const LAP_CHOICES = [1, 3, 5, 8, 12];
const BOT_NAMES = [
  'Legacy Larry', 'Waterfall Wendy', 'Friday Deploy Fred', 'Spreadsheet Steve',
  'Manual Mandy', 'Hotfix Harry', 'Cowboy Carl', 'Rubber-Stamp Rita',
];

const records = new Records(process.env.RECORDS_FILE || path.join(__dirname, 'data', 'records.json'));
const store = createStore();
const profiles = createProfiles(store, { reserved: BOT_NAMES });
const nameOfPid = (pid) => { const p = profiles.get(pid); return p ? p.name : null; };

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------
// Per-socket buckets: one socket is one player, so these can be tight.
const limInput = createLimiter({ capacity: 60, refillPerSec: 60 });
const limAction = createLimiter({ capacity: 10, refillPerSec: 10 }); // powerup, horn, reset
const limJoin = createLimiter({ capacity: 5, refillPerSec: 0.5 });   // 5 per 10s
// Lobby actions each rebroadcast the lobby to the whole room, so an unthrottled
// socket could make the server spam everyone else in it.
const limLobby = createLimiter({ capacity: 20, refillPerSec: 5 });
// Per-IP buckets: deliberately loose. A whole office can share one NAT
// address — tight per-IP limits would punish the normal case. These are DoS
// backstops, not the integrity mechanism.
const limName = createLimiter({ capacity: 30, refillPerSec: 0.5 }); // 30/min
// Minting is the only unauthenticated path that WRITES: a request with no valid
// cookie creates a profile and rewrites the whole store synchronously. Left open
// it is an amplification vector. Only applied when a request actually mints, so
// a returning player presenting a valid cookie is never throttled.
const limMint = createLimiter({ capacity: 30, refillPerSec: 0.5 }); // 30/min
const socketsPerIp = new Map();

setInterval(() => {
  const idle = 10 * 60 * 1000;
  for (const lim of [limInput, limAction, limJoin, limLobby, limName, limMint]) lim.sweep(idle);
}, 60 * 1000).unref();

// The per-IP limits are DoS backstops, so their key must not be settable by the
// caller being limited. X-Forwarded-For is pure client input unless a trusted
// proxy sets it, so it is consulted only when explicitly opted in (the VPS
// deploy sits behind Traefik, which overwrites the header, and sets
// RTR_TRUST_PROXY=1). Without this, rotating `X-Forwarded-For: 1.2.3.<n>`
// yields a fresh bucket per value and every per-IP limit enforces nothing.
function ipOf(req) {
  if (process.env.RTR_TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '4kb' }));

app.get('/api/records', (req, res) => res.json(records.summary(nameOfPid)));

// Who am I? Mints a profile (and its signed cookie) on first visit.
app.get('/api/profile/me', (req, res) => {
  const token = parseCookies(req.headers.cookie)[profiles.COOKIE];
  const id = profiles.verify(token);
  if (id && profiles.get(id)) {
    return res.json({ id, name: profiles.get(id).name });
  }
  // Only a minting request is throttled — the read path above already returned.
  if (!limMint.allow(ipOf(req))) {
    return res.status(429).json({ ok: false, error: 'Too many new profiles — wait a moment' });
  }
  const minted = profiles.mint();
  // Secure only when asked for: on plain-HTTP setups (localhost, a LAN box) a
  // Secure cookie is never sent back, which would silently break identity for
  // everyone. The HTTPS deploy sets RTR_COOKIE_SECURE=1. maxAge is milliseconds.
  res.cookie(profiles.COOKIE, minted.token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE * 1000,
    secure: process.env.RTR_COOKIE_SECURE === '1',
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
  // A seat carries the name it was taken with; renaming underneath it would
  // let the freed name be claimed and seated in the same room.
  if (isSeated(id)) {
    return res.status(409).json({ ok: false, error: 'Leave your room before changing your name' });
  }
  const result = profiles.claim(id, req.body && req.body.name);
  if (!result.ok) return res.status(result.code || 400).json(result);
  res.json({ ok: true, name: result.name });
});

// Malformed or oversized JSON bodies: answer in JSON, without a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ ok: false, error: 'Bad request' });
});

const server = http.createServer(app);
// Every message this game sends is tiny; refuse anything large before parsing it.
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });

// Resolve identity once per connection. A nameless-but-valid profile is a
// normal state, not an attack: the name is claimed over HTTP before joining.
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
function requireProfile(socket, reply) {
  if (socket.data.authErr) { reply({ ok: false, error: socket.data.authErr }); return null; }
  const p = profiles.get(socket.data.pid);
  if (!p) { reply({ ok: false, error: 'Invalid profile' }); return null; }
  if (!p.name) { reply({ ok: false, error: 'Claim a name first' }); return null; }
  return p;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function isSeated(pid) {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) if (p.pid === pid) return true;
  }
  return false;
}

function createRoom(socket, name) {
  const room = {
    code: makeRoomCode(),
    hostId: socket.id,
    status: 'lobby', // lobby | racing
    settings: {
      mapId: 0,
      laps: Number(process.env.LAPS) || 5,
      mode: 'race',      // race | elimination
      chaos: true,
      bots: 3,
      botSkill: 'medium',
    },
    players: new Map(),     // socket.id -> { id, pid, name, carId, ready }
    standings: new Map(),   // 'p:<pid>' | 'b:<bot name>' -> { name, bot, carId, points, wins, races }
    race: null,
    raceKeys: null,         // racer id -> { key, pid } for the race in progress
    loop: null,
    raceNo: 0,
  };
  rooms.set(room.code, room);
  addPlayer(room, socket, name);
  return room;
}

// `name` comes from the verified profile, never from the client's message.
function addPlayer(room, socket, name) {
  const used = new Set([...room.players.values()].map((p) => p.carId));
  const free = CARS.filter((c) => !used.has(c.id));
  room.players.set(socket.id, {
    id: socket.id,
    pid: socket.data.pid,
    name,
    carId: (free[Math.floor(Math.random() * free.length)] || CARS[0]).id,
    ready: false,
  });
  socket.join(room.code);
  socket.data.roomCode = room.code;
}

function botCount(room) {
  return Math.max(0, Math.min(room.settings.bots, MAX_PLAYERS - room.players.size));
}

function standingsList(room) {
  return [...room.standings.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,
    lapChoices: LAP_CHOICES,
    botCount: botCount(room),
    botNames: BOT_NAMES.slice(0, botCount(room)),
    raceNo: room.raceNo,
    // profile ids stay on the server
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, carId: p.carId, ready: p.ready })),
    standings: standingsList(room),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', lobbyState(room));
}

function removePlayer(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;
  if (room.race) room.race.retire(socket.id);

  if (room.players.size === 0) {
    if (room.loop) clearInterval(room.loop);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  broadcastLobby(room);
}

// ---------------------------------------------------------------------------
// Race lifecycle
// ---------------------------------------------------------------------------
const botKey = (name) => `b:${name.toLowerCase()}`;

function startRace(room) {
  const s = room.settings;
  const keys = new Map();
  const humans = [...room.players.values()].map((p) => {
    keys.set(p.id, { key: `p:${p.pid}`, pid: p.pid });
    return { id: p.id, name: p.name, carId: p.carId, bot: null };
  });
  const usedCars = new Set(humans.map((h) => h.carId));
  const freeCars = CARS.filter((c) => !usedCars.has(c.id)).sort(() => Math.random() - 0.5);
  const bots = BOT_NAMES.slice(0, botCount(room)).map((name, i) => {
    const prev = room.standings.get(botKey(name));
    // a bot keeps its car between races when nobody has taken it
    const keep = prev && !usedCars.has(prev.carId) ? prev.carId : null;
    const carId = keep != null ? keep : (freeCars.pop() || CARS[0]).id;
    usedCars.add(carId);
    const idx = freeCars.findIndex((c) => c.id === carId);
    if (idx >= 0) freeCars.splice(idx, 1);
    keys.set(`bot:${i}`, { key: botKey(name), pid: null });
    return { id: `bot:${i}`, name, carId, bot: { skill: s.botSkill } };
  });

  // Reverse-championship grid: the points leader starts at the back.
  const pts = (e) => (room.standings.get(keys.get(e.id).key) || { points: 0 }).points;
  const entrants = [...humans, ...bots]
    .map((e) => ({ e, key: pts(e) + Math.random() * 0.5 }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.e);

  room.race = new Race({ mapId: s.mapId, laps: s.laps, mode: s.mode, chaos: s.chaos, entrants });
  room.raceKeys = keys;
  room.status = 'racing';
  room.raceNo++;
  room.players.forEach((p) => { p.ready = false; });
  io.to(room.code).emit('raceStart', room.race.staticInfo());
  broadcastLobby(room);

  if (room.loop) clearInterval(room.loop);
  let last = performance.now();
  let acc = 0;
  let sinceSnap = 0;
  room.loop = setInterval(() => {
    const race = room.race;
    if (!race) return;
    const now = performance.now();
    acc = Math.min(250, acc + (now - last));
    last = now;
    let ticked = false;
    while (acc >= DT_MS && !race.over) {
      race.tick();
      acc -= DT_MS;
      sinceSnap++;
      ticked = true;
    }
    if (ticked && (sinceSnap >= 2 || race.over)) {
      sinceSnap = 0;
      io.to(room.code).emit('state', race.snapshot());
    }
    if (race.over) finishRace(room);
  }, 8);
}

function finishRace(room) {
  const race = room.race;
  const keys = room.raceKeys;
  clearInterval(room.loop);
  room.loop = null;
  room.race = null;
  room.raceKeys = null;
  room.status = 'lobby';

  const rows = race.results();
  const awards = race.awards();
  const fastest = awards.find((a) => a.key === 'fastestLap');
  for (const r of rows) {
    // everyone scores for where they ended up; quitting scores nothing
    r.points = r.out === 'retired' ? 0 : (POINTS[r.pos - 1] || 0);
    r.fastest = !!fastest && fastest.i === r.i;
    if (r.fastest && r.points > 0) r.points += FASTEST_LAP_BONUS;

    const { key } = keys.get(r.id);
    const st = room.standings.get(key) || { name: r.name, bot: r.bot, carId: r.carId, points: 0, wins: 0, races: 0 };
    st.name = r.name;
    st.carId = r.carId;
    st.points += r.points;
    st.races++;
    if (r.pos === 1) st.wins++;
    room.standings.set(key, st);
  }

  // The hall of fame is keyed by profile; ids are attached here and never sent out.
  const broken = records.submit(
    { mapId: race.map.id, laps: race.laps, mode: race.mode },
    rows.map((r) => ({ ...r, pid: keys.get(r.id).pid })),
  );
  io.to(room.code).emit('raceOver', {
    mapId: race.map.id,
    mode: race.mode,
    laps: race.laps,
    raceNo: room.raceNo,
    results: rows,
    awards,
    records: broken,
    standings: standingsList(room),
  });
  broadcastLobby(room);
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
function ctx(socket) {
  const room = rooms.get(socket.data.roomCode);
  return room ? { room, player: room.players.get(socket.id) } : {};
}

io.on('connection', (socket) => {
  const replier = (cb) => (typeof cb === 'function' ? cb : () => {});

  socket.on('createRoom', (_msg, cb) => {
    const reply = replier(cb);
    if (!limJoin.allow(socket.id)) return reply({ ok: false, error: 'Slow down' });
    const prof = requireProfile(socket, reply);
    if (!prof) return;
    if (socket.data.roomCode) removePlayer(socket);
    if (rooms.size >= MAX_ROOMS) return reply({ ok: false, error: 'Server is busy — too many rooms' });
    // One profile, one seat: the same cookie in two tabs is one driver.
    if (isSeated(socket.data.pid)) return reply({ ok: false, error: 'You are already in a room in another tab' });
    const room = createRoom(socket, prof.name);
    console.log(`[room ${room.code}] created by ${prof.name}`);
    reply({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('joinRoom', (msg, cb) => {
    const reply = replier(cb);
    if (!limJoin.allow(socket.id)) return reply({ ok: false, error: 'Slow down' });
    const prof = requireProfile(socket, reply);
    if (!prof) return;
    const room = rooms.get(String((msg && msg.code) || '').trim().toUpperCase());
    if (!room) return reply({ ok: false, error: 'Room not found' });
    if (room.players.size >= MAX_PLAYERS && !room.players.has(socket.id)) {
      return reply({ ok: false, error: 'Room is full (8 max)' });
    }
    if (socket.data.roomCode) removePlayer(socket);
    // One profile, one seat. Without this a single cookie could fill a grid
    // and collect a set of results per seat.
    if (isSeated(socket.data.pid)) return reply({ ok: false, error: 'You are already in a room in another tab' });
    if (!rooms.has(room.code)) return reply({ ok: false, error: 'Room not found' }); // it was ours, and is now empty
    addPlayer(room, socket, prof.name);
    console.log(`[room ${room.code}] ${prof.name} joined`);
    reply({ ok: true, code: room.code });
    broadcastLobby(room);
    // arriving mid-race: hand over what is needed to spectate
    if (room.race) socket.emit('raceStart', { ...room.race.staticInfo(), spectate: true });
  });

  // Lobby actions: dropped, not disconnected, when a socket goes over its budget.
  const lobby = (event, fn) => socket.on(event, (msg) => {
    if (!limLobby.allow(socket.id)) return;
    fn(msg);
  });

  lobby('leaveRoom', () => removePlayer(socket));

  lobby('selectCar', (msg) => {
    const { room, player } = ctx(socket);
    if (!room || !player || room.status !== 'lobby') return;
    const carId = Number(msg && msg.carId);
    if (!CARS.some((c) => c.id === carId)) return;
    if ([...room.players.values()].some((o) => o.id !== player.id && o.carId === carId)) return;
    player.carId = carId;
    broadcastLobby(room);
  });

  lobby('toggleReady', () => {
    const { room, player } = ctx(socket);
    if (!room || !player || room.status !== 'lobby') return;
    player.ready = !player.ready;
    broadcastLobby(room);
  });

  lobby('settings', (patch) => {
    const { room } = ctx(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'lobby' || !patch) return;
    const s = room.settings;
    if (patch.mapId !== undefined && RTMaps.MAPS.some((m) => m.id === Number(patch.mapId))) s.mapId = Number(patch.mapId);
    if (patch.laps !== undefined && LAP_CHOICES.includes(Number(patch.laps))) s.laps = Number(patch.laps);
    if (patch.mode === 'race' || patch.mode === 'elimination') s.mode = patch.mode;
    if (patch.chaos !== undefined) s.chaos = !!patch.chaos;
    if (patch.bots !== undefined) s.bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(patch.bots) | 0));
    if (patch.botSkill !== undefined && Object.prototype.hasOwnProperty.call(SKILLS, patch.botSkill)) s.botSkill = patch.botSkill;
    broadcastLobby(room);
  });

  lobby('resetStandings', () => {
    const { room } = ctx(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'lobby') return;
    room.standings.clear();
    room.raceNo = 0;
    broadcastLobby(room);
  });

  lobby('startRace', () => {
    const { room } = ctx(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'lobby') return;
    const others = [...room.players.values()].filter((p) => p.id !== room.hostId);
    if (!others.every((p) => p.ready)) return;
    startRace(room);
  });

  lobby('exitRace', () => {
    const { room } = ctx(socket);
    if (room && room.race) room.race.retire(socket.id);
  });

  socket.on('input', (input) => {
    if (!limInput.allow(socket.id)) return; // dropped, not disconnected
    const { room } = ctx(socket);
    if (room && room.race) room.race.setInput(socket.id, input);
  });

  const action = (event, fn) => socket.on(event, () => {
    if (!limAction.allow(socket.id)) return;
    const { room } = ctx(socket);
    if (room && room.race) fn(room.race);
  });
  action('useItem', (race) => race.useItem(socket.id));
  action('honk', (race) => race.honk(socket.id));
  action('resetCar', (race) => race.resetCar(socket.id));

  socket.on('disconnect', () => {
    for (const lim of [limInput, limAction, limJoin, limLobby]) lim.forget(socket.id);
    const ip = socket.data.ip;
    if (ip) {
      const n = (socketsPerIp.get(ip) || 1) - 1;
      if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
    }
    removePlayer(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Rev-Trac Racer running at http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`  colleagues on your network: http://${ni.address}:${PORT}`);
    }
  }
});
