'use strict';
/* AI drivers. think() fills p.ai = { u, d, s, dr } each tick: throttle, brake,
 * analog steer in [-1, 1], drift. The same routine drives bot racers, the
 * Automation powerup, and finished cars on their victory lap. */
const RTMaps = require('../public/maps.js');
const { pointAt, uDiff, angNorm } = RTMaps;

// pace: fraction of top speed used   corner: how hard corners are attacked
// wobble: steering sloppiness        react: ms to adapt to inverted steering
const SKILLS = {
  easy:   { key: 'easy',   pace: 0.80, corner: 225, drift: false, wobble: 0.10, react: 1000 },
  medium: { key: 'medium', pace: 0.90, corner: 265, drift: false, wobble: 0.05, react: 600 },
  hard:   { key: 'hard',   pace: 0.98, corner: 300, drift: true,  wobble: 0.02, react: 300 },
};
// A bot stranded on the grass this long gives up and resets, as a person would with R.
const OFF_TRACK_RESET_S = 3.5;
const PRO = { key: 'pro', pace: 1, corner: 320, drift: false, wobble: 0, react: 0 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function think(race, p) {
  const ai = p.ai;
  const t = race.t;
  if (race.status !== 'racing') {
    ai.u = false; ai.d = false; ai.s = 0; ai.dr = false;
    return;
  }
  const map = race.map, path = race.path, total = path.total, hw = map.halfWidth;
  const auto = p.autoUntil > t;
  const sk = auto || p.finished || !p.bot ? PRO : p.bot.skill;
  const racingBot = !!p.bot && !p.finished && !auto;
  const speed = p.speed;

  // ---- pick a point to aim at -------------------------------------------
  const look = 80 + speed * 0.26;
  const tp = pointAt(path, p.u + look / total);
  const maxLane = hw - 28;
  let lane = racingBot ? p.bot.lane * (hw - 34) : 0;
  if (p.offTrack) lane = 0;

  if (racingBot && !p.offTrack) {
    // steer around CAB meetings and oil
    const dodge = (o) => {
      const du = uDiff(o.u, p.u) * total;
      if (du > 10 && du < look + 90 && Math.abs(o.lat - lane) < 44) {
        lane = clamp(o.lat + (o.lat > 0 ? -72 : 72), -maxLane, maxLane);
      }
    };
    for (const hz of race.hazards) dodge(hz);
    for (const o of map.oil) dodge(o);
    // pull out to pass a slower car directly ahead
    for (const q of race.players) {
      if (q === p || q.out || q.finished) continue;
      const du = uDiff(q.u, p.u) * total;
      if (du > 15 && du < 115 && Math.abs(q.lat - lane) < 30 && q.speed < speed - 10) {
        lane = clamp(q.lat + (q.lat > 0 ? -50 : 50), -maxLane, maxLane);
      }
    }
  }

  const gx = tp.x - tp.ty * lane, gy = tp.y + tp.tx * lane;
  let da = angNorm(Math.atan2(gy - p.y, gx - p.x) - p.angle);
  if (sk.wobble) da += Math.sin(t * 0.004 + p.i * 1.7) * sk.wobble;
  if (racingBot && p.inkUntil > t) da += Math.sin(t * 0.011 + p.i) * 0.35;
  let steer = clamp(da * 2.6, -1, 1);

  // Inverted steering: bots take a moment to adapt, like people do. Until
  // then they are confused rather than committed — half-hearted inputs and
  // off the throttle — instead of holding full lock the wrong way.
  const inverted = race.isInverted(p);
  let confused = false;
  if (inverted) {
    if (!p.invSince) p.invSince = t;
    if (t - p.invSince > sk.react) steer = -steer;
    else { steer *= 0.5; confused = true; }
  } else {
    p.invSince = 0;
  }

  // ---- speed: slow for what is coming -----------------------------------
  const h1 = pointAt(path, p.u + 40 / total);
  const h2 = pointAt(path, p.u + (150 + speed * 0.42) / total);
  const turnAhead = Math.abs(angNorm(Math.atan2(h2.ty, h2.tx) - Math.atan2(h1.ty, h1.tx)));
  let vCorner = sk.corner / (0.22 + turnAhead);
  if (p.icy) vCorner *= 0.72;
  let vTop = race.P.BASE_MAX * p.st.speed * sk.pace;
  if (p.boostUntil > t || auto) vTop = Infinity;
  if (p.finished) vTop = 250;
  const target = Math.min(vTop, vCorner);

  ai.u = speed < target && !confused;
  ai.d = speed > target * 1.18 && speed > 140;
  ai.s = steer;
  ai.dr = racingBot && sk.drift && Math.abs(da) > 0.5 && speed > 290 && !p.icy;

  if (!racingBot) return;

  // ---- unstick -----------------------------------------------------------
  if (speed < 28 && p.spinUntil <= t && p.lockedUntil <= t) {
    p.stuckT += race.P.DT;
    if (p.stuckT > 2.2) {
      p.stuckT = 0;
      race.resetCar(p.id, 500);
    }
  } else {
    p.stuckT = 0;
  }
  // stranded on the grass
  p.bot.offT = p.offTrack ? (p.bot.offT || 0) + race.P.DT : 0;
  if (p.bot.offT > OFF_TRACK_RESET_S) {
    p.bot.offT = 0;
    race.resetCar(p.id, 500);
  }

  // ---- powerups ----------------------------------------------------------
  if (p.item && t >= p.botItemAt) {
    const waited = t - p.botItemAt;
    let use = true;
    switch (p.item) {
      case 'cab':
        use = waited > 5000 || race.players.some((q) => {
          if (q === p || q.out || q.finished) return false;
          const behind = uDiff(p.u, q.u) * total;
          return behind > 20 && behind < 260;
        });
        break;
      case 'boost':
      case 'auto':
        use = turnAhead < 0.35 || waited > 4000;
        break;
      case 'lock':
      case 'missile':
      case 'swap':
      case 'oops':
        use = p.rank > 1 || waited > 6000;
        break;
      default:
        use = true;
    }
    if (use) race.useItem(p.id);
  }
}

module.exports = { think, SKILLS };
