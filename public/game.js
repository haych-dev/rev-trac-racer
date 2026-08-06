/* Rev-Trac Racer — client */
(() => {
  const socket = io();

  const WORLD_W = 1600, WORLD_H = 1000;
  const MAPS = RTMaps.MAPS;
  const BRAND_RED = '#ef4d57';

  const CARS = RTCars.CARS;

  const ITEM_INFO = {
    boost:  { label: '❯❯❯ Boost',   color: '#e63946' },
    cab:    { label: '\u{1F4CB} CAB',              color: '#f4a832' },
    lock:   { label: '\u{1F512} Lock',             color: '#7ab5ff' },
    shield: { label: '⚡ Emergency',           color: '#ffd60a' },
    oops:   { label: '\u{1F4A5} OOPS!',            color: '#ff5da2' },
  };

  const EVENT_TOASTS = {
    boost:  'CHEVRON BOOST!',
    shield: 'Emergency Change approved — shielded!',
    cab:    'CAB meeting scheduled behind you…',
    lock:   'Transport Lock deployed!',
    oops:   'OOPS! Everyone ahead spins out!',
    locked: '\u{1F512} Your transport is LOCKED!',
    spin:   '\u{1F4A5} OOPS’d! Change rejected!',
    cabbed: '\u{1F4CB} Stuck in CAB review!',
    pickup: null,
    finish: '\u{1F3C1} Change delivered to PROD!',
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $('screen-home'), lobby: $('screen-lobby'),
    game: $('screen-game'), results: $('screen-results'),
  };
  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
  }

  const canvas = $('game-canvas');
  const ctx = canvas.getContext('2d');

  // ---- Client state ----
  let myId = null;
  let lobby = null;
  let latestState = null;
  let smooth = new Map(); // id -> {x, y, angle}
  let lastResults = null;
  let raceActive = false;
  let currentMapId = 0;

  // The real Rev-Trac logo, drawn on each track's infield.
  const logoImg = new Image();
  logoImg.src = 'revtrac-logo.svg';

  socket.on('connect', () => { myId = socket.id; });

  // ---- Home ----
  const nameInput = $('name-input');
  nameInput.value = localStorage.getItem('rtr-name') || '';

  function driverName() {
    const n = nameInput.value.trim() || 'Racer';
    localStorage.setItem('rtr-name', n);
    return n;
  }

  $('btn-create').onclick = () => {
    socket.emit('createRoom', { name: driverName() }, (res) => {
      if (res.ok) showScreen('lobby');
      else $('home-error').textContent = res.error || 'Could not create room';
    });
  };

  $('btn-join').onclick = joinRoom;
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  function joinRoom() {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { $('home-error').textContent = 'Enter a 4-letter room code'; return; }
    socket.emit('joinRoom', { code, name: driverName() }, (res) => {
      if (res.ok) { $('home-error').textContent = ''; showScreen('lobby'); }
      else $('home-error').textContent = res.error || 'Could not join';
    });
  }

  // ---- Lobby ----
  socket.on('lobby', (data) => {
    lobby = data;
    if (typeof data.mapId === 'number') currentMapId = data.mapId;
    if (data.status === 'countdown' || data.status === 'racing') {
      if (!raceActive) { raceActive = true; showScreen('game'); }
      return;
    }
    renderLobby();
  });

  function drawMapPreview(cv, map, selected) {
    const c = cv.getContext('2d');
    const scale = Math.min(cv.width / WORLD_W, cv.height / WORLD_H);
    c.fillStyle = '#101722';
    c.fillRect(0, 0, cv.width, cv.height);
    c.save();
    c.translate((cv.width - WORLD_W * scale) / 2, (cv.height - WORLD_H * scale) / 2);
    c.scale(scale, scale);
    const path = new Path2D();
    map.pts.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
    path.closePath();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.lineWidth = map.halfWidth * 2;
    c.strokeStyle = selected ? '#4a5570' : '#39415a';
    c.stroke(path);
    c.lineWidth = 6;
    c.setLineDash([26, 30]);
    c.strokeStyle = selected ? BRAND_RED : 'rgba(255,255,255,0.3)';
    c.stroke(path);
    c.setLineDash([]);
    const st = RTMaps.pointAt(map.path, 0);
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(st.x, st.y, 22, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function renderMapGrid(isHost) {
    const grid = $('map-grid');
    grid.innerHTML = '';
    MAPS.forEach((map) => {
      const div = document.createElement('div');
      div.className = 'map-card';
      if (map.id === lobby.mapId) div.classList.add('selected');
      if (!isHost) div.classList.add('readonly');
      const cv = document.createElement('canvas');
      cv.width = 240; cv.height = 150;
      drawMapPreview(cv, map, map.id === lobby.mapId);
      div.appendChild(cv);
      const name = document.createElement('div');
      name.className = 'mname';
      name.textContent = map.name;
      const desc = document.createElement('div');
      desc.className = 'mdesc';
      desc.textContent = map.desc;
      div.appendChild(name);
      div.appendChild(desc);
      if (isHost) div.onclick = () => socket.emit('selectMap', { mapId: map.id });
      grid.appendChild(div);
    });
    $('map-hint').textContent = isHost ? '' : `(host picks — ${MAPS.find((m) => m.id === lobby.mapId).name})`;
  }

  function renderLobby() {
    if (!lobby) return;
    $('lobby-code').textContent = lobby.code;
    const me = lobby.players.find((p) => p.id === myId);
    const isHost = lobby.hostId === myId;

    renderMapGrid(isHost);

    // car grid
    const grid = $('car-grid');
    grid.innerHTML = '';
    CARS.forEach((car) => {
      const owner = lobby.players.find((p) => p.carId === car.id);
      const div = document.createElement('div');
      div.className = 'car-card';
      if (owner && owner.id === myId) div.classList.add('selected');
      else if (owner) div.classList.add('taken');
      div.innerHTML =
        `<div class="swatch" style="background:${car.color}"></div>` +
        `<div class="cname">${car.name}</div>` +
        `<div class="owner">${owner ? esc(owner.name) : ''}</div>`;
      if (!owner || owner.id === myId) {
        div.onclick = () => socket.emit('selectCar', { carId: car.id });
      }
      grid.appendChild(div);
    });

    // player list
    const list = $('player-list');
    list.innerHTML = '';
    $('player-count').textContent = `(${lobby.players.length}/8)`;
    lobby.players.forEach((p) => {
      const car = CARS[p.carId] || CARS[0];
      const li = document.createElement('li');
      const tags = [];
      if (p.id === lobby.hostId) tags.push('<span class="tag host">HOST</span>');
      tags.push(p.ready ? '<span class="tag ready">READY</span>' : '<span class="tag">WAITING</span>');
      li.innerHTML =
        `<span class="dot" style="background:${car.color}"></span>` +
        `<span class="pname">${esc(p.name)}${p.id === myId ? ' (you)' : ''}</span>` +
        tags.join('');
      list.appendChild(li);
    });

    // actions
    $('btn-ready').textContent = me && me.ready ? 'Not Ready' : 'Ready Up';
    $('btn-ready').style.display = isHost ? 'none' : '';
    $('btn-start').style.display = isHost ? '' : 'none';
    if (isHost) {
      const othersReady = lobby.players.filter((p) => p.id !== lobby.hostId).every((p) => p.ready);
      $('btn-start').disabled = !othersReady;
      $('lobby-hint').textContent = othersReady
        ? (lobby.players.length === 1 ? 'Solo test lap — or share the room code and wait for rivals.' : 'All drivers ready. Hit Start Race!')
        : 'Waiting for everyone to ready up…';
    } else {
      $('lobby-hint').textContent = 'Waiting for the host to start the race…';
    }
  }

  $('btn-ready').onclick = () => socket.emit('toggleReady');
  $('btn-start').onclick = () => socket.emit('startRace');
  $('btn-leave').onclick = () => {
    socket.emit('leaveRoom');
    lobby = null;
    showScreen('home');
  };
  $('btn-back-lobby').onclick = () => showScreen('lobby');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- Race networking ----
  socket.on('state', (state) => {
    latestState = state;
    if (typeof state.mapId === 'number') currentMapId = state.mapId;
    if ((state.status === 'countdown' || state.status === 'racing') && !raceActive) {
      raceActive = true;
      smooth.clear();
      showScreen('game');
    }
    // event toasts for me
    const me = state.players.find((p) => p.id === myId);
    if (me && me.event && EVENT_TOASTS[me.event]) showToast(EVENT_TOASTS[me.event]);
  });

  socket.on('raceOver', ({ results }) => {
    raceActive = false;
    lastResults = results;
    renderResults();
    setTimeout(() => showScreen('results'), 1200);
  });

  socket.on('disconnect', () => {
    raceActive = false;
    lobby = null;
    showScreen('home');
    $('home-error').textContent = 'Disconnected from server';
  });

  function renderResults() {
    const tbody = $('results-table').querySelector('tbody');
    tbody.innerHTML = '';
    (lastResults || []).forEach((r, i) => {
      const car = CARS[r.carId] || CARS[0];
      const tr = document.createElement('tr');
      if (i === 0) tr.classList.add('first');
      const t = r.finished ? formatTime(r.time) : `DNF (lap ${r.laps + 1})`;
      tr.innerHTML =
        `<td>${i + 1}</td>` +
        `<td>${esc(r.name)}</td>` +
        `<td><span class="res-swatch" style="background:${car.color}"></span>${car.name}</td>` +
        `<td>${t}</td>`;
      tbody.appendChild(tr);
    });
  }

  function formatTime(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const t = Math.floor((ms % 1000) / 100);
    return `${m}:${String(s).padStart(2, '0')}.${t}`;
  }

  // ---- Input ----
  const input = { up: false, down: false, left: false, right: false };
  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
  };
  window.addEventListener('keydown', (e) => {
    if (!raceActive) return;
    if (e.code === 'Space') { e.preventDefault(); socket.emit('useItem'); return; }
    const k = KEYMAP[e.code];
    if (k && !input[k]) { input[k] = true; socket.emit('input', input); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (k && input[k]) { input[k] = false; socket.emit('input', input); }
  });

  // ---- Toast ----
  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  // ---- Canvas sizing ----
  function fitCanvas() {
    const scale = Math.min(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H);
    canvas.style.width = `${WORLD_W * scale}px`;
    canvas.style.height = `${WORLD_H * scale}px`;
  }
  window.addEventListener('resize', fitCanvas);
  fitCanvas();

  // ---- Rendering ----
  const trackPathCache = new Map(); // mapId -> Path2D

  function trackPath2D(map) {
    let p = trackPathCache.get(map.id);
    if (!p) {
      p = new Path2D();
      map.pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
      p.closePath();
      trackPathCache.set(map.id, p);
    }
    return p;
  }

  function drawTrack(map) {
    // grass
    ctx.fillStyle = '#14501f';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    for (let y = 0; y < WORLD_H; y += 80) ctx.fillRect(0, y, WORLD_W, 40);

    const path = trackPath2D(map);
    const hw = map.halfWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // kerbs (red/white dashed edge)
    ctx.lineWidth = hw * 2 + 16;
    ctx.strokeStyle = '#cf3540';
    ctx.stroke(path);
    ctx.setLineDash([26, 26]);
    ctx.strokeStyle = '#f1f3f5';
    ctx.stroke(path);
    ctx.setLineDash([]);

    // asphalt
    ctx.lineWidth = hw * 2;
    ctx.strokeStyle = '#3a3f4a';
    ctx.stroke(path);

    // centerline dashes
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([30, 34]);
    ctx.stroke(path);
    ctx.setLineDash([]);

    // start / finish line: checkered strip perpendicular to the track at u=0
    const st = RTMaps.pointAt(map.path, 0);
    const sq = 15;
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(Math.atan2(st.ty, st.tx));
    for (let row = 0; row < Math.ceil((hw * 2) / sq); row++) {
      for (let col = 0; col < 2; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#fff' : '#111';
        ctx.fillRect((col - 2) * sq, -hw + row * sq, sq, Math.min(sq, hw * 2 - row * sq));
      }
    }
    ctx.restore();

    // Rev-Trac logo on the infield
    const lg = map.logo;
    if (logoImg.complete && logoImg.naturalWidth) {
      const lw = lg.w;
      const lh = lw * (logoImg.naturalHeight / logoImg.naturalWidth);
      // white plate behind the logo so the navy wordmark reads on grass
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#f4f5f7';
      roundRect(lg.x - lw / 2 - 18, lg.y - lh / 2 - 14, lw + 36, lh + 28, 14);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.drawImage(logoImg, lg.x - lw / 2, lg.y - lh / 2, lw, lh);
      ctx.restore();
    }
    ctx.font = '800 26px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const lgH = lg.w * 0.262;
    ctx.fillText(map.name.toUpperCase(), lg.x, lg.y + lgH / 2 + 46);
  }

  function drawPads(pads) {
    for (const pad of pads) {
      ctx.save();
      ctx.translate(pad.x, pad.y);
      if (pad.active) {
        ctx.fillStyle = '#1b2233';
        ctx.strokeStyle = BRAND_RED;
        ctx.lineWidth = 3;
        roundRect(-22, -22, 44, 44, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#ffd60a';
        ctx.font = '900 30px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, 2);
      } else {
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = BRAND_RED;
        ctx.lineWidth = 2;
        roundRect(-22, -22, 44, 44, 8);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function drawHazards(hazards) {
    for (const hz of hazards) {
      ctx.save();
      ctx.translate(hz.x, hz.y);
      // CAB meeting sign
      ctx.fillStyle = '#f4a832';
      ctx.strokeStyle = '#8a5a10';
      ctx.lineWidth = 3;
      roundRect(-24, -18, 48, 36, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#3b2a05';
      ctx.font = '900 16px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CAB', 0, 1);
      ctx.restore();
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCar(p, t) {
    const s = smooth.get(p.id) || { x: p.x, y: p.y, angle: p.angle };
    const car = CARS[p.carId] || CARS[0];

    ctx.save();
    ctx.translate(s.x, s.y);

    // shield ring
    if (p.shield) {
      ctx.strokeStyle = 'rgba(255,214,10,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 30 + Math.sin(t / 90) * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.rotate(s.angle);

    // boost flames
    if (p.boost) {
      const flare = 12 + Math.random() * 14;
      const grad = ctx.createLinearGradient(-20, 0, -20 - flare, 0);
      grad.addColorStop(0, 'rgba(255,180,40,0.95)');
      grad.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(-19, -7);
      ctx.lineTo(-19 - flare, 0);
      ctx.lineTo(-19, 7);
      ctx.closePath();
      ctx.fill();
    }

    // body
    ctx.fillStyle = car.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    roundRect(-20, -12, 40, 24, 7);
    ctx.fill();
    ctx.stroke();
    // cockpit
    ctx.fillStyle = 'rgba(15,18,28,0.85)';
    roundRect(-4, -8, 15, 16, 4);
    ctx.fill();
    // nose stripe
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(13, -10, 4, 20);

    ctx.rotate(-s.angle);

    // status icons
    ctx.font = '700 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    if (p.locked) ctx.fillText('\u{1F512}', 0, -32);
    if (p.spin) ctx.fillText('\u{1F4AB}', 0, -32);

    // name
    ctx.font = '700 14px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3;
    const label = p.name + (p.finished ? ' \u{1F3C1}' : '');
    ctx.strokeText(label, 0, 40);
    ctx.fillText(label, 0, 40);

    ctx.restore();
  }

  function updateSmoothing(dtMs) {
    if (!latestState) return;
    const k = 1 - Math.exp(-dtMs / 55);
    for (const p of latestState.players) {
      let s = smooth.get(p.id);
      if (!s || Math.hypot(p.x - s.x, p.y - s.y) > 220) {
        s = { x: p.x, y: p.y, angle: p.angle };
        smooth.set(p.id, s);
      }
      s.x += (p.x - s.x) * k;
      s.y += (p.y - s.y) * k;
      let da = p.angle - s.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      s.angle += da * k;
    }
    for (const id of [...smooth.keys()]) {
      if (!latestState.players.some((p) => p.id === id)) smooth.delete(id);
    }
  }

  function drawHUD() {
    const st = latestState;
    const me = st && st.players.find((p) => p.id === myId);
    if (!st || !me) return;

    $('hud-lap').textContent = `Lap ${Math.min(me.lap + 1, st.totalLaps)}/${st.totalLaps}`;
    $('hud-pos').textContent = ordinal(me.rank) + ` of ${st.players.length}`;
    const item = me.item ? ITEM_INFO[me.item] : null;
    $('hud-item').textContent = item ? item.label + '  [Space]' : 'No item';
    $('hud-item').style.color = item ? item.color : '#9aa3b8';

    if (st.status === 'racing') {
      $('hud-time').textContent = formatTime(Math.max(0, st.now - st.raceStart));
    } else {
      $('hud-time').textContent = '0:00.0';
    }

    // countdown overlay
    const cd = $('countdown');
    if (st.status === 'countdown') {
      const remain = Math.ceil((st.countdownEnd - st.now) / 1000);
      cd.textContent = remain > 0 ? remain : 'GO!';
    } else if (st.status === 'racing' && st.now - st.raceStart < 900) {
      cd.textContent = 'GO!';
    } else {
      cd.textContent = '';
    }
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---- Main loop ----
  let lastFrame = performance.now();
  function frame(t) {
    const dtMs = Math.min(100, t - lastFrame);
    lastFrame = t;

    if (screens.game.classList.contains('active') && latestState) {
      updateSmoothing(dtMs);
      drawTrack(MAPS[currentMapId] || MAPS[0]);
      drawPads(latestState.pads);
      drawHazards(latestState.hazards);
      // draw finished cars first so active racers render on top
      const sorted = latestState.players.slice().sort((a, b) => Number(b.finished) - Number(a.finished));
      for (const p of sorted) drawCar(p, t);
      drawHUD();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Dev/test hook: render a single frame on demand (headless tabs never fire rAF).
  window.__rtrDrawFrame = () => frame(performance.now());
})();
