/** Unit tests for projectiles.js — the pure half of the powerup projectiles.
 *  Usage: node test/projectiles.js */
const RTMaps = require('../public/maps.js');
const P = require('../projectiles.js');

const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

const DT = 1 / 30;
const near = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);

// Minimal player stand-in: only the fields projectiles.js actually reads.
function car(o) {
  return Object.assign({
    id: 'c1', x: 800, y: 500, angle: 0,
    shieldUntil: 0, finished: false, retired: false,
  }, o);
}

console.log('projectiles.js — spawn');

const owner = car({ id: 'owner', x: 100, y: 100, angle: 0 });
const s0 = P.spawn('conflict', owner, null, 1000, 's1');
check('spawns ahead of the nose, not on it',
  near(s0.x, 100 + P.SPAWN_OFFSET) && near(s0.y, 100));
check('inherits the firer heading', near(s0.angle, 0));
check('records its owner', s0.ownerId === 'owner');
check('carries a lifetime', s0.expiresAt === 1000 + P.SHOT_LIFETIME_MS);
check('every kind is spawnable', P.KINDS.every((k) => !!P.spawn(k, owner, null, 0, 'x')));

console.log('projectiles.js — straight flight');

const straight = P.spawn('conflict', car({ x: 800, y: 500, angle: 0 }), null, 0, 's');
const beforeAngle = straight.angle;
P.advance(straight, car({ x: 800, y: 200 }), null, DT); // a car off to one side
check('a straight shot does not steer', near(straight.angle, beforeAngle));
check('a straight shot moves SHOT_SPEED * dt',
  near(straight.x, 800 + P.SPAWN_OFFSET + P.SHOT_SPEED * DT, 1e-6));

console.log('projectiles.js — homing');

// Target dead ahead: the shot should stay pointed at it.
const h1 = P.spawn('request', car({ x: 100, y: 500, angle: 0 }), 't', 0, 'h1');
P.advance(h1, car({ id: 't', x: 900, y: 500 }), null, DT);
check('a homing shot already on target does not wobble', near(h1.angle, 0, 1e-9));

// Target at 90 degrees: the turn must be capped, not instant.
const h2 = P.spawn('request', car({ x: 800, y: 500, angle: 0 }), 't', 0, 'h2');
const target90 = car({ id: 't', x: 800, y: 900 });
P.advance(h2, target90, null, DT);
check('a homing turn is capped at HOMING_TURN * dt',
  near(h2.angle, P.HOMING_TURN * DT, 1e-9));
check('one tick is not enough to face a 90-degree target',
  h2.angle < Math.PI / 2);

// Target directly behind: it must come about over several ticks, never snap.
const h3 = P.spawn('request', car({ x: 800, y: 500, angle: 0 }), 't', 0, 'h3');
const behind = car({ id: 't', x: 200, y: 500 });
let ticksToTurn = 0;
for (let i = 0; i < 200; i++) {
  const before = h3.angle;
  P.advance(h3, behind, null, DT);
  ticksToTurn++;
  if (Math.abs(P.angleDelta(before, h3.angle)) > P.HOMING_TURN * DT + 1e-9) break;
}
check('a shot cannot snap around to a target behind it', ticksToTurn > 5);

// Convergence: against a stationary target the shot closes the distance.
const h4 = P.spawn('request', car({ x: 200, y: 500, angle: 0 }), 't', 0, 'h4');
const sitting = car({ id: 't', x: 900, y: 560 });
const d0 = Math.hypot(sitting.x - h4.x, sitting.y - h4.y);
for (let i = 0; i < 20; i++) P.advance(h4, sitting, null, DT);
const d1 = Math.hypot(sitting.x - h4.x, sitting.y - h4.y);
check('a homing shot closes on a stationary target', d1 < d0);

// A finished target is not chased.
const h5 = P.spawn('request', car({ x: 800, y: 500, angle: 0 }), 't', 0, 'h5');
P.advance(h5, car({ id: 't', x: 800, y: 900, finished: true }), null, DT);
check('a finished target is not homed on', near(h5.angle, 0));

console.log('projectiles.js — reflection');

const r1 = P.reflect(1, 0, -1, 0);
check('head-on reflection reverses direction', near(r1.vx, -1) && near(r1.vy, 0));
const r2 = P.reflect(1, -1, 0, 1);
check('angle in equals angle out', near(r2.vx, 1) && near(r2.vy, 1));
const twice = P.reflect(r2.vx, r2.vy, 0, 1);
check('reflecting twice about one normal restores the original',
  near(twice.vx, 1) && near(twice.vy, -1));
const r3 = P.reflect(0.6, 0.8, 1, 0);
check('reflection preserves magnitude',
  near(Math.hypot(r3.vx, r3.vy), 1, 1e-9));

console.log('projectiles.js — bouncing off the track corridor');

const map = RTMaps.MAPS[0];
// Aim a shot straight at the outside edge from the centreline.
const at = RTMaps.pointAt(map.path, 0.25);
const outward = Math.atan2(-at.tx, at.ty); // perpendicular to travel
const b1 = P.spawn('segregation', car({ x: at.x, y: at.y, angle: outward }), null, 0, 'b1');
let bounced = false;
for (let i = 0; i < 40 && !b1.dead; i++) {
  P.advance(b1, null, map, DT);
  if (b1.bounces > 0) { bounced = true; break; }
}
check('a shot driven at the corridor edge bounces', bounced);
check('after bouncing it is back inside the corridor',
  RTMaps.closest(map.path, b1.x, b1.y).dist <= map.halfWidth);

// It must turn back toward the centreline, not carry on through the edge.
const beforeDist = RTMaps.closest(map.path, b1.x, b1.y).dist;
P.advance(b1, null, map, DT);
check('a bounce sends it back toward the centreline',
  RTMaps.closest(map.path, b1.x, b1.y).dist < beforeDist);

// Bounces are capped so a shot cannot ricochet forever.
const b2 = P.spawn('segregation', car({ x: at.x, y: at.y, angle: outward }), null, 0, 'b2');
for (let i = 0; i < 2000 && !b2.dead; i++) P.advance(b2, null, map, DT);
check('bouncing is capped, the shot eventually dies', b2.dead);
check('it did not exceed the bounce cap by more than one',
  b2.bounces <= P.MAX_BOUNCES + 1);

// A straight shot leaving the world despawns.
const esc = P.spawn('conflict', car({ x: 1550, y: 500, angle: 0 }), null, 0, 'e');
for (let i = 0; i < 20 && !esc.dead; i++) P.advance(esc, null, null, DT);
check('a shot that leaves the world despawns', esc.dead);

console.log('projectiles.js — hit test');

const shot = P.spawn('conflict', car({ id: 'owner', x: 500, y: 500, angle: 0 }), null, 0, 's');
shot.x = 800; shot.y = 500;                   // place it on top of the victims

const victim = car({ id: 'v', x: 800, y: 500 });
const far = car({ id: 'f', x: 1200, y: 500 });
check('a car on the shot is hit', P.hitTest(shot, [victim], 2000).length === 1);
check('a distant car is not hit', P.hitTest(shot, [far], 2000).length === 0);
check('a shielded car is skipped',
  P.hitTest(shot, [car({ id: 'v', x: 800, y: 500, shieldUntil: 9999 })], 2000).length === 0);
check('a finished car is skipped',
  P.hitTest(shot, [car({ id: 'v', x: 800, y: 500, finished: true })], 2000).length === 0);
check('a retired car is skipped',
  P.hitTest(shot, [car({ id: 'v', x: 800, y: 500, retired: true })], 2000).length === 0);

// Owner immunity, then vulnerability -- the ricochet-into-yourself case.
const ownerCar = car({ id: 'owner', x: 800, y: 500 });
check('the firer is immune immediately after firing',
  P.hitTest(shot, [ownerCar], 500).length === 0);
check('the firer becomes vulnerable to their own ricochet',
  P.hitTest(shot, [ownerCar], P.OWNER_IMMUNE_MS + 50).length === 1);

// Only the nearest for non-request kinds; the blast for request.
const a = car({ id: 'a', x: 800, y: 500 });
const b = car({ id: 'b', x: 800 + P.BLAST_RADIUS - 10, y: 500 });
check('a straight shot hits only the nearest car',
  P.hitTest(shot, [a, b], 2000).length === 1);

const boom = P.spawn('request', car({ id: 'owner', x: 100, y: 100 }), 'a', 0, 'r');
boom.x = 800; boom.y = 500;
const blast = P.hitTest(boom, [a, b], 2000);
check('a request explodes and catches nearby cars', blast.length === 2);
check('the blast still respects shields',
  P.hitTest(boom, [a, car({ id: 'b', x: 810, y: 500, shieldUntil: 9999 })], 2000).length === 1);
const outOfBlast = car({ id: 'c', x: 800 + P.BLAST_RADIUS + 40, y: 500 });
check('cars beyond the blast radius are spared',
  P.hitTest(boom, [a, outOfBlast], 2000).every((p) => p.id !== 'c'));

console.log('projectiles.js — target selection');

const scoreOf = (p) => p.score;
const me = car({ id: 'me' }); me.score = 5;
const leader = car({ id: 'lead' }); leader.score = 20;
const mid = car({ id: 'mid' }); mid.score = 10;
check('targets the highest-ranked other player',
  P.pickTarget([me, leader, mid], me, scoreOf).id === 'lead');
check('never targets the firer',
  P.pickTarget([me, mid], me, scoreOf).id === 'mid');

const doneLeader = car({ id: 'lead', finished: true }); doneLeader.score = 20;
check('skips a finished leader and takes the next',
  P.pickTarget([me, doneLeader, mid], me, scoreOf).id === 'mid');
const goneLeader = car({ id: 'lead', retired: true }); goneLeader.score = 20;
check('skips a retired leader',
  P.pickTarget([me, goneLeader, mid], me, scoreOf).id === 'mid');
check('a solo race has no target', P.pickTarget([me], me, scoreOf) === null);

// The leader firing one: the target is whoever is second, never themselves.
const asLeader = leader;
check('the leader targets the next player down, not themselves',
  P.pickTarget([me, asLeader, mid], asLeader, scoreOf).id === 'mid');

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
