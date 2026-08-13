/* Rev-Trac Racer — client */
(() => {
  // Deliberately not connected yet: the handshake resolves identity from the
  // profile cookie, and that cookie only exists once /api/profile/me has
  // responded. bootstrap() assigns this and then wires the handlers.
  let socket = null;
  let profile = { id: null, name: null };

  const WORLD_W = 1600, WORLD_H = 1000;
  const MAPS = RTMaps.MAPS;
  const BRAND_RED = '#ef4d57';

  const CARS = RTCars.CARS;

  const ITEM_INFO = {
    boost:  { label: '❯❯❯ Boost',   color: '#d63a44' },
    cab:    { label: '\u{1F4CB} CAB',              color: '#c07c00' },
    lock:   { label: '\u{1F512} Lock',             color: '#2d6fd6' },
    shield: { label: '⚡ Emergency',           color: '#d4a400' },
    oops:   { label: '\u{1F4A5} OOPS!',            color: '#d6336c' },
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
    leaderboard: $('screen-leaderboard'),
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
  let exitedRace = false; // player bailed out of the current race
  let lastCountdownText = ''; // so the countdown only rebuilds when it ticks over
  let currentMapId = 0;

  // The real Rev-Trac logo, drawn on each track's infield.
  const logoImg = new Image();
  // Drop any layer painted before the wordmark arrived. The handler cannot fire
  // until module evaluation finishes, so referencing trackLayer (declared further
  // down) is safe.
  logoImg.onload = function () { trackLayer = null; };
  logoImg.src = 'revtrac-logo.svg';

  // ---- Car body illustrations ----
  // Every body is drawn centered on the origin pointing +x, within roughly
  // 48x26 world units, on any 2d context (race canvas or lobby cards).
  const TIRE = '#16181d';
  const DARKGLASS = 'rgba(15,18,28,0.85)';
  const SHADE = 'rgba(0,0,0,0.3)';
  const ACCENT = 'rgba(255,255,255,0.55)';

  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function poly(c, pts) {
    c.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
    c.closePath();
  }

  function drawCarBody(c, car) {
    const col = car.color;
    c.save();
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    c.lineWidth = 2;

    switch (car.body) {
      case 'formula': {
        // wheels
        c.fillStyle = TIRE;
        c.fillRect(7, -13.5, 8, 5); c.fillRect(7, 8.5, 8, 5);
        c.fillRect(-17, -14, 9, 5.5); c.fillRect(-17, 8.5, 9, 5.5);
        // rear wing
        c.fillStyle = col;
        rr(c, -23, -12, 4.5, 24, 1.5); c.fill(); c.stroke();
        // front wing
        rr(c, 19.5, -11, 4, 22, 1.5); c.fill(); c.stroke();
        // narrow body + nose
        rr(c, -17, -5.5, 34, 11, 5); c.fill(); c.stroke();
        poly(c, [[15, -4.5], [23, 0], [15, 4.5]]); c.fill(); c.stroke();
        // cockpit
        c.fillStyle = DARKGLASS;
        c.beginPath(); c.arc(-3, 0, 4, 0, Math.PI * 2); c.fill();
        c.fillStyle = ACCENT;
        c.fillRect(9, -1.5, 7, 3);
        break;
      }
      case 'muscle': {
        c.fillStyle = '#22262e';
        rr(c, -23, -12, 4, 24, 1.5); c.fill(); c.stroke(); // spoiler
        c.fillStyle = col;
        rr(c, -21, -11, 42, 22, 6); c.fill(); c.stroke();
        c.fillStyle = DARKGLASS;
        rr(c, -7, -8, 16, 16, 4); c.fill();
        c.fillStyle = SHADE;
        rr(c, 9, -3.5, 8, 7, 2); c.fill(); // hood scoop
        c.fillStyle = ACCENT;
        c.fillRect(10, -6.5, 10, 3); c.fillRect(10, 3.5, 10, 3); // twin stripes
        break;
      }
      case 'van': {
        c.fillStyle = col;
        rr(c, -22, -12, 44, 24, 5); c.fill(); c.stroke();
        c.fillStyle = SHADE;
        rr(c, -17, -8.5, 23, 17, 3); c.fill(); // roof panel
        c.fillStyle = DARKGLASS;
        rr(c, 10, -9.5, 6.5, 19, 2); c.fill(); // windshield
        c.fillStyle = ACCENT;
        c.fillRect(19.5, -7, 2.5, 14); // bumper
        break;
      }
      case 'kart': {
        c.fillStyle = TIRE;
        c.fillRect(6, -11.5, 7, 4.5); c.fillRect(6, 7, 7, 4.5);
        c.fillRect(-13, -11.5, 7, 4.5); c.fillRect(-13, 7, 7, 4.5);
        c.fillStyle = col;
        rr(c, -13, -7, 27, 14, 4); c.fill(); c.stroke();
        c.fillStyle = SHADE;
        c.fillRect(10, -6, 3, 12); // nose bar
        c.fillStyle = DARKGLASS;
        c.beginPath(); c.arc(-2, 0, 4.5, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#dfe3ea';
        c.beginPath(); c.arc(-2, 0, 2.6, 0, Math.PI * 2); c.fill(); // helmet
        break;
      }
      case 'ute': {
        c.fillStyle = col;
        rr(c, -21, -10.5, 21, 21, 3); c.fill(); c.stroke(); // bed
        c.fillStyle = SHADE;
        rr(c, -19, -8.5, 17, 17, 2); c.fill(); // bed interior
        c.fillStyle = ACCENT;
        c.globalAlpha = 0.35;
        c.fillRect(-16, -8.5, 2, 17); c.fillRect(-9, -8.5, 2, 17); // slats
        c.globalAlpha = 1;
        c.fillStyle = col;
        rr(c, 0, -11, 22, 22, 4); c.fill(); c.stroke(); // cab
        c.fillStyle = DARKGLASS;
        rr(c, 2.5, -8, 5.5, 16, 2); c.fill(); // windshield
        break;
      }
      case 'roadster': {
        c.fillStyle = '#22262e';
        rr(c, -23, -7, 3.5, 14, 1.5); c.fill(); c.stroke(); // tail spoiler
        c.fillStyle = col;
        c.beginPath(); c.ellipse(0, 0, 21, 10.5, 0, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = DARKGLASS;
        c.beginPath(); c.ellipse(-4, 0, 6.5, 5.5, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = ACCENT;
        rr(c, 3.5, -7, 3, 14, 1.5); c.fill(); // windshield
        break;
      }
      case 'beetle': {
        c.fillStyle = col;
        c.beginPath(); c.ellipse(0, 0, 18.5, 12, 0, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = SHADE;
        c.beginPath(); c.ellipse(-1.5, 0, 10.5, 8.5, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = DARKGLASS;
        rr(c, 7, -6.5, 3, 13, 1.5); c.fill(); // windshield
        c.fillStyle = ACCENT;
        c.beginPath(); c.arc(16, -5.5, 1.8, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(16, 5.5, 1.8, 0, Math.PI * 2); c.fill(); // headlights
        break;
      }
      case 'wedge':
      default: {
        c.fillStyle = '#22262e';
        rr(c, -24, -12, 3.5, 24, 1.5); c.fill(); c.stroke(); // spoiler
        c.fillStyle = col;
        poly(c, [[24, 0], [12, -10], [-16, -11], [-21, -6], [-21, 6], [-16, 11], [12, 10]]);
        c.fill(); c.stroke();
        c.fillStyle = DARKGLASS;
        rr(c, -6, -5.5, 12, 11, 3); c.fill();
        c.fillStyle = ACCENT;
        c.fillRect(10, -1.5, 9, 3);
        break;
      }
    }
    c.restore();
  }

  // ---- Home ----
  // The name lives on the server profile now — no localStorage copy, so there
  // is only ever one answer to "who am I".
  function renderNameGate() {
    const claimed = !!profile.name;
    $('name-input').value = profile.name || '';
    $('btn-create').disabled = !claimed;
    $('btn-join').disabled = !claimed;
    // The code field must move with the button: its Enter handler calls
    // joinRoom() directly, so a live input is a route around the whole gate.
    $('code-input').disabled = !claimed;
    $('name-status').textContent = claimed
      ? `Racing as ${profile.name}`
      : 'Pick a name to start racing';
    $('name-status').className = claimed ? 'hint ok' : 'hint';
    if (claimed) $('home-error').textContent = '';
  }

  async function claimName() {
    const name = $('name-input').value.trim();
    $('name-status').textContent = 'Saving…';
    $('name-status').className = 'hint';
    try {
      const res = await fetch('/api/profile/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = await res.json();
      if (!res.ok) {
        $('name-status').textContent = body.error || 'Could not save that name';
        $('name-status').className = 'hint error';
        return;
      }
      profile.name = body.name;
      renderNameGate();
    } catch {
      $('name-status').textContent = 'Network error — try again';
      $('name-status').className = 'hint error';
    }
  }

  $('btn-claim').onclick = claimName;
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') claimName(); });

  // The server refuses every room action until a name is claimed. If that
  // happens the local profile is stale, so drop back to the gate.
  function handleRoomError(res) {
    if (res.error === 'Claim a name first' || res.error === 'No profile' || res.error === 'Invalid profile') {
      profile.name = null;
      showScreen('home');
      renderNameGate();
      $('home-error').textContent = 'Please save a driver name first.';
      return true;
    }
    return false;
  }

  // Belt and braces with the disabled inputs above. `socket` is null until
  // bootstrap resolves, and stays null if it fails, so any path that reaches an
  // emit must survive that rather than throwing a bare TypeError at the user.
  function socketReady() {
    if (socket) return true;
    $('home-error').textContent = 'Still connecting — try again in a moment.';
    return false;
  }

  $('btn-create').onclick = () => {
    if (!socketReady()) return;
    socket.emit('createRoom', {}, (res) => {
      if (!res.ok) {
        if (!handleRoomError(res)) $('home-error').textContent = res.error || 'Could not create room';
        return;
      }
      $('home-error').textContent = '';
      showScreen('lobby');
    });
  };

  $('btn-join').onclick = joinRoom;
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  function joinRoom() {
    if (!socketReady()) return;
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { $('home-error').textContent = 'Enter a 4-letter room code'; return; }
    socket.emit('joinRoom', { code }, (res) => {
      if (!res.ok) {
        if (!handleRoomError(res)) $('home-error').textContent = res.error || 'Could not join';
        return;
      }
      $('home-error').textContent = '';
      showScreen('lobby');
    });
  }

  // ---- How to play ----
  // Rendered into both the home screen and the lobby; keep it one template so
  // the two copies cannot drift apart.
  const CONTROLS_HTML = `
    <h3>Controls</h3>
    <table class="controls-table">
      <tr><td>Accelerate / brake</td><td><kbd>W</kbd><kbd>S</kbd> or <kbd>&uarr;</kbd><kbd>&darr;</kbd></td></tr>
      <tr><td>Steer</td><td><kbd>A</kbd><kbd>D</kbd> or <kbd>&larr;</kbd><kbd>&rarr;</kbd></td></tr>
      <tr><td>Use powerup</td><td><kbd>Space</kbd></td></tr>
      <tr><td>Exit race</td><td><kbd>Esc</kbd></td></tr>
    </table>
    <h3>Powerups</h3>
    <ul>
      <li><b class="c-boost">&#10095;&#10095;&#10095; Chevron Boost</b> — hit warp speed for a couple of seconds</li>
      <li><b class="c-cab">&#128203; CAB Meeting</b> — drop it behind you; whoever hits it gets stuck in review (spin out)</li>
      <li><b class="c-lock">&#128274; Transport Lock</b> — freeze the car ahead of you</li>
      <li><b class="c-shield">&#9889; Emergency Change</b> — shield that skips the red tape (5s immunity)</li>
      <li><b class="c-oops">&#128165; OOPS!</b> — everyone ahead of you spins out</li>
    </ul>
    <p class="controls">Races are <b>3 laps</b>. Stay on the asphalt — grass is slow.
       Drive through the <b>?</b> boxes to grab a powerup.</p>`;

  function renderControls() {
    $('controls-home').innerHTML = CONTROLS_HTML;
    $('controls-lobby').innerHTML = CONTROLS_HTML;
  }

  // ---- Lobby ----
  function drawMapPreview(cv, map, selected) {
    const c = cv.getContext('2d');
    const scale = Math.min(cv.width / WORLD_W, cv.height / WORLD_H);
    c.fillStyle = selected ? '#e6edf9' : '#e9edf4';
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
    c.strokeStyle = selected ? '#1e396b' : '#94a3bd';
    c.stroke(path);
    c.lineWidth = 6;
    c.setLineDash([26, 30]);
    c.strokeStyle = selected ? BRAND_RED : 'rgba(255,255,255,0.65)';
    c.stroke(path);
    c.setLineDash([]);
    const st = RTMaps.pointAt(map.path, 0);
    c.fillStyle = selected ? '#fff' : '#5b6577';
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
      const cv = document.createElement('canvas');
      cv.width = 84; cv.height = 52;
      cv.className = 'car-illus';
      const cc = cv.getContext('2d');
      cc.translate(42, 26);
      cc.scale(1.6, 1.6);
      drawCarBody(cc, car);
      div.appendChild(cv);
      div.insertAdjacentHTML('beforeend',
        `<div class="cname">${car.name}</div>` +
        `<div class="owner">${owner ? esc(owner.name) : ''}</div>`);
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

  // Names are server-validated to [A-Za-z0-9 _-], but escape anyway — the
  // lobby and the leaderboard are where one player's text reaches another's DOM.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---- Race networking ----
  function exitRace() {
    if (!raceActive) return;
    socket.emit('exitRace');
    Object.keys(input).forEach((k) => { input[k] = false; });
    socket.emit('input', input);
    exitedRace = true;
    raceActive = false;
    showScreen('lobby');
    renderLobby();
  }
  $('btn-exit-race').onclick = exitRace;

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

  // ---- Leaderboard ----
  // Lap times here are seconds-with-one-decimal, which fits a narrow table
  // column — formatTime() above is the m:ss.t form the race HUD needs.
  function fmtTime(ms) {
    return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '—';
  }

  async function showLeaderboard() {
    showScreen('leaderboard');
    const tbody = document.querySelector('#standings-table tbody');
    tbody.innerHTML = '';
    $('standings-empty').textContent = 'Loading…';
    $('records-wrap').innerHTML = '';
    try {
      const data = await (await fetch('/api/leaderboard')).json();

      data.standings.forEach((s, i) => {
        const best = Object.values(s.bestByMap || {});
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${i + 1}</td><td>${esc(s.name)}</td><td>${s.races}</td>` +
          `<td>${s.wins}</td><td>${s.podiums}</td>` +
          `<td>${best.length ? fmtTime(Math.min(...best)) : '—'}</td>`;
        tbody.appendChild(tr);
      });
      $('standings-empty').textContent = data.standings.length
        ? '' : 'No races yet — a race needs 2+ drivers to count.';

      // One block per track that has any record, in map order.
      const wrap = $('records-wrap');
      const ids = Object.keys(data.records).map(Number).sort((a, b) => a - b);
      if (!ids.length) wrap.innerHTML = '<p class="hint">No track records yet.</p>';
      for (const id of ids) {
        const map = MAPS.find((m) => m.id === id);
        const rows = data.records[String(id)]
          .map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${fmtTime(r.timeMs)}</td></tr>`)
          .join('');
        const div = document.createElement('div');
        div.className = 'record-block';
        div.innerHTML = `<h4>${esc(map ? map.name : `Map ${id}`)}</h4>` +
          `<table class="record-table"><tbody>${rows}</tbody></table>`;
        wrap.appendChild(div);
      }
    } catch {
      $('standings-empty').textContent = 'Could not load the leaderboard.';
    }
  }

  $('btn-leaderboard').onclick = showLeaderboard;
  $('btn-lb-back').onclick = () => showScreen(socket && socket.connected && lobby ? 'lobby' : 'home');

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
    if (e.code === 'Escape') { e.preventDefault(); exitRace(); return; }
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
  // The track is entirely static, so it is painted once into an offscreen canvas
  // and blitted each frame. This replaces four full-path strokes per frame, so it
  // is cheaper than the old renderer despite drawing far more.
  // Only the current map is cached: one 1600x1000 layer is ~6MB, and caching all
  // eight would be ~51MB for no benefit — you race one track at a time.
  let trackLayer = null;    // { mapId, canvas }

  function trackLayerFor(map) {
    if (trackLayer && trackLayer.mapId === map.id) return trackLayer.canvas;
    const cv = document.createElement('canvas');
    cv.width = WORLD_W;
    cv.height = WORLD_H;
    RTScenery.paintTrack(cv.getContext('2d'), map, logoImg);
    trackLayer = { mapId: map.id, canvas: cv };
    return cv;
  }

  function drawTrack(map) {
    // logoImg loads asynchronously. Caching before it lands would bake a missing
    // wordmark in for the life of the page, so paint straight to the screen until
    // it is ready; logoImg.onload drops any layer built without it.
    if (!(logoImg.complete && logoImg.naturalWidth)) {
      RTScenery.paintTrack(ctx, map, logoImg);
      return;
    }
    ctx.drawImage(trackLayerFor(map), 0, 0);
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
    if (p.retired) return; // exited the race
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
    drawCarBody(ctx, car);

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
    $('hud-item').style.color = item ? item.color : '#5b6577';

    if (st.status === 'racing') {
      $('hud-time').textContent = formatTime(Math.max(0, st.now - st.raceStart));
    } else {
      $('hud-time').textContent = '0:00.0';
    }

    // Countdown overlay. Rebuilt only when the displayed value changes — the
    // frame loop runs at 60fps, and replacing the node is what restarts the
    // pop animation on each tick.
    const cd = $('countdown');
    let cdText = '';
    if (st.status === 'countdown') {
      const remain = Math.ceil((st.countdownEnd - st.now) / 1000);
      cdText = remain > 0 ? String(remain) : 'GO!';
    } else if (st.status === 'racing' && st.now - st.raceStart < 900) {
      cdText = 'GO!';
    }
    if (cdText !== lastCountdownText) {
      lastCountdownText = cdText;
      cd.textContent = '';
      if (cdText) {
        // Hint goes ABOVE the numeral: the canvas draws the track name and a
        // logo watermark through the centre, and anything below the number
        // lands right on top of them.
        if (cdText !== 'GO!') {
          const hint = document.createElement('div');
          hint.className = 'cd-hint';
          hint.textContent = 'Get ready';
          cd.appendChild(hint);
        }
        const num = document.createElement('div');
        num.className = cdText === 'GO!' ? 'cd-num cd-go' : 'cd-num';
        num.textContent = cdText;
        cd.appendChild(num);
      }
      cd.classList.toggle('active', !!cdText);
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

  // ---- Socket wiring ----
  // Every server-push handler lives here rather than at module scope, because
  // `socket` does not exist until bootstrap() has fetched the profile.
  function wireSocket() {
    socket.on('connect', () => { myId = socket.id; });

    socket.on('lobby', (data) => {
      lobby = data;
      if (typeof data.mapId === 'number') currentMapId = data.mapId;
      if (data.status === 'countdown') exitedRace = false; // new race starting
      if ((data.status === 'countdown' || data.status === 'racing') && !exitedRace) {
        if (!raceActive) { raceActive = true; showScreen('game'); }
        return;
      }
      renderLobby();
    });

    socket.on('state', (state) => {
      latestState = state;
      if (typeof state.mapId === 'number') currentMapId = state.mapId;
      if (state.status === 'countdown') exitedRace = false; // new race starting
      if ((state.status === 'countdown' || state.status === 'racing') && !raceActive && !exitedRace) {
        raceActive = true;
        smooth.clear();
        showScreen('game');
      }
      const me = state.players.find((p) => p.id === myId);
      $('btn-exit-race').style.display =
        state.status === 'racing' && me && !me.finished ? '' : 'none';
      // event toasts for me
      if (me && me.event && EVENT_TOASTS[me.event]) showToast(EVENT_TOASTS[me.event]);
    });

    socket.on('raceOver', ({ results }) => {
      raceActive = false;
      exitedRace = false;
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
  }

  // ---- Bootstrap ----
  async function bootstrap() {
    renderControls();
    let res;
    try {
      res = await fetch('/api/profile/me');
    } catch {
      profileUnavailable('Could not reach the server — reload to retry');
      return;
    }
    // Minting is rate-limited, so this can return 429 with {ok:false,error}
    // rather than {id,name}. Without this branch the page would read
    // `body.name === null` off an error payload and carry on with an undefined
    // id, leaving every join refused with no explanation on screen.
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      profileUnavailable(body.error || 'Could not reach the server — reload to retry');
      return;
    }
    profile = await res.json();
    // Only now is the cookie guaranteed to exist, so the handshake can resolve it.
    socket = io();
    wireSocket();
    renderNameGate();
  }

  function profileUnavailable(msg) {
    $('name-status').textContent = msg;
    $('name-status').className = 'hint error';
    $('btn-create').disabled = true;
    $('btn-join').disabled = true;
    $('code-input').disabled = true;
  }

  bootstrap();

  // Dev/test hooks: render a single frame / a car body on demand
  // (headless tabs never fire rAF).
  window.__rtrDrawFrame = () => frame(performance.now());
  window.__rtrDrawCarBody = drawCarBody;
})();
