'use strict';
/* The race simulation. Pure and deterministic: no sockets, no wall clock.
 * Time is internal (this.t, in ms) and advances a fixed step per tick(), so
 * the same class runs live at 60 Hz and headless at thousands of ticks/sec.
 */
const RTMaps = require('../public/maps.js');
const { CARS, statsFor } = require('../public/cars.js');
const { FLAGS: F, ITEM_KEYS } = require('../public/items.js');
const Bots = require('./bots.js');

const { pointAt, closest, closestNear, uDiff, wrap01, angNorm, mulberry32 } = RTMaps;

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const DT_MS = 1000 / TICK_RATE;

const P = {
  DT,
  BASE_MAX: 440,      // px/s top speed before car stats
  BOOST_MAX: 700,     // item boost speed cap
  PAD_MAX: 610,       // boost pad cap
  MINI_MAX: [565, 625], // drift mini-turbo caps (level 1, 2)
  AUTO_SPEED: 640,
  OFF_MAX: 170,       // grass
  ACCEL: 520,
  BRAKE: 780,
  REV_MAX: 140,
  TURN: 3.1,          // rad/s
  GRIP: 9.0,          // lateral velocity decay rate (1/s)
  GRIP_DRIFT: 2.6,
};

const SECTORS = 8;
const COUNTDOWN_MS = 3600;
const CAR_R = 18;
const GIANT_R = 33;
const WORLD = RTMaps.WORLD;
const ELIM_FIRST_MS = 20000;
const ELIM_EVERY_MS = 14000;
const MAX_RACE_MS = 6 * 60 * 1000;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

class Race {
  /**
   * opts: { mapId, laps, mode: 'race'|'elimination', chaos: bool, seed,
   *         entrants: [{ id, name, carId, bot: null | { skill } }] } in grid order
   */
  constructor(opts) {
    this.map = RTMaps.MAPS.find((m) => m.id === opts.mapId) || RTMaps.MAPS[0];
    this.path = this.map.path;
    this.P = P;
    this.mode = opts.mode === 'elimination' && opts.entrants.length >= 2 ? 'elimination' : 'race';
    this.laps = clamp(opts.laps | 0 || 3, 1, 9);
    this.chaosOn = !!opts.chaos;
    this.rng = mulberry32(opts.seed === undefined ? (Date.now() & 0x7fffffff) : opts.seed);

    this.t = 0;
    this.status = 'countdown'; // countdown | racing | finished
    this.raceT0 = COUNTDOWN_MS;
    this.over = false;

    this.players = opts.entrants.map((e, i) => this._makePlayer(e, i));
    this.byId = new Map(this.players.map((p) => [p.id, p]));
    this.hasHumans = this.players.some((p) => !p.bot);
    this.order = this.players.slice();

    this.boxes = this.map.itemBoxes.map((b) => ({ ...b, active: true, respawnAt: 0 }));
    this.hazards = [];
    this.missiles = [];
    this.events = [];
    this.nextId = 1;

    this.chaos = null; // { k, until }
    this.lastChaos = null;
    this.nextChaosT = this.raceT0 + 12000 + this.rng() * 6000;
    this.nextElimT = this.raceT0 + ELIM_FIRST_MS;
    this.firstFinishT = 0;
    this.finishCount = 0;
    this.endAt = Infinity;
    this._rank();
  }

  _makePlayer(e, i) {
    const car = CARS.find((c) => c.id === e.carId) || CARS[0];
    const row = Math.floor(i / 2), col = i % 2;
    const u = wrap01(1 - (60 * (row + 1) + col * 24) / this.path.total);
    const pt = pointAt(this.path, u);
    const lat = col === 0 ? -34 : 34;
    return {
      i, id: e.id, name: e.name, carId: car.id, st: statsFor(car),
      bot: e.bot ? { skill: Bots.SKILLS[e.bot.skill] || Bots.SKILLS.medium, lane: ((i % 3) - 1) * 0.55 } : null,
      x: pt.x - pt.ty * lat, y: pt.y + pt.tx * lat, angle: Math.atan2(pt.ty, pt.tx),
      vx: 0, vy: 0, speed: 0,
      input: { u: false, d: false, l: false, r: false, dr: false },
      ai: { u: false, d: false, s: 0, dr: false },
      u, lat, nextSector: 1, cpCount: 0, lap: 0, score: 0, rank: i + 1,
      lapStartT: 0, bestLap: 0, lastLap: 0, lapValid: true,
      finished: false, finishT: 0, out: null, outT: 0,
      item: null, botItemAt: 0,
      boostUntil: 0, boostCap: 0, spinUntil: 0, lockedUntil: 0, shieldUntil: 0, giantUntil: 0,
      autoUntil: 0, frozenUntil: 0, bugUntil: 0, inkUntil: 0, oilUntil: 0,
      padCd: 0, oilCd: 0, bumpCd: 0, honkCd: 0,
      driftT: 0, drifting: false, slipT: 0, slip: false,
      offTrack: false, icy: false, wrongT: 0, stuckT: 0, invSince: 0,
      stats: { hitsDealt: 0, hitsTaken: 0, items: 0, drift: 0, top: 0, pads: 0 },
    };
  }

  emit(ev) { this.events.push(ev); }

  // ---- public controls ---------------------------------------------------
  setInput(id, input) {
    const p = this.byId.get(id);
    if (!p || !input) return;
    p.input.u = !!input.u; p.input.d = !!input.d;
    p.input.l = !!input.l; p.input.r = !!input.r;
    p.input.dr = !!input.dr;
  }

  honk(id) {
    const p = this.byId.get(id);
    if (!p || p.out || this.t < p.honkCd) return;
    p.honkCd = this.t + 700;
    this.emit({ k: 'honk', i: p.i });
  }

  retire(id) {
    const p = this.byId.get(id);
    if (!p || p.out || p.finished || this.over) return;
    this._out(p, 'retired');
  }

  // Put a car back on the racing line (stuck bots; the R key for people).
  resetCar(id, penaltyMs = 1200) {
    const p = this.byId.get(id);
    if (!p || p.out || p.finished || this.status !== 'racing') return;
    if (p.spinUntil > this.t || p.lockedUntil > this.t) return;
    const pt = pointAt(this.path, p.u);
    p.x = pt.x; p.y = pt.y; p.angle = Math.atan2(pt.ty, pt.tx);
    p.vx = 0; p.vy = 0; p.driftT = 0; p.drifting = false;
    p.lockedUntil = this.t + penaltyMs;
    this.emit({ k: 'reset', i: p.i });
  }

  // ---- helpers -----------------------------------------------------------
  _immune(p) {
    const t = this.t;
    return p.shieldUntil > t || p.giantUntil > t || p.autoUntil > t || p.finished;
  }

  _radius(p) { return p.giantUntil > this.t ? GIANT_R : CAR_R; }

  isInverted(p) {
    const t = this.t;
    const global = this.chaos && this.chaos.k === 'regression' && this.chaos.until > t;
    return (p.bugUntil > t || global) && !this._immune(p);
  }

  _chaosIs(k) {
    return !!this.chaos && this.chaos.k === k && this.chaos.until > this.t;
  }

  _inIce(u) {
    for (const [a, b] of this.map.ice) if (u >= a && u <= b) return true;
    return false;
  }

  _boost(p, durMs, cap) {
    const t = this.t;
    p.boostCap = p.boostUntil > t ? Math.max(p.boostCap, cap) : cap;
    p.boostUntil = Math.max(p.boostUntil, t + durMs);
  }

  _spin(p, durMs, byId, cause) {
    if (p.out || p.finished) return false;
    if (this._immune(p)) { this.emit({ k: 'block', i: p.i }); return false; }
    if (p.spinUntil > this.t) return false;
    p.spinUntil = this.t + durMs;
    p.driftT = 0; p.drifting = false; p.boostUntil = 0;
    p.stats.hitsTaken++;
    const by = byId != null ? this.byId.get(byId) : null;
    if (by && by !== p) by.stats.hitsDealt++;
    this.emit({ k: 'spin', i: p.i, by: by ? by.i : -1, c: cause });
    return true;
  }

  _lock(p, durMs, byId) {
    if (p.out || p.finished) return false;
    if (this._immune(p)) { this.emit({ k: 'block', i: p.i }); return false; }
    p.lockedUntil = Math.max(p.lockedUntil, this.t + durMs);
    p.driftT = 0; p.drifting = false;
    p.stats.hitsTaken++;
    const by = byId != null ? this.byId.get(byId) : null;
    if (by && by !== p) by.stats.hitsDealt++;
    this.emit({ k: 'locked', i: p.i, by: by ? by.i : -1 });
    return true;
  }

  _out(p, why) {
    p.out = why;
    p.outT = this.t;
    p.item = null;
    this.emit({ k: why === 'elim' ? 'elim' : 'out', i: p.i, x: Math.round(p.x), y: Math.round(p.y) });
  }

  _addHazard(x, y, ownerId) {
    const c = closest(this.path, x, y);
    this.hazards.push({
      id: this.nextId++, x, y, u: c.u, lat: c.lat,
      owner: ownerId, born: this.t, expires: this.t + 25000,
    });
  }

  // Race progress: sectors cleared + fraction of the way to the next one.
  _score(p) {
    let a = p.u * SECTORS - ((p.nextSector - 1 + SECTORS) % SECTORS);
    a = ((a % SECTORS) + SECTORS) % SECTORS;
    if (a > 2) a = 0; // going backwards / way off line: no partial credit
    return p.cpCount + Math.min(1, a);
  }

  // ---- powerups ----------------------------------------------------------
  _rollItem(p) {
    const active = this.players.filter((q) => !q.out && !q.finished);
    const n = active.length;
    // 0 = leading, 1 = last. Solo drivers sit in the middle.
    const pos = n > 1 ? clamp((active.filter((q) => q.score > p.score).length) / (n - 1), 0, 1) : 0.5;
    const lerp = (a, b) => a + (b - a) * pos;
    const w = {
      boost: 3,
      cab: lerp(4, 1),
      shield: lerp(3, 1.5),
      lock: lerp(2, 2.5),
      oops: lerp(0, 2.5),
      missile: lerp(1, 3),
      swap: n > 1 ? lerp(0, 2) : 0,
      freeze: lerp(0.5, 2),
      bug: lerp(1.5, 2),
      ink: n > 1 ? 2 : 0,
      giant: lerp(1, 2),
      auto: Math.max(0, pos - 0.5) * 6,
    };
    let total = 0;
    for (const k of ITEM_KEYS) total += w[k] || 0;
    let r = this.rng() * total;
    for (const k of ITEM_KEYS) {
      r -= w[k] || 0;
      if (r <= 0) return k;
    }
    return 'boost';
  }

  giveItem(id, item) { // tests + chaos
    const p = this.byId.get(id);
    if (p && !p.out && !p.finished) { p.item = item; p.botItemAt = this.t + 600 + this.rng() * 2400; }
  }

  useItem(id) {
    const p = this.byId.get(id);
    const t = this.t;
    if (!p || !p.item || p.out || p.finished || this.status !== 'racing') return;
    if (p.spinUntil > t || p.lockedUntil > t) return;
    const it = p.item;
    p.item = null;
    p.stats.items++;

    const others = this.players.filter((q) => q !== p && !q.out && !q.finished);
    const ahead = others.filter((q) => q.score > p.score).sort((a, b) => a.score - b.score);
    const behind = others.filter((q) => q.score <= p.score).sort((a, b) => b.score - a.score);
    const on = [];

    switch (it) {
      case 'boost': {
        this._boost(p, 2200, P.BOOST_MAX);
        p.vx += Math.cos(p.angle) * 130; p.vy += Math.sin(p.angle) * 130;
        break;
      }
      case 'shield':
        p.shieldUntil = t + 6000;
        break;
      case 'cab':
        this._addHazard(p.x - Math.cos(p.angle) * 56, p.y - Math.sin(p.angle) * 56, p.id);
        break;
      case 'lock': {
        const target = ahead[0] || behind[0];
        if (target && this._lock(target, 1700, p.id)) on.push(target.i);
        break;
      }
      case 'oops':
        for (const q of ahead) if (this._spin(q, 1300, p.id, 'oops')) on.push(q.i);
        break;
      case 'missile': {
        const target = ahead[0] || null;
        this.missiles.push({
          id: this.nextId++, owner: p.id, target: target ? target.id : null,
          u: p.u, x: p.x, y: p.y, angle: p.angle, born: t, mode: 'path',
        });
        if (target) on.push(target.i);
        break;
      }
      case 'swap': {
        const target = ahead[0];
        if (target && !this._immune(target)) {
          for (const k of ['x', 'y', 'angle', 'vx', 'vy', 'u', 'lat', 'nextSector', 'cpCount', 'lap', 'lapStartT']) {
            const tmp = p[k]; p[k] = target[k]; target[k] = tmp;
          }
          p.lapValid = false; target.lapValid = false;
          p.driftT = 0; target.driftT = 0;
          target.stats.hitsTaken++; p.stats.hitsDealt++;
          on.push(target.i);
        } else {
          if (target) this.emit({ k: 'block', i: target.i });
          this._boost(p, 1500, P.BOOST_MAX);
        }
        break;
      }
      case 'freeze':
        for (const q of others) if (!this._immune(q)) { q.frozenUntil = t + 4500; on.push(q.i); }
        break;
      case 'bug':
        for (const q of others) if (!this._immune(q)) { q.bugUntil = t + 5000; on.push(q.i); }
        break;
      case 'ink':
        for (const q of others) if (!this._immune(q)) { q.inkUntil = t + 5000; on.push(q.i); }
        break;
      case 'giant':
        p.giantUntil = t + 6500;
        break;
      case 'auto':
        p.autoUntil = t + 4200;
        break;
    }
    this.emit({ k: 'use', i: p.i, it, on });
  }

  // ---- chaos events ------------------------------------------------------
  _chaosDirector() {
    const t = this.t;
    if (this.chaos && this.chaos.until <= t) this.chaos = null;
    if (!this.chaosOn || this.chaos || t < this.nextChaosT) return;
    const active = this.order.filter((p) => !p.out && !p.finished);
    if (!active.length) return;

    let pool = ['freeze', 'turbo', 'cabstorm', 'outage', 'itemrain', 'regression', 'emergency'];
    if (active.length >= 2) pool.push('audit');
    pool = pool.filter((k) => k !== this.lastChaos);
    const k = pool[Math.floor(this.rng() * pool.length)];
    const dur = { freeze: 7000, turbo: 8000, outage: 8000, regression: 5500 }[k] || 2600;
    this.chaos = { k, until: t + dur };
    this.lastChaos = k;
    this.nextChaosT = t + dur + 12000 + this.rng() * 10000;

    if (k === 'cabstorm') {
      const hw = this.map.halfWidth;
      let placed = 0;
      for (let tries = 0; tries < 40 && placed < 8; tries++) {
        const pt = pointAt(this.path, this.rng());
        const lat = (this.rng() * 2 - 1) * (hw - 26);
        const x = pt.x - pt.ty * lat, y = pt.y + pt.tx * lat;
        if (active.some((p) => Math.hypot(p.x - x, p.y - y) < 170)) continue;
        this._addHazard(x, y, null);
        placed++;
      }
    } else if (k === 'itemrain') {
      for (const p of active) if (!p.item) this.giveItem(p.id, this._rollItem(p));
    } else if (k === 'emergency') {
      for (const p of active) this._boost(p, 2200, P.BOOST_MAX);
    } else if (k === 'audit') {
      this._lock(active[0], 1800, null);
    }
    this.emit({ k: 'chaos', c: k, d: dur });
  }

  // ---- per-tick simulation ----------------------------------------------
  tick() {
    if (this.over) return;
    this.t += DT_MS;
    const t = this.t;
    if (this.status === 'countdown' && t >= this.raceT0) {
      this.status = 'racing';
      for (const p of this.players) p.lapStartT = t;
      this.emit({ k: 'go' });
    }
    const racing = this.status === 'racing';
    if (racing) this._chaosDirector();

    for (const p of this.players) {
      if (p.out) continue;
      if (p.bot || p.finished || p.autoUntil > t) Bots.think(this, p);
      this._physics(p, racing);
    }
    if (!racing) return;

    this._slipstream();
    this._collide();
    this._updateMissiles();
    for (const b of this.boxes) if (!b.active && t >= b.respawnAt) b.active = true;
    this.hazards = this.hazards.filter((h) => h.expires > t);
    for (const p of this.players) {
      if (p.out || p.finished) continue;
      this._pickups(p);
      this._progress(p);
    }
    this._rank();
    if (this.mode === 'elimination') this._eliminate();
    this._checkEnd();
  }

  _physics(p, racing) {
    const t = this.t;
    const st = p.st;
    const hw = this.map.halfWidth;

    // where am I? global lookup decides the surface, windowed lookup the progress
    const surf = closest(this.path, p.x, p.y);
    let near = closestNear(this.path, p.x, p.y, p.u, 0.14);
    if (near.dist > hw * 3.2) near = surf;
    p.u = near.u;
    p.lat = near.lat;
    p.offTrack = surf.dist > hw + 4;

    const spinning = p.spinUntil > t;
    const locked = p.lockedUntil > t;
    const auto = p.autoUntil > t;
    const giant = p.giantUntil > t;
    const boosting = p.boostUntil > t;
    const immune = this._immune(p);
    const icy = !immune && (this._chaosIs('freeze') || p.frozenUntil > t || (!p.offTrack && this._inIce(p.u)));
    const oily = p.oilUntil > t && !immune;
    const turbo = this._chaosIs('turbo');
    p.icy = icy;

    if (spinning) {
      p.angle += 13 * DT;
      const damp = Math.exp(-2.2 * DT);
      p.vx *= damp; p.vy *= damp;
      p.drifting = false; p.driftT = 0;
      this._integrate(p);
      return;
    }

    const aiDriven = p.bot || p.finished || auto;
    const ctl = aiDriven ? p.ai : p.input;
    const canDrive = racing && !locked;
    let steer = 0, throttle = false, brake = false, wantDrift = false;
    if (canDrive) {
      steer = aiDriven ? ctl.s : (ctl.r ? 1 : 0) - (ctl.l ? 1 : 0);
      if (this.isInverted(p)) steer = -steer;
      throttle = !!ctl.u; brake = !!ctl.d; wantDrift = !!ctl.dr;
    }

    // steer first, then resolve velocity in the new heading frame
    const fwd0 = p.vx * Math.cos(p.angle) + p.vy * Math.sin(p.angle);
    const absf = Math.abs(fwd0);
    const drifting = canDrive && wantDrift && absf > 170 && steer !== 0 && !p.offTrack && !auto;
    let turn = P.TURN * st.handling * Math.min(1, absf / 150);
    turn *= 1 - 0.22 * clamp((absf - 320) / 380, 0, 1);
    if (drifting) turn *= 1.32;
    if (icy) turn *= 0.85;
    if (giant) turn *= 0.9;
    p.angle += steer * turn * DT * (fwd0 >= 0 ? 1 : -1);

    const c = Math.cos(p.angle), s = Math.sin(p.angle);
    let vf = p.vx * c + p.vy * s;
    let vl = -p.vx * s + p.vy * c;

    let maxSpd = P.BASE_MAX * st.speed;
    let acc = P.ACCEL * st.accel;
    if (turbo) { maxSpd *= 1.25; acc *= 1.3; }
    if (p.slip) maxSpd *= 1.07;
    if (boosting) { maxSpd = Math.max(maxSpd, p.boostCap); acc *= 2; }
    if (auto) { maxSpd = P.AUTO_SPEED; acc *= 2.2; }
    if (p.finished) maxSpd = Math.min(maxSpd, 260);
    // item boosts and autopilot ignore the grass; pads and mini-turbos do not
    const grassLimited = p.offTrack && !auto && !(boosting && p.boostCap >= P.BOOST_MAX);
    if (grassLimited) maxSpd = Math.min(maxSpd, P.OFF_MAX * st.offroad);
    if (icy) acc *= 0.55;

    if (throttle) {
      if (vf < maxSpd) vf = Math.min(maxSpd, vf + acc * DT);
    } else if (brake) {
      if (vf > 15) vf = Math.max(0, vf - P.BRAKE * (icy ? 0.35 : 1) * DT);
      else vf = Math.max(-P.REV_MAX, vf - 320 * DT);
    } else {
      vf -= vf * 0.75 * DT;
    }
    if (vf > maxSpd) vf -= (vf - maxSpd) * Math.min(1, (grassLimited ? 7 : 3.2) * DT);
    if (drifting) vf -= vf * 0.22 * DT;
    if (locked) vf *= Math.exp(-5 * DT);

    let grip = drifting ? P.GRIP_DRIFT : P.GRIP * st.handling;
    if (p.offTrack) grip *= 0.75;
    if (icy) grip *= 0.16;
    if (oily) grip *= 0.1;
    if (auto) grip = 14;
    vl *= Math.exp(-grip * DT);

    p.vx = c * vf - s * vl;
    p.vy = s * vf + c * vl;
    this._integrate(p);

    // drift charge → mini-turbo on release
    if (drifting) {
      p.driftT += DT;
      p.stats.drift += DT;
    } else if (p.drifting) {
      if (p.driftT >= 1.5) { this._boost(p, 1150, P.MINI_MAX[1]); this.emit({ k: 'mini', i: p.i, l: 2 }); }
      else if (p.driftT >= 0.7) { this._boost(p, 600, P.MINI_MAX[0]); this.emit({ k: 'mini', i: p.i, l: 1 }); }
      p.driftT = 0;
    }
    p.drifting = drifting;

    // wrong-way detection (heading against the track for a moment)
    if (racing && !p.finished) {
      const pt = pointAt(this.path, p.u);
      const against = vf > 80 && c * pt.tx + s * pt.ty < -0.35;
      p.wrongT = against ? Math.min(2, p.wrongT + DT) : 0;
    }
  }

  _integrate(p) {
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    if (p.x < 14) { p.x = 14; p.vx = Math.abs(p.vx) * 0.3; }
    if (p.x > WORLD.w - 14) { p.x = WORLD.w - 14; p.vx = -Math.abs(p.vx) * 0.3; }
    if (p.y < 14) { p.y = 14; p.vy = Math.abs(p.vy) * 0.3; }
    if (p.y > WORLD.h - 14) { p.y = WORLD.h - 14; p.vy = -Math.abs(p.vy) * 0.3; }
    p.speed = Math.hypot(p.vx, p.vy);
    if (p.speed > p.stats.top) p.stats.top = p.speed;
  }

  _slipstream() {
    for (const p of this.players) {
      if (p.out || p.finished) continue;
      let found = false;
      if (p.speed > 250) {
        const c = Math.cos(p.angle), s = Math.sin(p.angle);
        for (const q of this.players) {
          if (q === p || q.out || q.finished || q.speed < 220) continue;
          const dx = q.x - p.x, dy = q.y - p.y;
          const d = Math.hypot(dx, dy);
          if (d < 40 || d > 170) continue;
          if ((dx * c + dy * s) / d > 0.93) { found = true; break; }
        }
      }
      p.slipT = found ? Math.min(1.2, p.slipT + DT) : Math.max(0, p.slipT - DT * 2);
      p.slip = p.slipT > 0.45;
    }
  }

  _collide() {
    const t = this.t;
    const cars = this.players.filter((p) => !p.out && !p.finished);
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i], b = cars[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = this._radius(a) + this._radius(b);
        if (d <= 0.001 || d >= minD) continue;
        const nx = dx / d, ny = dy / d;
        const aBig = a.giantUntil > t, bBig = b.giantUntil > t;
        const ma = a.st.weight * (aBig ? 4 : 1) * (a.autoUntil > t ? 3 : 1);
        const mb = b.st.weight * (bBig ? 4 : 1) * (b.autoUntil > t ? 3 : 1);
        const overlap = minD - d;
        a.x -= nx * overlap * (mb / (ma + mb));
        a.y -= ny * overlap * (mb / (ma + mb));
        b.x += nx * overlap * (ma / (ma + mb));
        b.y += ny * overlap * (ma / (ma + mb));
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const jImp = (-(1 + 0.55) * rel) / (1 / ma + 1 / mb);
          a.vx -= (jImp / ma) * nx; a.vy -= (jImp / ma) * ny;
          b.vx += (jImp / mb) * nx; b.vy += (jImp / mb) * ny;
          if (-rel > 130 && t >= a.bumpCd && t >= b.bumpCd) {
            a.bumpCd = b.bumpCd = t + 260;
            this.emit({ k: 'bump', a: a.i, b: b.i, f: Math.round(-rel) });
            for (const q of [a, b]) if (q.bot && this.rng() < 0.2) this.honk(q.id);
          }
        }
        if (aBig && !bBig) this._spin(b, 1300, a.id, 'giant');
        else if (bBig && !aBig) this._spin(a, 1300, b.id, 'giant');
      }
    }
  }

  _updateMissiles() {
    const t = this.t;
    const total = this.path.total;
    const SPEED = 950;
    const keep = [];
    for (const m of this.missiles) {
      const age = t - m.born;
      let dead = age > 7000;
      const tgt = m.target ? this.byId.get(m.target) : null;
      const valid = tgt && !tgt.out && !tgt.finished;
      if (!dead) {
        if (m.mode === 'path') {
          m.u = wrap01(m.u + (SPEED * DT) / total);
          const pt = pointAt(this.path, m.u);
          m.x = pt.x; m.y = pt.y; m.angle = Math.atan2(pt.ty, pt.tx);
          if (valid && Math.hypot(tgt.x - m.x, tgt.y - m.y) < 280) m.mode = 'home';
        } else {
          if (valid) {
            const want = Math.atan2(tgt.y - m.y, tgt.x - m.x);
            m.angle += clamp(angNorm(want - m.angle), -6 * DT, 6 * DT);
          }
          m.x += Math.cos(m.angle) * SPEED * DT;
          m.y += Math.sin(m.angle) * SPEED * DT;
          if (m.x < 0 || m.x > WORLD.w || m.y < 0 || m.y > WORLD.h) dead = true;
        }
      }
      if (!dead) {
        for (const q of this.players) {
          if (q.out || q.finished) continue;
          if (q.id === m.owner && age < 1200) continue;
          if (Math.hypot(q.x - m.x, q.y - m.y) < this._radius(q) + 14) {
            this._spin(q, 1600, m.owner, 'missile');
            dead = true;
            break;
          }
        }
      }
      if (dead) this.emit({ k: 'boom', x: Math.round(m.x), y: Math.round(m.y) });
      else keep.push(m);
    }
    this.missiles = keep;
  }

  _pickups(p) {
    const t = this.t;
    // ? boxes
    if (!p.item) {
      for (const b of this.boxes) {
        if (!b.active) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < 46) {
          b.active = false;
          b.respawnAt = t + 3500;
          this.giveItem(p.id, this._rollItem(p));
          this.emit({ k: 'pickup', i: p.i, it: p.item });
          break;
        }
      }
    }
    // chevron boost pads
    if (!p.offTrack && t >= p.padCd) {
      for (const pad of this.map.boostPads) {
        if (Math.abs(uDiff(p.u, pad.u)) * this.path.total < 34) {
          this._boost(p, 950, P.PAD_MAX);
          p.padCd = t + 700;
          p.stats.pads++;
          this.emit({ k: 'pad', i: p.i });
          break;
        }
      }
    }
    // oil
    if (t >= p.oilCd && !this._immune(p)) {
      for (const o of this.map.oil) {
        if (Math.hypot(p.x - o.x, p.y - o.y) < o.r + 10) {
          p.oilUntil = t + 1000;
          p.oilCd = t + 2500;
          this.emit({ k: 'oil', i: p.i });
          break;
        }
      }
    }
    // CAB meetings
    for (const hz of this.hazards) {
      if (hz.expires <= t) continue;
      if (hz.owner === p.id && t - hz.born < 1200) continue;
      if (Math.hypot(p.x - hz.x, p.y - hz.y) < this._radius(p) + 22) {
        hz.expires = 0;
        if (p.giantUntil > t) this.emit({ k: 'boom', x: Math.round(hz.x), y: Math.round(hz.y) });
        else this._spin(p, 1400, hz.owner, 'cab');
      }
    }
  }

  _progress(p) {
    const t = this.t;
    const s = Math.floor(p.u * SECTORS) % SECTORS;
    if (s !== p.nextSector) return;
    p.nextSector = (s + 1) % SECTORS;
    p.cpCount++;
    if (s !== 0 || p.cpCount % SECTORS !== 0) return;

    const lapTime = t - p.lapStartT;
    p.lap = p.cpCount / SECTORS;
    p.lastLap = lapTime;
    let best = false;
    if (p.lapValid && (!p.bestLap || lapTime < p.bestLap)) { p.bestLap = lapTime; best = true; }
    p.lapValid = true;
    p.lapStartT = t;
    this.emit({ k: 'lap', i: p.i, lap: p.lap, t: Math.round(lapTime), best });
    if (this.mode === 'race') {
      if (p.lap >= this.laps) this._finish(p);
      else if (p.lap === this.laps - 1) this.emit({ k: 'final', i: p.i });
    }
  }

  _finish(p) {
    const t = this.t;
    p.finished = true;
    p.finishT = t;
    p.item = null;
    p.boostUntil = 0; p.giantUntil = 0; p.autoUntil = 0; p.shieldUntil = 0;
    this.finishCount++;
    if (!this.firstFinishT) {
      this.firstFinishT = t;
      this.endAt = Math.min(this.endAt, t + 30000);
    }
    this.emit({ k: 'finish', i: p.i, pos: this.finishCount, t: Math.round(t - this.raceT0) });
  }

  _rank() {
    for (const p of this.players) p.score = this._score(p);
    const cls = (p) => (p.finished ? 0 : p.out ? 2 : 1);
    this.order = this.players.slice().sort((a, b) => {
      const ca = cls(a), cb = cls(b);
      if (ca !== cb) return ca - cb;
      if (ca === 0) return a.finishT - b.finishT;
      if (ca === 2) return b.outT - a.outT;
      return b.score - a.score;
    });
    this.order.forEach((p, i) => { p.rank = i + 1; });
  }

  _eliminate() {
    const t = this.t;
    let active = this.order.filter((p) => !p.out && !p.finished);
    if (active.length > 1 && t >= this.nextElimT) {
      this._out(active[active.length - 1], 'elim');
      this.nextElimT = t + ELIM_EVERY_MS;
      active = active.slice(0, -1);
      this._rank();
    }
    if (active.length === 1) this._finish(active[0]);
  }

  _checkEnd() {
    const t = this.t;
    const left = this.players.filter((p) => !p.finished && !p.out);
    if (!left.length) return this._end();
    // only bots still circulating: give them a moment to finish, then wrap up
    if (this.hasHumans && !left.some((p) => !p.bot) && this.endAt > t + 10000) this.endAt = t + 10000;
    if (t >= this.endAt || t - this.raceT0 > MAX_RACE_MS) this._end();
  }

  _end() {
    this._rank();
    this.over = true;
    this.status = 'finished';
    this.emit({ k: 'over' });
  }

  // ---- output ------------------------------------------------------------
  staticInfo() {
    return {
      mapId: this.map.id, laps: this.laps, mode: this.mode, chaos: this.chaosOn, t0: this.raceT0,
      roster: this.players.map((p) => ({ id: p.id, name: p.name, carId: p.carId, bot: !!p.bot })),
    };
  }

  _flags(p) {
    const t = this.t;
    let f = 0;
    if (p.boostUntil > t) f |= F.BOOST;
    if (p.spinUntil > t) f |= F.SPIN;
    if (p.lockedUntil > t) f |= F.LOCKED;
    if (p.shieldUntil > t) f |= F.SHIELD;
    if (p.giantUntil > t) f |= F.GIANT;
    if (p.autoUntil > t) f |= F.AUTO;
    if (p.icy) f |= F.ICY;
    if (this.isInverted(p)) f |= F.BUG;
    if (p.inkUntil > t) f |= F.INK;
    if (p.drifting) f |= F.DRIFT;
    if (p.finished) f |= F.FINISHED;
    if (p.out) f |= F.OUT;
    if (p.wrongT > 0.7) f |= F.WRONG;
    if (p.offTrack) f |= F.OFF;
    if (p.slip) f |= F.SLIP;
    if (p.oilUntil > t) f |= F.OIL;
    return f;
  }

  // Dynamic state; drains the event queue.
  snapshot() {
    const ev = this.events;
    this.events = [];
    return {
      t: Math.round(this.t),
      st: this.status,
      p: this.players.map((p) => ({
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        a: Math.round(p.angle * 1000) / 1000,
        v: Math.round(p.speed),
        f: this._flags(p),
        it: p.item || 0,
        lap: p.lap,
        rk: p.rank,
        d: p.drifting ? (p.driftT >= 1.5 ? 3 : p.driftT >= 0.7 ? 2 : 1) : 0,
      })),
      hz: this.hazards.map((h) => [h.id, Math.round(h.x), Math.round(h.y)]),
      bx: this.boxes.filter((b) => !b.active).map((b) => b.id),
      ms: this.missiles.map((m) => [m.id, Math.round(m.x), Math.round(m.y), Math.round(m.angle * 100) / 100]),
      ch: this.chaos && this.chaos.until > this.t ? [this.chaos.k, Math.round(this.chaos.until)] : 0,
      el: this.mode === 'elimination' ? Math.round(this.nextElimT) : 0,
      ev,
    };
  }

  results() {
    return this.order.map((p, idx) => ({
      id: p.id, i: p.i, name: p.name, carId: p.carId, bot: !!p.bot,
      pos: idx + 1,
      finished: p.finished,
      out: p.out,
      time: p.finished ? Math.round(p.finishT - this.raceT0) : null,
      laps: p.lap,
      bestLap: p.bestLap ? Math.round(p.bestLap) : null,
      stats: {
        hitsDealt: p.stats.hitsDealt, hitsTaken: p.stats.hitsTaken, items: p.stats.items,
        drift: Math.round(p.stats.drift * 10) / 10, top: Math.round(p.stats.top), pads: p.stats.pads,
      },
    }));
  }

  awards() {
    const ps = this.players;
    const out = [];
    const top = (key, fn, fmt, min = 0, lowest = false) => {
      let best = null, bestV = lowest ? Infinity : min;
      for (const p of ps) {
        const v = fn(p);
        if (v == null || !(lowest ? v < bestV : v > bestV)) continue;
        best = p; bestV = v;
      }
      if (best) out.push({ key, i: best.i, name: best.name, value: fmt(bestV) });
    };
    const lapStr = (ms) => (ms / 1000).toFixed(2) + 's';
    top('fastestLap', (p) => p.bestLap || null, lapStr, 0, true);
    top('wrecker', (p) => p.stats.hitsDealt, (v) => `${v} hit${v === 1 ? '' : 's'} landed`);
    top('magnet', (p) => p.stats.hitsTaken, (v) => `hit ${v} time${v === 1 ? '' : 's'}`, 1);
    top('drift', (p) => p.stats.drift, (v) => v.toFixed(1) + 's sideways', 2);
    top('items', (p) => p.stats.items, (v) => `${v} powerups used`, 1);
    top('speed', (p) => p.stats.top, (v) => Math.round(v * 0.5) + ' km/h');
    return out;
  }
}

module.exports = { Race, TICK_RATE, DT_MS, P };
