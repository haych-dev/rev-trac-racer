const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { BOOST_SPEED } = require('./constants.js');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
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

const server = http.createServer(app);
const io = new Server(server);

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

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Constants (track geometry must match public/game.js)
// ---------------------------------------------------------------------------
const MAX_PLAYERS = 8;
const TOTAL_LAPS = Number(process.env.LAPS) || 3;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;

const RTMaps = require('./public/maps.js');
const SECTORS = 8; // sequential checkpoints per lap, by arc-length
const PAD_FRACS = [0.12, 0.28, 0.45, 0.62, 0.78, 0.92]; // item rows along the lap

const { CARS } = require('./public/cars.js');

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

const ITEMS = ['boost', 'cab', 'lock', 'shield', 'oops'];

// Item pads: a row of 3 boxes spanning the track width at each PAD_FRAC
function buildPads(map) {
  const pads = [];
  let id = 0;
  const lat = map.halfWidth - 35;
  for (const f of PAD_FRACS) {
    const pt = RTMaps.pointAt(map.path, f);
    const nx = -pt.ty, ny = pt.tx;
    for (const off of [-lat, 0, lat]) {
      pads.push({ id: id++, x: pt.x + nx * off, y: pt.y + ny * off, active: true, respawnAt: 0 });
    }
  }
  return pads;
}

// Physics
const ACCEL = 420;
const BRAKE = 520;
const REVERSE_MAX = -120;
const MAX_SPEED = 420;
const OFFTRACK_MAX = 140;
const FRICTION = 1.6;       // per-second speed decay factor
const TURN_RATE = 3.0;      // rad/s at full speed factor
const CAR_RADIUS = 18;

// ---------------------------------------------------------------------------
// Track helpers
// ---------------------------------------------------------------------------
function mapOf(room) {
  return RTMaps.MAPS[room.mapId] || RTMaps.MAPS[0];
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

function createRoom(hostSocket, name) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: hostSocket.id,
    status: 'lobby', // lobby | countdown | racing | finished
    mapId: 0,
    players: new Map(),
    hazards: [],
    pads: [],
    loop: null,
    countdownEnd: 0,
    raceStart: 0,
    firstFinishAt: 0,
    results: [],
  };
  rooms.set(code, room);
  addPlayer(room, hostSocket, name);
  return room;
}

function addPlayer(room, socket, name) {
  const usedCars = new Set([...room.players.values()].map((p) => p.carId));
  let carId = CARS.findIndex((c) => !usedCars.has(c.id));
  if (carId === -1) carId = 0;
  room.players.set(socket.id, {
    id: socket.id,
    pid: socket.data.pid || null,
    name: String(name || 'Racer').trim().slice(0, 16) || 'Racer',
    carId,
    ready: false,
    // race state
    x: 0, y: 0, angle: 0, speed: 0,
    input: { up: false, down: false, left: false, right: false },
    item: null,
    lap: 0,
    nextSector: 1,  // next arc-length sector to hit (spawn is just behind sector 0)
    cpCount: 0,     // total sectors hit
    _u: 0,          // latest progress fraction along the lap
    rank: 1,
    finished: false,
    retired: false,
    finishTime: 0,
    boostUntil: 0,
    spinUntil: 0,
    lockedUntil: 0,
    shieldUntil: 0,
    lastEvent: null, // transient, sent once in state then cleared
  });
  socket.join(room.code);
  socket.data.roomCode = room.code;
}

function lobbyState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    mapId: room.mapId,
    cars: CARS,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, carId: p.carId, ready: p.ready,
    })),
  };
}

function broadcastLobby(room) {
  io.to(room.code).emit('lobby', lobbyState(room));
}

function removePlayer(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;

  if (room.players.size === 0) {
    if (room.loop) clearInterval(room.loop);
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastLobby(room);
  if (room.status === 'racing' || room.status === 'countdown') {
    checkRaceEnd(room);
  }
}

// ---------------------------------------------------------------------------
// Race lifecycle
// ---------------------------------------------------------------------------
function startRace(room) {
  const map = mapOf(room);
  room.status = 'countdown';
  room.hazards = [];
  room.pads = buildPads(map);
  room.results = [];
  room.firstFinishAt = 0;
  room.countdownEnd = Date.now() + 3000;
  room.raceStart = room.countdownEnd;

  // Grid: two staggered columns just behind the start line, facing along the track
  const players = [...room.players.values()];
  players.forEach((p, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const pt = RTMaps.pointAt(map.path, 1 - 0.018 * (row + 1));
    const nx = -pt.ty, ny = pt.tx;
    const off = col === 0 ? -32 : 32;
    p.x = pt.x + nx * off;
    p.y = pt.y + ny * off;
    p.angle = Math.atan2(pt.ty, pt.tx);
    p.speed = 0;
    p.item = null;
    p.lap = 0;
    p.nextSector = 1;
    p.cpCount = 0;
    p._u = 0;
    p.rank = i + 1;
    p.finished = false;
    p.retired = false;
    p.finishTime = 0;
    p.boostUntil = 0;
    p.spinUntil = 0;
    p.lockedUntil = 0;
    p.shieldUntil = 0;
    p.input = { up: false, down: false, left: false, right: false };
    p.lastEvent = null;
  });

  broadcastLobby(room);
  if (room.loop) clearInterval(room.loop);
  room.loop = setInterval(() => tick(room), 1000 / TICK_RATE);
}

function checkRaceEnd(room) {
  const racers = [...room.players.values()];
  if (racers.length === 0) return;
  const allDone = racers.every((p) => p.finished);
  const timeUp = room.firstFinishAt && Date.now() - room.firstFinishAt > 30000;
  const raceExpired = room.status === 'racing' && Date.now() - room.raceStart > 5 * 60 * 1000;
  if (allDone || timeUp || raceExpired) {
    room.status = 'finished';
    if (room.loop) { clearInterval(room.loop); room.loop = null; }
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

    io.to(room.code).emit('raceOver', { results });
    // reset ready flags for the next round
    room.players.forEach((p) => { p.ready = false; });
    broadcastLobby(room);
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
function rollItem(player, room) {
  // Players near the back get a better shot at aggressive items
  const behind = player.rank > room.players.size / 2;
  const weights = behind
    ? { boost: 3, cab: 1, lock: 2, shield: 1, oops: 3 }
    : { boost: 2, cab: 3, lock: 2, shield: 2, oops: 1 };
  const total = ITEMS.reduce((s, it) => s + weights[it], 0);
  let r = Math.random() * total;
  for (const it of ITEMS) {
    r -= weights[it];
    if (r <= 0) return it;
  }
  return 'boost';
}

function useItem(room, player) {
  if (!player.item || player.finished || room.status !== 'racing') return;
  const now = Date.now();
  const item = player.item;
  player.item = null;

  switch (item) {
    case 'boost':
      player.boostUntil = now + 2200;
      player.lastEvent = 'boost';
      break;
    case 'shield':
      player.shieldUntil = now + 5000;
      player.lastEvent = 'shield';
      break;
    case 'cab': {
      // Drop a CAB meeting hazard behind the car
      const hx = player.x - Math.cos(player.angle) * 55;
      const hy = player.y - Math.sin(player.angle) * 55;
      room.hazards.push({
        id: Math.random().toString(36).slice(2, 8),
        x: hx, y: hy,
        ownerId: player.id,
        bornAt: now,
        expiresAt: now + 30000,
      });
      player.lastEvent = 'cab';
      break;
    }
    case 'lock': {
      // Transport Lock: freeze the nearest car ahead of you
      const myScore = scoreOf(player);
      let target = null;
      let bestGap = Infinity;
      room.players.forEach((p) => {
        if (p.id === player.id || p.finished) return;
        const gap = scoreOf(p) - myScore;
        if (gap > 0 && gap < bestGap) { bestGap = gap; target = p; }
      });
      if (target && target.shieldUntil < now) {
        target.lockedUntil = now + 1600;
        target.lastEvent = 'locked';
      }
      player.lastEvent = 'lock';
      break;
    }
    case 'oops': {
      // OOPS! Everyone ahead of you spins out
      const myScore = scoreOf(player);
      room.players.forEach((p) => {
        if (p.id === player.id || p.finished) return;
        if (scoreOf(p) > myScore && p.shieldUntil < now) {
          p.spinUntil = now + 1300;
          p.lastEvent = 'spin';
        }
      });
      player.lastEvent = 'oops';
      break;
    }
  }
}

// Race progress: sectors hit + fractional progress toward the next sector.
function scoreOf(p) {
  let a = p._u * SECTORS - ((p.nextSector - 1 + SECTORS) % SECTORS);
  a = ((a % SECTORS) + SECTORS) % SECTORS;
  if (a > 2) a = 0; // driving backwards / cutting — no partial credit
  return p.cpCount + Math.min(1, a);
}

// ---------------------------------------------------------------------------
// Simulation tick
// ---------------------------------------------------------------------------
function tick(room) {
  const now = Date.now();

  if (room.status === 'countdown' && now >= room.countdownEnd) {
    room.status = 'racing';
    room.raceStart = now;
  }

  const racing = room.status === 'racing';
  const map = mapOf(room);
  const players = [...room.players.values()];

  for (const p of players) {
    if (p.retired) continue; // exited the race — car is off the track
    const spinning = p.spinUntil > now;
    const locked = p.lockedUntil > now;
    const canDrive = racing && !p.finished && !spinning && !locked;

    // --- throttle / brake ---
    if (canDrive) {
      if (p.input.up) p.speed += ACCEL * DT;
      else if (p.input.down) p.speed -= BRAKE * DT;
    }
    // friction
    p.speed -= p.speed * FRICTION * DT;
    if (Math.abs(p.speed) < 2 && !p.input.up && !p.input.down) p.speed = 0;

    // clamp
    const near = RTMaps.closest(map.path, p.x, p.y);
    p._u = near.u;
    const onTrack = near.dist <= map.halfWidth;
    let maxSpd = p.boostUntil > now ? BOOST_SPEED : MAX_SPEED;
    if (!onTrack) maxSpd = OFFTRACK_MAX;
    if (p.boostUntil > now && canDrive) p.speed = Math.max(p.speed, maxSpd * 0.85);
    p.speed = Math.min(maxSpd, Math.max(REVERSE_MAX, p.speed));

    // --- steering ---
    if (canDrive && Math.abs(p.speed) > 20) {
      const speedFactor = Math.min(1, Math.abs(p.speed) / 220);
      const dir = p.speed >= 0 ? 1 : -1;
      if (p.input.left) p.angle -= TURN_RATE * speedFactor * DT * dir;
      if (p.input.right) p.angle += TURN_RATE * speedFactor * DT * dir;
    }
    if (spinning) {
      p.angle += 10 * DT;
      p.speed *= 0.94;
    }

    // --- integrate ---
    p.x += Math.cos(p.angle) * p.speed * DT;
    p.y += Math.sin(p.angle) * p.speed * DT;

    // keep inside world bounds
    p.x = Math.min(1590, Math.max(10, p.x));
    p.y = Math.min(990, Math.max(10, p.y));

    if (!racing || p.finished) continue;

    // --- checkpoints & laps (sequential arc-length sectors) ---
    const s = Math.floor(p._u * SECTORS) % SECTORS;
    if (s === p.nextSector) {
      p.nextSector = (s + 1) % SECTORS;
      p.cpCount++;
      if (s === 0 && p.cpCount % SECTORS === 0) {
        p.lap = p.cpCount / SECTORS;
        if (p.lap >= TOTAL_LAPS) {
          p.finished = true;
          p.finishTime = now;
          p.lastEvent = 'finish';
          if (!room.firstFinishAt) room.firstFinishAt = now;
        }
      }
    }

    // --- item pads ---
    for (const pad of room.pads) {
      if (!pad.active) {
        if (now >= pad.respawnAt) pad.active = true;
        continue;
      }
      if (!p.item && Math.hypot(p.x - pad.x, p.y - pad.y) < 48) {
        pad.active = false;
        pad.respawnAt = now + 4000;
        p.item = rollItem(p, room);
        p.lastEvent = 'pickup';
      }
    }

    // --- hazards (CAB meetings) ---
    for (const hz of room.hazards) {
      if (hz.ownerId === p.id && now - hz.bornAt < 1200) continue;
      if (p.shieldUntil > now || p.spinUntil > now) continue;
      if (Math.hypot(p.x - hz.x, p.y - hz.y) < CAR_RADIUS + 24) {
        p.spinUntil = now + 1400;
        p.speed *= 0.2;
        p.lastEvent = 'cabbed';
        hz.expiresAt = 0; // consume
      }
    }
  }

  room.hazards = room.hazards.filter((hz) => hz.expiresAt > now);

  // --- car vs car collisions ---
  const active = players.filter((p) => !p.retired);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const minD = CAR_RADIUS * 2;
      if (d > 0 && d < minD) {
        const push = (minD - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        const avg = (a.speed + b.speed) / 2;
        a.speed = a.speed * 0.6 + avg * 0.3;
        b.speed = b.speed * 0.6 + avg * 0.3;
      }
    }
  }

  // --- ranking ---
  const order = players
    .slice()
    .sort((a, b) => {
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return scoreOf(b) - scoreOf(a);
    });
  order.forEach((p, i) => { p.rank = i + 1; });

  // --- broadcast ---
  io.to(room.code).emit('state', {
    status: room.status,
    mapId: room.mapId,
    countdownEnd: room.countdownEnd,
    raceStart: room.raceStart,
    now,
    totalLaps: TOTAL_LAPS,
    players: players.map((p) => {
      const ev = p.lastEvent;
      p.lastEvent = null;
      return {
        id: p.id, name: p.name, carId: p.carId,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        angle: Math.round(p.angle * 1000) / 1000,
        speed: Math.round(p.speed),
        item: p.item,
        lap: p.lap,
        rank: p.rank,
        finished: p.finished,
        retired: p.retired,
        boost: p.boostUntil > now,
        spin: p.spinUntil > now,
        locked: p.lockedUntil > now,
        shield: p.shieldUntil > now,
        event: ev,
      };
    }),
    hazards: room.hazards.map((h) => ({ id: h.id, x: h.x, y: h.y })),
    pads: room.pads.map((pd) => ({ id: pd.id, x: pd.x, y: pd.y, active: pd.active })),
  });

  checkRaceEnd(room);
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[conn] ${socket.id}`);
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

  socket.on('leaveRoom', () => removePlayer(socket));

  socket.on('selectCar', ({ carId }) => {
    console.log(`[selectCar] ${socket.id} carId=${carId}`);
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status === 'racing' || room.status === 'countdown') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    carId = Number(carId);
    if (!CARS.some((c) => c.id === carId)) return;
    const taken = [...room.players.values()].some((o) => o.id !== p.id && o.carId === carId);
    if (taken) return;
    p.carId = carId;
    broadcastLobby(room);
  });

  socket.on('selectMap', ({ mapId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.status === 'racing' || room.status === 'countdown') return;
    mapId = Number(mapId);
    if (!RTMaps.MAPS.some((m) => m.id === mapId)) return;
    room.mapId = mapId;
    broadcastLobby(room);
  });

  socket.on('toggleReady', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || (room.status !== 'lobby' && room.status !== 'finished')) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastLobby(room);
  });

  socket.on('startRace', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.id !== room.hostId) return;
    if (room.status === 'racing' || room.status === 'countdown') return;
    const players = [...room.players.values()];
    const othersReady = players.filter((p) => p.id !== room.hostId).every((p) => p.ready);
    if (!othersReady) return;
    startRace(room);
  });

  socket.on('input', (input) => {
    if (!limInput.allow(socket.id)) return; // dropped, not disconnected
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input = {
      up: !!input.up, down: !!input.down,
      left: !!input.left, right: !!input.right,
    };
  });

  socket.on('exitRace', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (room.status !== 'racing' || p.finished) return;
    console.log(`[exitRace] ${socket.id}`);
    p.finished = true;
    p.retired = true;
    p.finishTime = Date.now();
    p.speed = 0;
    p.item = null;
  });

  socket.on('useItem', () => {
    if (!limItem.allow(socket.id)) return;
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    useItem(room, p);
  });

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
});

server.listen(PORT, () => {
  console.log(`Rev-Trac Racer running at http://localhost:${PORT}`);
});
