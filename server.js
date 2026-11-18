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

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const LAP_CHOICES = [1, 3, 5, 8, 12];
const BOT_NAMES = [
  'Legacy Larry', 'Waterfall Wendy', 'Friday Deploy Fred', 'Spreadsheet Steve',
  'Manual Mandy', 'Hotfix Harry', 'Cowboy Carl', 'Rubber-Stamp Rita',
];

const records = new Records(process.env.RECORDS_FILE || path.join(__dirname, 'data', 'records.json'));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/records', (req, res) => res.json(records.summary()));

const server = http.createServer(app);
const io = new Server(server);

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
    players: new Map(),     // socket.id -> { id, name, carId, ready }
    standings: new Map(),   // lowercased name -> { name, bot, carId, points, wins, races }
    race: null,
    loop: null,
    raceNo: 0,
  };
  rooms.set(room.code, room);
  addPlayer(room, socket, name);
  return room;
}

function cleanName(room, raw) {
  let name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Racer';
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  BOT_NAMES.forEach((b) => taken.add(b.toLowerCase()));
  let candidate = name, n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${name.slice(0, 14)} ${n++}`;
  return candidate;
}

function addPlayer(room, socket, name) {
  const used = new Set([...room.players.values()].map((p) => p.carId));
  const free = CARS.filter((c) => !used.has(c.id));
  room.players.set(socket.id, {
    id: socket.id,
    name: cleanName(room, name),
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
    players: [...room.players.values()],
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
function startRace(room) {
  const s = room.settings;
  const humans = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, carId: p.carId, bot: null }));
  const usedCars = new Set(humans.map((h) => h.carId));
  const freeCars = CARS.filter((c) => !usedCars.has(c.id)).sort(() => Math.random() - 0.5);
  const bots = BOT_NAMES.slice(0, botCount(room)).map((name, i) => {
    const prev = room.standings.get(name.toLowerCase());
    // a bot keeps its car between races when nobody has taken it
    const keep = prev && !usedCars.has(prev.carId) ? prev.carId : null;
    const carId = keep != null ? keep : (freeCars.pop() || CARS[0]).id;
    usedCars.add(carId);
    const idx = freeCars.findIndex((c) => c.id === carId);
    if (idx >= 0) freeCars.splice(idx, 1);
    return { id: `bot:${i}`, name, carId, bot: { skill: s.botSkill } };
  });

  // Reverse-championship grid: the points leader starts at the back.
  const pts = (e) => (room.standings.get(e.name.toLowerCase()) || { points: 0 }).points;
  const entrants = [...humans, ...bots]
    .map((e) => ({ e, key: pts(e) + Math.random() * 0.5 }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.e);

  room.race = new Race({ mapId: s.mapId, laps: s.laps, mode: s.mode, chaos: s.chaos, entrants });
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
  clearInterval(room.loop);
  room.loop = null;
  room.race = null;
  room.status = 'lobby';

  const rows = race.results();
  const awards = race.awards();
  const fastest = awards.find((a) => a.key === 'fastestLap');
  for (const r of rows) {
    // everyone scores for where they ended up; quitting scores nothing
    r.points = r.out === 'retired' ? 0 : (POINTS[r.pos - 1] || 0);
    r.fastest = !!fastest && fastest.i === r.i;
    if (r.fastest && r.points > 0) r.points += FASTEST_LAP_BONUS;

    const key = r.name.toLowerCase();
    const st = room.standings.get(key) || { name: r.name, bot: r.bot, carId: r.carId, points: 0, wins: 0, races: 0 };
    st.carId = r.carId;
    st.points += r.points;
    st.races++;
    if (r.pos === 1) st.wins++;
    room.standings.set(key, st);
  }

  const broken = records.submit({ mapId: race.map.id, laps: race.laps, mode: race.mode }, rows);
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
  const ack = (cb, payload) => { if (typeof cb === 'function') cb(payload); };

  socket.on('createRoom', (msg, cb) => {
    if (socket.data.roomCode) removePlayer(socket);
    const room = createRoom(socket, msg && msg.name);
    console.log(`[room ${room.code}] created by ${room.players.get(socket.id).name}`);
    ack(cb, { ok: true, code: room.code });
    broadcastLobby(room);
  });

  socket.on('joinRoom', (msg, cb) => {
    const room = rooms.get(String((msg && msg.code) || '').trim().toUpperCase());
    if (!room) return ack(cb, { ok: false, error: 'Room not found' });
    if (room.players.size >= MAX_PLAYERS) return ack(cb, { ok: false, error: 'Room is full (8 max)' });
    if (socket.data.roomCode) removePlayer(socket);
    addPlayer(room, socket, msg.name);
    console.log(`[room ${room.code}] ${room.players.get(socket.id).name} joined`);
    ack(cb, { ok: true, code: room.code });
    broadcastLobby(room);
    // arriving mid-race: hand over what is needed to spectate
    if (room.race) socket.emit('raceStart', { ...room.race.staticInfo(), spectate: true });
  });

  socket.on('leaveRoom', () => removePlayer(socket));

  socket.on('selectCar', (msg) => {
    const { room, player } = ctx(socket);
    if (!room || !player || room.status !== 'lobby') return;
    const carId = Number(msg && msg.carId);
    if (!CARS.some((c) => c.id === carId)) return;
    if ([...room.players.values()].some((o) => o.id !== player.id && o.carId === carId)) return;
    player.carId = carId;
    broadcastLobby(room);
  });

  socket.on('toggleReady', () => {
    const { room, player } = ctx(socket);
    if (!room || !player || room.status !== 'lobby') return;
    player.ready = !player.ready;
    broadcastLobby(room);
  });

  socket.on('settings', (patch) => {
    const { room } = ctx(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'lobby' || !patch) return;
    const s = room.settings;
    if (patch.mapId !== undefined && RTMaps.MAPS.some((m) => m.id === Number(patch.mapId))) s.mapId = Number(patch.mapId);
    if (patch.laps !== undefined && LAP_CHOICES.includes(Number(patch.laps))) s.laps = Number(patch.laps);
    if (patch.mode === 'race' || patch.mode === 'elimination') s.mode = patch.mode;
    if (patch.chaos !== undefined) s.chaos = !!patch.chaos;
    if (patch.bots !== undefined) s.bots = Math.max(0, Math.min(MAX_PLAYERS - 1, Number(patch.bots) | 0));
    if (patch.botSkill !== undefined && SKILLS[patch.botSkill]) s.botSkill = patch.botSkill;
    broadcastLobby(room);
  });

  socket.on('resetStandings', () => {
    const { room } = ctx(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'lobby') return;
    room.standings.clear();
    room.raceNo = 0;
    broadcastLobby(room);
  });

  socket.on('startRace', () => {
    const { room } = ctx(socket);
    if (!room || socket.id !== room.hostId || room.status !== 'lobby') return;
    const others = [...room.players.values()].filter((p) => p.id !== room.hostId);
    if (!others.every((p) => p.ready)) return;
    startRace(room);
  });

  socket.on('input', (input) => {
    const { room } = ctx(socket);
    if (room && room.race) room.race.setInput(socket.id, input);
  });
  socket.on('useItem', () => {
    const { room } = ctx(socket);
    if (room && room.race) room.race.useItem(socket.id);
  });
  socket.on('honk', () => {
    const { room } = ctx(socket);
    if (room && room.race) room.race.honk(socket.id);
  });
  socket.on('resetCar', () => {
    const { room } = ctx(socket);
    if (room && room.race) room.race.resetCar(socket.id);
  });
  socket.on('exitRace', () => {
    const { room } = ctx(socket);
    if (room && room.race) room.race.retire(socket.id);
  });

  socket.on('disconnect', () => removePlayer(socket));
});

server.listen(PORT, () => {
  console.log(`Rev-Trac Racer running at http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) console.log(`  colleagues on your network: http://${ni.address}:${PORT}`);
    }
  }
});
