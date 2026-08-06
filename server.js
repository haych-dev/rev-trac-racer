const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/debug/rooms', (req, res) => {
  res.json([...rooms.values()].map((r) => ({
    code: r.code,
    status: r.status,
    hostId: r.hostId,
    players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, carId: p.carId, ready: p.ready })),
  })));
});

const server = http.createServer(app);
const io = new Server(server);

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

const CARS = [
  { id: 0, name: 'Prod Express',      color: '#e63946' },
  { id: 1, name: 'Dev Demon',         color: '#9d4edd' },
  { id: 2, name: 'QA Quattro',        color: '#2a9d8f' },
  { id: 3, name: 'Sandbox Speedster', color: '#f4832b' },
  { id: 4, name: 'Transport Titan',   color: '#3a86ff' },
  { id: 5, name: 'Hotfix Hurricane',  color: '#ffd60a' },
  { id: 6, name: 'Release Rocket',    color: '#57cc3f' },
  { id: 7, name: 'Go-Live GT',        color: '#ff5da2' },
];

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
const BOOST_SPEED = 660;
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
    const results = racers
      .map((p) => ({
        name: p.name,
        carId: p.carId,
        finished: p.finished,
        time: p.finished ? p.finishTime - room.raceStart : null,
        laps: p.lap,
      }))
      .sort((a, b) => {
        if (a.finished && b.finished) return a.time - b.time;
        if (a.finished) return -1;
        if (b.finished) return 1;
        return b.laps - a.laps;
      });
    room.results = results;
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
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
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
  socket.on('createRoom', ({ name }, cb) => {
    console.log(`[createRoom] ${socket.id} name=${name}`);
    if (socket.data.roomCode) removePlayer(socket);
    const room = createRoom(socket, name);
    cb({ ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    console.log(`[joinRoom] ${socket.id} code=${code} name=${name}`);
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'Room is full (8 max)' });
    if (room.status !== 'lobby' && room.status !== 'finished') {
      return cb({ ok: false, error: 'Race in progress — try again shortly' });
    }
    if (socket.data.roomCode) removePlayer(socket);
    addPlayer(room, socket, name);
    cb({ ok: true, code: room.code });
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
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input = {
      up: !!input.up, down: !!input.down,
      left: !!input.left, right: !!input.right,
    };
  });

  socket.on('useItem', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    useItem(room, p);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} reason=${reason}`);
    removePlayer(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Rev-Trac Racer running at http://localhost:${PORT}`);
});
