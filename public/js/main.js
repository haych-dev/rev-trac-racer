/* Rev-Trac Racer — client: screens, networking, snapshot interpolation, HUD. */
(() => {
  'use strict';
  const RT = window.RT;
  const R = RT.Render, A = RT.Audio;
  const { MAPS } = RTMaps;
  const { CARS, BODIES, statsFor } = RTCars;
  const { ITEMS, CHAOS, FLAGS: F, AWARDS, POINTS } = RTItems;

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const INTERP_MS = 100; // render this far behind the newest snapshot

  // ---- small utilities -----------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const carById = (id) => CARS.find((c) => c.id === id) || CARS[0];
  const mapById = (id) => MAPS.find((m) => m.id === id) || MAPS[0];
  const angNorm = RTMaps.angNorm;
  function fmtTime(ms) {
    ms = Math.max(0, ms);
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), t = Math.floor((ms % 1000) / 100);
    return `${m}:${String(s).padStart(2, '0')}.${t}`;
  }
  function fmtLap(ms) {
    if (!ms) return '–';
    const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
    return m ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${s.toFixed(2)}s`;
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  // A car illustration on its own canvas. Pixel size is fixed; CSS decides
  // the displayed size. The car (about 50 units long) is scaled to fill it.
  function carCanvas(car, pxW = 150, pxH = 90) {
    const cv = document.createElement('canvas');
    cv.width = pxW; cv.height = pxH;
    const c = cv.getContext('2d');
    c.translate(pxW / 2, pxH / 2);
    const s = Math.min(pxW / 54, pxH / 31);
    c.scale(s, s);
    R.drawCarBody(c, car);
    return cv;
  }

  // ---- state ---------------------------------------------------------------
  let myId = null;
  let lobby = null;
  let race = null;      // live race view-model, see newRace()
  let lastOver = null;  // payload of the most recent raceOver
  let screen = 'home';
  const screens = { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game'), results: $('screen-results') };

  function showScreen(name) {
    screen = name;
    Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
    if (name === 'game') {
      R.resize();
      // a focused button would otherwise swallow Space/Enter during the race
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    if (name === 'home') loadHallOfFame();
    if (name !== 'game') A.engine(0, false, 0);
  }

  R.init($('game-canvas'));
  window.addEventListener('resize', () => R.resize());
  socket.on('connect', () => { myId = socket.id; });

  // =========================================================================
  // HOME
  // =========================================================================
  const nameInput = $('name-input');
  try { nameInput.value = localStorage.getItem('rtr-name') || ''; } catch (e) { /* ignore */ }
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) $('code-input').value = roomParam.toUpperCase().slice(0, 4);

  function driverName() {
    const n = nameInput.value.trim() || 'Racer';
    try { localStorage.setItem('rtr-name', n); } catch (e) { /* ignore */ }
    return n;
  }

  $('btn-create').onclick = () => {
    A.unlock();
    socket.emit('createRoom', { name: driverName() }, (res) => {
      if (res && res.ok) { $('home-error').textContent = ''; showScreen('lobby'); }
      else $('home-error').textContent = (res && res.error) || 'Could not create room';
    });
  };
  function joinRoom() {
    A.unlock();
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 4) { $('home-error').textContent = 'Enter a 4-character room code'; return; }
    socket.emit('joinRoom', { code, name: driverName() }, (res) => {
      if (res && res.ok) { $('home-error').textContent = ''; showScreen('lobby'); }
      else $('home-error').textContent = (res && res.error) || 'Could not join';
    });
  }
  $('btn-join').onclick = joinRoom;
  $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code-input').value ? joinRoom() : $('btn-create').click()); });

  $('item-list').innerHTML = Object.values(ITEMS).map((it) =>
    `<li><b><span class="ico" style="color:${it.color}">${it.icon}</span> ${esc(it.name)}</b>${esc(it.desc)}</li>`).join('');

  function loadHallOfFame() {
    fetch('/api/records').then((r) => r.json()).then((rec) => {
      $('hof-drivers').innerHTML = rec.drivers.length
        ? rec.drivers.slice(0, 6).map((d, i) =>
          `<div class="row"><span class="rank">${i + 1}</span><span class="who">${esc(d.name)}</span>` +
          `<span class="val">${d.wins} win${d.wins === 1 ? '' : 's'} · ${d.points} pts · ${d.races} races</span></div>`).join('')
        : '<div class="empty">No races yet. Be the first name on the board.</div>';
      const rows = MAPS.filter((m) => rec.tracks[m.id] && rec.tracks[m.id].lap).map((m) => {
        const lap = rec.tracks[m.id].lap;
        return `<div class="row"><span class="who">${esc(m.name)}</span><span class="val">${fmtLap(lap.time)} · ${esc(lap.name)}</span></div>`;
      });
      $('hof-tracks').innerHTML = rows.length ? rows.join('') : '<div class="empty">Every track record is up for grabs.</div>';
    }).catch(() => { /* offline: leave as is */ });
  }
  loadHallOfFame();

  // =========================================================================
  // LOBBY
  // =========================================================================
  socket.on('lobby', (data) => {
    lobby = data;
    if (screen === 'lobby') renderLobby();
  });

  function seg(options, current, onPick, disabled) {
    const div = document.createElement('div');
    div.className = 'seg';
    options.forEach(([value, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (value === current) b.classList.add('on');
      b.disabled = !!disabled;
      if (!disabled) b.onclick = () => { A.sfx('click'); onPick(value); };
      div.appendChild(b);
    });
    return div;
  }

  function renderLobby() {
    if (!lobby) return;
    const isHost = lobby.hostId === myId;
    const me = lobby.players.find((p) => p.id === myId);
    const s = lobby.settings;
    const racing = lobby.status === 'racing';
    const set = (patch) => socket.emit('settings', patch);

    $('lobby-code').textContent = lobby.code;
    $('race-no').textContent = lobby.raceNo ? `· race ${lobby.raceNo + (racing ? 0 : 1)} of the championship` : '';
    $('race-banner').hidden = !racing;

    // ---- tracks
    const mg = $('map-grid');
    mg.innerHTML = '';
    MAPS.forEach((map) => {
      const div = document.createElement('div');
      div.className = 'map-card' + (map.id === s.mapId ? ' selected' : '') + (isHost && !racing ? '' : ' readonly');
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 200;
      R.drawMapPreview(cv, map);
      div.appendChild(cv);
      div.insertAdjacentHTML('beforeend',
        `<div class="mrow"><span class="mname">${esc(map.name)}</span>` +
        `<span class="mstars" title="Difficulty">${'●'.repeat(map.stars)}${'○'.repeat(5 - map.stars)}</span></div>` +
        `<div class="mdesc">${esc(map.desc)}</div>`);
      if (isHost && !racing) div.onclick = () => { A.sfx('click'); set({ mapId: map.id }); };
      mg.appendChild(div);
    });
    $('map-hint').textContent = isHost ? '' : `(host picks — ${mapById(s.mapId).name})`;

    // ---- cars
    const cg = $('car-grid');
    cg.innerHTML = '';
    CARS.forEach((car) => {
      const owner = lobby.players.find((p) => p.carId === car.id);
      const mine = owner && owner.id === myId;
      const div = document.createElement('div');
      div.className = 'car-card' + (mine ? ' selected' : owner ? ' taken' : '');
      div.title = `${car.name} — ${statsFor(car).label}`;
      div.appendChild(carCanvas(car));
      div.insertAdjacentHTML('beforeend', `<div class="owner">${owner ? esc(owner.name) : ''}</div>`);
      if (!owner && !racing) div.onclick = () => { A.sfx('click'); socket.emit('selectCar', { carId: car.id }); };
      cg.appendChild(div);
    });
    if (me) {
      const car = carById(me.carId), st = statsFor(car);
      const bar = (label, key) => {
        const vals = Object.values(BODIES).map((b) => b[key]);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const pct = 28 + 72 * ((st[key] - lo) / (hi - lo || 1));
        return `<span class="lbl">${label}</span><span class="bar"><i style="width:${pct.toFixed(0)}%"></i></span>`;
      };
      $('car-stats').innerHTML =
        `<div class="title">${esc(car.name)}<small>${esc(st.label)}</small></div>` +
        bar('Top speed', 'speed') + bar('Acceleration', 'accel') + bar('Handling', 'handling') +
        bar('Weight', 'weight') + bar('Off-road', 'offroad');
    }

    // ---- race setup
    const locked = !isHost || racing;
    const st = $('settings');
    st.innerHTML = '';
    const row = (label, node) => {
      const l = document.createElement('span');
      l.className = 'lbl'; l.textContent = label;
      st.appendChild(l); st.appendChild(node);
    };
    row('Mode', seg([['race', 'Grand Prix'], ['elimination', 'Elimination']], s.mode, (v) => set({ mode: v }), locked));
    row('Laps', seg(lobby.lapChoices.map((n) => [n, String(n)]), s.laps, (v) => set({ laps: v }), locked || s.mode === 'elimination'));
    row('Chaos events', seg([[true, 'On'], [false, 'Off']], s.chaos, (v) => set({ chaos: v }), locked));
    row('AI drivers', seg([0, 1, 2, 3, 4, 5, 6, 7].map((n) => [n, String(n)]), s.bots, (v) => set({ bots: v }), locked));
    row('AI skill', seg([['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], s.botSkill, (v) => set({ botSkill: v }), locked));
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = s.mode === 'elimination'
      ? 'Elimination: every 14 seconds the car in last place is decommissioned. Last one running wins.'
      : `Grand Prix: ${s.laps} lap${s.laps === 1 ? '' : 's'}, points for every finisher, +1 for fastest lap.` +
        (s.chaos ? ' Expect outages, freezes and surprise audits.' : '');
    st.appendChild(note);
    $('setup-hint').textContent = isHost ? '' : '(host decides)';

    // ---- drivers
    const total = lobby.players.length + lobby.botCount;
    $('player-count').textContent = `${total}/8 on the grid`;
    const pl = $('player-list');
    pl.innerHTML = '';
    lobby.players.forEach((p) => {
      const li = document.createElement('li');
      li.appendChild(carCanvas(carById(p.carId)));
      const tags = [];
      if (p.id === lobby.hostId) tags.push('<span class="tag host">HOST</span>');
      else tags.push(p.ready ? '<span class="tag ready">READY</span>' : '<span class="tag">NOT READY</span>');
      li.insertAdjacentHTML('beforeend', `<span class="pname">${esc(p.name)}${p.id === myId ? ' (you)' : ''}</span>${tags.join('')}`);
      pl.appendChild(li);
    });
    lobby.botNames.forEach((name) => {
      const li = document.createElement('li');
      li.className = 'bot';
      li.innerHTML = `<span style="font-size:20px;width:46px;text-align:center">🤖</span><span class="pname">${esc(name)}</span><span class="tag">${esc(s.botSkill.toUpperCase())} AI</span>`;
      pl.appendChild(li);
    });

    // ---- championship
    $('standings').innerHTML = standingsHtml(lobby.standings) ||
      `<div class="empty">No races yet. Points: ${POINTS.join(' · ')}, +1 for fastest lap. The points leader starts at the back.</div>`;
    $('btn-reset-standings').hidden = !(isHost && lobby.standings.length && !racing);

    // ---- actions
    const othersReady = lobby.players.filter((p) => p.id !== lobby.hostId).every((p) => p.ready);
    $('btn-ready').hidden = isHost;
    $('btn-ready').textContent = me && me.ready ? 'Not Ready' : 'Ready Up';
    $('btn-ready').disabled = racing;
    $('btn-start').hidden = !isHost;
    $('btn-start').disabled = racing || !othersReady;
    $('lobby-hint').textContent = racing ? 'Race in progress…'
      : isHost ? (othersReady ? (total === 1 ? 'Just you — add some AI drivers or share the invite link.' : 'Everyone is ready. Start when you are.') : 'Waiting for everyone to ready up…')
      : (me && me.ready ? 'Ready. Waiting for the host to start…' : 'Pick a car and ready up.');
  }

  function standingsHtml(list) {
    return (list || []).map((d, i) =>
      `<div class="row"><span class="rank">${i + 1}</span><span class="who">${d.bot ? '🤖 ' : ''}${esc(d.name)}</span>` +
      `<span class="wins">${d.wins ? d.wins + ' win' + (d.wins === 1 ? '' : 's') : ''}</span><span class="pts">${d.points}</span></div>`).join('');
  }

  $('btn-ready').onclick = () => { A.unlock(); A.sfx('click'); socket.emit('toggleReady'); };
  $('btn-start').onclick = () => { A.unlock(); socket.emit('startRace'); };
  $('btn-leave').onclick = () => {
    socket.emit('leaveRoom');
    lobby = null; race = null;
    A.music(false);
    showScreen('home');
  };
  $('btn-reset-standings').onclick = () => socket.emit('resetStandings');
  $('btn-watch').onclick = () => { A.unlock(); if (race) showScreen('game'); };
  $('btn-copy').onclick = () => {
    const url = `${location.origin}/?room=${lobby.code}`;
    const done = () => { $('btn-copy').textContent = 'Copied!'; setTimeout(() => { $('btn-copy').textContent = 'Copy invite link'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt('Invite link', url));
    else window.prompt('Invite link', url);
  };
  $('btn-back-lobby').onclick = () => { showScreen('lobby'); renderLobby(); };

  // =========================================================================
  // RACE: networking
  // =========================================================================
  function newRace(info) {
    const roster = info.roster.map((r) => ({ ...r, car: carById(r.carId) }));
    return {
      info,
      map: mapById(info.mapId),
      roster,
      meIdx: roster.findIndex((r) => r.id === myId),
      snaps: [],
      offset: null,
      status: 'countdown',
      chaos: null,
      ink: null,
      boxesOff: new Set(),
      elimAt: 0,
      lastCount: null,
      feed: [],
      center: null,
      banner: null,
      hudAt: 0,
      boardKey: '',
    };
  }

  socket.on('raceStart', (info) => {
    race = newRace(info);
    R.resetRace();
    $('hud-feed').innerHTML = '';
    $('hud-banner').innerHTML = '';
    $('hud-center').innerHTML = '';
    if (info.spectate) {
      if (screen === 'lobby') renderLobby();
    } else {
      showScreen('game');
    }
  });

  socket.on('state', (snap) => {
    if (!race) return;
    const now = performance.now();
    const sample = snap.t - now;
    if (race.offset === null || Math.abs(sample - race.offset) > 400) race.offset = sample;
    else race.offset += (sample - race.offset) * 0.08;
    race.snaps.push(snap);
    if (race.snaps.length > 40) race.snaps.shift();
    race.status = snap.st;
    race.boxesOff = new Set(snap.bx);
    race.elimAt = snap.el;
    if (snap.ch) {
      if (!race.chaos || race.chaos.k !== snap.ch[0] || race.chaos.until !== snap.ch[1]) {
        race.chaos = { k: snap.ch[0], until: snap.ch[1], start: snap.t };
      }
    } else if (race.chaos && snap.t > race.chaos.until) {
      race.chaos = null;
    }
    for (const e of snap.ev) onEvent(e, snap);
  });

  socket.on('raceOver', (data) => {
    lastOver = data;
    A.music(false);
    const delay = screen === 'game' ? 2400 : 200;
    setTimeout(() => {
      race = null;
      A.engine(0, false, 0);
      if (!lobby) return;
      renderResults();
      if (screen === 'game' || screen === 'lobby' || screen === 'results') showScreen('results');
      if (data.records && data.records.length) A.sfx('record');
    }, delay);
  });

  socket.on('disconnect', () => {
    lobby = null; race = null;
    A.music(false);
    showScreen('home');
    $('home-error').textContent = 'Disconnected from the server.';
  });

  // ---- events → sound, particles, feed --------------------------------------
  const nm = (i) => (race.roster[i] ? esc(race.roster[i].name) : '?');
  const isMe = (i) => i === race.meIdx;

  // Feed lines are appended (never re-rendered) so only the new one animates in.
  function addFeed(html, mine) {
    const el = document.createElement('div');
    el.className = 'line' + (mine ? ' me' : '');
    el.innerHTML = html;
    $('hud-feed').appendChild(el);
    race.feed.push({ el, until: performance.now() + 9000 });
    while (race.feed.length > 8) race.feed.shift().el.remove();
  }
  function setCenter(html, ms) {
    race.center = { html, until: performance.now() + ms };
    $('hud-center').innerHTML = html;
  }

  const SPIN_VERBS = { cab: 'sent to CAB review', oops: "OOPS'd", missile: 'rolled back', giant: 'flattened' };

  function onEvent(e, snap) {
    const P = (i) => snap.p[i] || { x: 800, y: 500 };
    const loud = (i) => (isMe(i) ? 1 : 0.35);
    switch (e.k) {
      case 'go':
        A.sfx('go');
        A.music(true);
        setCenter('<div class="big">GO!</div>', 900);
        break;
      case 'pickup': {
        const p = P(e.i);
        R.fx.ring(p.x, p.y, '#ffd60a');
        if (isMe(e.i)) { A.sfx('pickup'); R.fx.text(p.x, p.y - 34, `${ITEMS[e.it].icon} ${ITEMS[e.it].name}`, '#ffd60a'); }
        break;
      }
      case 'use': {
        const it = ITEMS[e.it], p = P(e.i);
        const hitMe = e.on.includes(race.meIdx);
        A.sfx(e.it, isMe(e.i) || hitMe ? 1 : 0.4);
        R.fx.text(p.x, p.y - 36, it.icon, '#fff', 22);
        let line = `<b>${nm(e.i)}</b> used ${it.icon} ${esc(it.name)}`;
        if (e.it === 'swap' && e.on.length) {
          line = `<b>${nm(e.i)}</b> 🔄 swapped places with <b>${nm(e.on[0])}</b>`;
          for (const i of [e.i, e.on[0]]) { R.fx.ring(P(i).x, P(i).y, '#22d3ee'); R.fx.puff(P(i).x, P(i).y, '#22d3ee', 14); }
        } else if (e.it === 'lock' && e.on.length) {
          line = `<b>${nm(e.i)}</b> 🔒 locked <b>${nm(e.on[0])}</b>`;
        } else if (e.it === 'missile' && e.on.length) {
          line = `<b>${nm(e.i)}</b> 🚀 launched a rollback at <b>${nm(e.on[0])}</b>`;
        } else if (e.it === 'oops' && e.on.length) {
          line = `<b>${nm(e.i)}</b> 💥 OOPS'd ${e.on.length} car${e.on.length === 1 ? '' : 's'}`;
        }
        if (e.it === 'freeze') for (const i of e.on) R.fx.puff(P(i).x, P(i).y, '#bfe8ff', 8);
        if (e.it === 'ink' && hitMe) race.ink = { seed: snap.t | 0, start: snap.t, until: snap.t + 5000 };
        if (e.it === 'shield' || e.it === 'giant' || e.it === 'auto') R.fx.ring(p.x, p.y, it.color);
        addFeed(line, isMe(e.i) || hitMe);
        if (hitMe && !isMe(e.i)) {
          const msg = { freeze: 'You are on ice!', bug: 'Your steering is inverted!', ink: 'Ink on your screen!', swap: 'You got retrofitted!' }[e.it];
          if (msg) setCenter(`<div class="mid bad">${it.icon}</div><div class="sub">${msg}</div>`, 1400);
        }
        break;
      }
      case 'spin': {
        const p = P(e.i);
        R.fx.sparks(p.x, p.y, 16, '#ffd60a');
        R.fx.puff(p.x, p.y, '#d0d0d8', 8);
        A.sfx('spin', loud(e.i));
        if (isMe(e.i)) R.fx.shake(10);
        if (e.by >= 0 && e.by !== e.i) addFeed(`<b>${nm(e.i)}</b> was ${SPIN_VERBS[e.c] || 'spun'} by <b>${nm(e.by)}</b>`, isMe(e.i) || isMe(e.by));
        else if (e.c === 'cab') addFeed(`<b>${nm(e.i)}</b> walked into a CAB meeting`, isMe(e.i));
        break;
      }
      case 'locked': {
        const p = P(e.i);
        R.fx.ring(p.x, p.y, '#7ab5ff');
        A.sfx('lock', loud(e.i));
        if (e.by < 0) addFeed(`🔍 <b>${nm(e.i)}</b> is being audited`, isMe(e.i));
        break;
      }
      case 'bump': {
        const a = P(e.a), b = P(e.b);
        R.fx.sparks((a.x + b.x) / 2, (a.y + b.y) / 2, 8, '#ffe9a8');
        const mine = isMe(e.a) || isMe(e.b);
        A.sfx('bump', mine ? Math.min(1, e.f / 300) : 0.2);
        if (mine) R.fx.shake(Math.min(9, e.f / 45));
        break;
      }
      case 'mini': {
        const p = P(e.i);
        R.fx.sparks(p.x, p.y, 14, e.l === 2 ? '#ff9a1f' : '#58c7ff');
        if (isMe(e.i)) A.sfx(e.l === 2 ? 'mini2' : 'mini1');
        break;
      }
      case 'pad': {
        const p = P(e.i);
        R.fx.sparks(p.x, p.y, 10, '#ef4d57');
        if (isMe(e.i)) A.sfx('pad');
        break;
      }
      case 'oil':
        if (isMe(e.i)) { A.sfx('oil'); setCenter('<div class="sub">Oil!</div>', 700); }
        break;
      case 'block': {
        const p = P(e.i);
        R.fx.ring(p.x, p.y, '#ffffff');
        A.sfx('block', loud(e.i));
        break;
      }
      case 'boom':
        R.fx.boom(e.x, e.y);
        A.sfx('boom', 0.6);
        break;
      case 'honk': {
        const p = P(e.i);
        A.sfx('honk', isMe(e.i) ? 0.8 : 0.5, 0.8 + (e.i % 5) * 0.09);
        R.fx.text(p.x, p.y - 36, '📣', '#fff', 20);
        break;
      }
      case 'reset':
        R.fx.puff(P(e.i).x, P(e.i).y, '#ffffff', 10);
        if (isMe(e.i)) A.sfx('reset');
        break;
      case 'lap':
        if (isMe(e.i)) {
          A.sfx(e.best && e.lap > 1 ? 'best' : 'lap');
          R.fx.text(P(e.i).x, P(e.i).y - 40, fmtLap(e.t) + (e.best && e.lap > 1 ? ' ★' : ''), e.best ? '#57cc3f' : '#fff', 18);
        }
        break;
      case 'final':
        if (isMe(e.i)) { A.sfx('final'); setCenter('<div class="mid warn">FINAL LAP</div>', 1600); }
        break;
      case 'finish': {
        const p = P(e.i);
        R.fx.confetti(p.x, p.y);
        addFeed(`🏁 <b>${nm(e.i)}</b> finished ${ordinal(e.pos)} — ${fmtTime(e.t)}`, isMe(e.i));
        if (isMe(e.i)) {
          A.sfx('finish');
          setCenter(`<div class="big">${ordinal(e.pos)}</div><div class="sub">${e.pos === 1 ? 'Change delivered to PROD!' : 'Across the line!'}</div>`, 4000);
        } else {
          A.sfx('lap', 0.4);
        }
        break;
      }
      case 'elim': {
        R.fx.boom(e.x, e.y, true);
        A.sfx('elim', isMe(e.i) ? 1 : 0.6);
        addFeed(`☠️ <b>${nm(e.i)}</b> was decommissioned`, isMe(e.i));
        if (isMe(e.i)) setCenter('<div class="mid bad">DECOMMISSIONED</div><div class="sub">You can keep watching.</div>', 3200);
        break;
      }
      case 'out':
        R.fx.puff(e.x, e.y, '#ffffff', 12);
        addFeed(`<b>${nm(e.i)}</b> left the race`, false);
        break;
      case 'chaos': {
        const c = CHAOS[e.c];
        A.sfx('chaos');
        R.fx.shake(8);
        race.banner = { until: performance.now() + Math.max(3200, Math.min(e.d, 5000)) };
        $('hud-banner').innerHTML = `<div class="chaos"><div class="t">${c.icon} ${esc(c.title)}</div><div class="s">${esc(c.sub)}</div></div>`;
        addFeed(`${c.icon} <b>${esc(c.title)}</b> — ${esc(c.sub)}`, false);
        break;
      }
      default:
        break;
    }
  }

  // ---- snapshot interpolation ----------------------------------------------
  function getView(now) {
    const sn = race.snaps;
    if (!sn.length) return null;
    const rt = now + race.offset - INTERP_MS;
    let j = sn.length - 1;
    while (j > 0 && sn[j].t > rt) j--;
    const s0 = sn[j], s1 = sn[Math.min(sn.length - 1, j + 1)];
    const span = s1.t - s0.t;
    const f = span > 0 ? clamp((rt - s0.t) / span, 0, 1) : 0;

    const cars = race.roster.map((r, i) => {
      const a = s0.p[i], b = s1.p[i];
      let x = b.x, y = b.y, ang = b.a;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 220) {
        x = a.x + (b.x - a.x) * f;
        y = a.y + (b.y - a.y) * f;
        ang = a.a + angNorm(b.a - a.a) * f;
      }
      return { i, x, y, a: ang, v: b.v, f: b.f, it: b.it, lap: b.lap, rk: b.rk, d: b.d, name: r.name, car: r.car, bot: r.bot, me: i === race.meIdx };
    });
    const missiles = s1.ms.map((m) => {
      const p = s0.ms.find((q) => q[0] === m[0]);
      return p ? [m[0], p[1] + (m[1] - p[1]) * f, p[2] + (m[2] - p[2]) * f, m[3]] : m;
    });

    let chaos = null;
    if (race.chaos) {
      const a = clamp(Math.min((rt - race.chaos.start) / 400, (race.chaos.until - rt) / 500), 0, 1);
      chaos = { k: race.chaos.k, a };
    }
    let ink = null;
    if (race.ink) {
      const a = clamp(Math.min((rt - race.ink.start) / 200, (race.ink.until - rt) / 900), 0, 1);
      if (rt > race.ink.until) race.ink = null; else ink = { seed: race.ink.seed, a };
    }
    return {
      map: race.map, cars, me: cars[race.meIdx] || null, boxesOff: race.boxesOff,
      hazards: s1.hz, missiles, chaos, ink, rt, status: s1.st,
    };
  }

  // ---- HUD -----------------------------------------------------------------
  function updateHud(view, now) {
    const info = race.info;
    const me = view.me;
    const racing = view.status === 'racing';
    const elim = info.mode === 'elimination';
    const n = view.cars.length;

    // countdown beeps + digits
    if (view.status === 'countdown') {
      const left = Math.ceil((info.t0 - view.rt) / 1000);
      if (left !== race.lastCount && left >= 1 && left <= 3) {
        race.lastCount = left;
        A.sfx('count');
        setCenter(`<div class="big">${left}</div>`, 1100);
      }
    }
    if (race.center && now > race.center.until) { race.center = null; $('hud-center').innerHTML = ''; }
    if (race.banner && now > race.banner.until) { race.banner = null; $('hud-banner').innerHTML = ''; }
    while (race.feed.length && now > race.feed[0].until) race.feed.shift().el.remove();

    // engine + tyre noise follow my car
    const driving = !!me && racing && !(me.f & (F.OUT | F.FINISHED));
    A.engine(me ? me.v : 0, driving, me && (me.d >= 1 || (me.f & F.SPIN)) ? 1 : 0);

    if (now < race.hudAt) return;
    race.hudAt = now + 90;

    $('hud-time').textContent = fmtTime(racing || view.status === 'finished' ? view.rt - info.t0 : 0);
    if (me) {
      $('hud-lap').textContent = elim ? String(me.lap + 1) : `${Math.min(me.lap + 1, info.laps)}/${info.laps}`;
      $('hud-pos').textContent = `${ordinal(me.rk)} / ${n}`;
      const it = me.it ? ITEMS[me.it] : null;
      $('hud-item').textContent = it ? `${it.icon} ${it.name}` : '–';
      $('hud-item').style.color = it ? it.color : '';
      $('hud-item-pill').classList.toggle('has', !!it);
    } else {
      $('hud-lap').textContent = elim ? '–' : String(info.laps);
      $('hud-pos').textContent = '–';
      $('hud-item').textContent = '–';
      $('hud-item-pill').classList.remove('has');
    }

    // leaderboard (rebuilt only when something visible changes)
    const order = view.cars.slice().sort((a, b) => a.rk - b.rk);
    const active = order.filter((c) => !(c.f & (F.OUT | F.FINISHED)));
    const dangerIdx = elim && racing && active.length > 1 ? active[active.length - 1].i : -1;
    const key = order.map((c) => `${c.i}:${c.f & (F.OUT | F.FINISHED)}:${c.it || ''}:${c.lap}:${c.i === dangerIdx}`).join('|');
    if (key !== race.boardKey) {
      race.boardKey = key;
      $('hud-board').innerHTML = order.map((c) => {
        const cls = ['row'];
        if (c.me) cls.push('me');
        if (c.f & F.OUT) cls.push('out');
        if (c.i === dangerIdx) cls.push('danger');
        const extra = (c.f & F.FINISHED) ? '🏁' : (c.f & F.OUT) ? '' : (c.it ? ITEMS[c.it].icon : '');
        return `<div class="${cls.join(' ')}"><span class="rk">${c.rk}</span>` +
          `<span class="dot" style="background:${c.car.color}"></span>` +
          `<span class="nm">${c.bot ? '🤖 ' : ''}${esc(c.name)}</span><span class="ex">${extra}</span></div>`;
      }).join('');
    }

    $('hud-elim').textContent = elim && racing && active.length > 1
      ? `☠️ Last place decommissioned in ${Math.max(0, Math.ceil((race.elimAt - view.rt) / 1000))}s` : '';

    let status = '';
    if (!me) status = '👀 Spectating';
    else if (me.f & F.OUT) status = '👀 You are out — spectating';
    else if (me.f & F.FINISHED) status = '🏁 Finished — waiting for the others';
    else if (me.f & F.WRONG) status = '↩️ WRONG WAY';
    else if (me.f & F.BUG) status = '🐛 Steering inverted!';
    else if (me.f & F.LOCKED) status = '🔒 Locked!';
    else if (me.f & F.OFF) status = 'Off track — press R to reset';
    $('hud-status').textContent = status;

    const canExit = !!me && !(me.f & (F.OUT | F.FINISHED));
    $('btn-exit-race').textContent = canExit ? '✕ Exit' : '← Lobby';
  }

  // =========================================================================
  // RESULTS
  // =========================================================================
  function renderResults() {
    const d = lastOver;
    if (!d) return;
    const map = mapById(d.mapId);
    const mine = (r) => r.id === myId;
    $('results-title').textContent = `🏁 Race ${d.raceNo} — ${map.name}` + (d.mode === 'elimination' ? ' (Elimination)' : '');

    $('results-records').innerHTML = (d.records || []).map((r) =>
      `<div class="record">🏆 NEW ${r.type === 'lap' ? 'LAP' : `${r.laps}-LAP RACE`} RECORD — ${esc(r.name)} · ${r.type === 'lap' ? fmtLap(r.time) : fmtTime(r.time)}` +
      (r.prev ? ` <span style="font-weight:500">(was ${r.type === 'lap' ? fmtLap(r.prev) : fmtTime(r.prev)})</span>` : '') + '</div>').join('');

    const pod = $('podium');
    pod.innerHTML = '';
    [1, 0, 2].forEach((idx) => {
      const r = d.results[idx];
      if (!r) return;
      const step = document.createElement('div');
      step.className = `step p${idx + 1}`;
      step.appendChild(carCanvas(carById(r.carId), 240, 144));
      step.insertAdjacentHTML('beforeend', `<div class="who">${r.bot ? '🤖 ' : ''}${esc(r.name)}</div><div class="block">${idx + 1}</div>`);
      pod.appendChild(step);
    });

    const winner = d.results[0];
    const tbody = $('results-table').querySelector('tbody');
    tbody.innerHTML = d.results.map((r) => {
      const car = carById(r.carId);
      let time;
      if (r.finished && d.mode === 'race') time = r === winner ? fmtTime(r.time) : `+${((r.time - winner.time) / 1000).toFixed(1)}s`;
      else if (r.finished) time = 'Survivor';
      else if (r.out === 'elim') time = 'Decommissioned';
      else if (r.out === 'retired') time = 'Retired';
      else time = `Still on lap ${Math.min(r.laps + 1, d.laps)}`;
      return `<tr class="${mine(r) ? 'me' : ''}${r.pos === 1 ? ' first' : ''}">` +
        `<td>${r.pos}</td><td>${r.bot ? '🤖 ' : ''}${esc(r.name)}</td>` +
        `<td><span class="res-swatch" style="background:${car.color}"></span>${esc(car.name)}</td>` +
        `<td class="num">${time}</td><td class="num">${fmtLap(r.bestLap)}${r.fastest ? ' ★' : ''}</td>` +
        `<td class="num pts">${r.points ? '+' + r.points : '0'}</td></tr>`;
    }).join('');

    $('awards').innerHTML = (d.awards || []).map((a) => {
      const def = AWARDS[a.key];
      return def ? `<div class="award"><b>${def.icon} ${esc(def.title)}</b><span>${esc(a.name)} · ${esc(a.value)}</span></div>` : '';
    }).join('');
    $('results-standings').innerHTML = standingsHtml(d.standings);
  }

  // =========================================================================
  // INPUT
  // =========================================================================
  const input = { u: false, d: false, l: false, r: false, dr: false };
  const KEYMAP = {
    ArrowUp: 'u', KeyW: 'u', ArrowDown: 'd', KeyS: 'd',
    ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
    ShiftLeft: 'dr', ShiftRight: 'dr', KeyX: 'dr',
  };
  const inRace = () => screen === 'game' && race && race.meIdx >= 0;

  function exitRace() {
    if (screen !== 'game') return;
    if (inRace()) {
      socket.emit('exitRace');
      Object.keys(input).forEach((k2) => { input[k2] = false; });
    }
    showScreen('lobby');
    renderLobby();
  }
  $('btn-exit-race').onclick = exitRace;

  function refreshSoundButton() {
    $('btn-sound').textContent = A.icon();
    $('btn-sound').title = `${A.label()} (M)`;
  }
  $('btn-sound').onclick = () => { A.unlock(); A.cycleMode(); refreshSoundButton(); $('btn-sound').blur(); };
  refreshSoundButton();

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'KeyM') { A.unlock(); A.cycleMode(); refreshSoundButton(); return; }
    if (screen !== 'game') return;
    if (e.code === 'Escape') { e.preventDefault(); exitRace(); return; }
    if (!inRace()) return;
    A.unlock();
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!e.repeat) socket.emit('useItem'); return; }
    if (e.code === 'KeyH') { if (!e.repeat) socket.emit('honk'); return; }
    if (e.code === 'KeyR') { if (!e.repeat) socket.emit('resetCar'); return; }
    const k2 = KEYMAP[e.code];
    if (!k2) return;
    e.preventDefault();
    if (!input[k2]) { input[k2] = true; socket.emit('input', input); }
  });
  window.addEventListener('keyup', (e) => {
    if (screen === 'game' && (e.code === 'Space' || e.code === 'Enter')) e.preventDefault();
    const k2 = KEYMAP[e.code];
    if (k2 && input[k2]) { input[k2] = false; socket.emit('input', input); }
  });
  window.addEventListener('blur', () => {
    if (Object.values(input).some(Boolean)) {
      Object.keys(input).forEach((k2) => { input[k2] = false; });
      socket.emit('input', input);
    }
  });

  // =========================================================================
  // MAIN LOOP
  // =========================================================================
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(250, now - last);
    last = now;
    if (screen === 'game' && race) {
      const view = getView(now);
      if (view) {
        R.frame(view, dt, now);
        updateHud(view, now);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Dev/test hooks (headless browsers never fire requestAnimationFrame).
  window.__rt = {
    frame: () => { const now = performance.now(); const dt = Math.min(250, now - last); last = now; if (screen === 'game' && race) { const v = getView(now); if (v) { R.frame(v, dt || 16, now); updateHud(v, now); } } },
    race: () => race,
    lobby: () => lobby,
    screen: () => screen,
  };
})();
