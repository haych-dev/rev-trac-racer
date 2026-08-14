/* Rev-Trac Racer — projectile powerups (shared: server simulates, client renders).
 *
 * The first thing in this game that moves under its own power. Every other
 * powerup is instant-effect and the CAB hazard sits still, so all of the
 * movement, homing and collision logic lives here rather than swelling
 * server.js further.
 *
 * Everything in this file is PURE: no timers, no sockets, no room state. `now`
 * and `dt` are always passed in. That is what makes test/projectiles.js able to
 * step a shot deterministically and assert on the result.
 *
 * The server is authoritative over every shot. Clients receive positions to
 * draw and never report a hit -- a client that could would be able to fabricate
 * one, which is the whole class of cheat the identity work exists to prevent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./public/maps.js'));
  else root.RTShots = factory(root.RTMaps);
})(typeof self !== 'undefined' ? self : this, function (RTMaps) {
  const SHOT_SPEED = 780;        // > BOOST_SPEED (660), so a shot closes on a boosting car
  const SHOT_LIFETIME_MS = 5000;
  const SHOT_RADIUS = 10;
  const CAR_RADIUS = 18;         // mirrors server.js; collision needs both halves
  const HIT_DIST = CAR_RADIUS + SHOT_RADIUS;
  const HOMING_TURN = 2.6;       // rad/s -- tracks, but a hard corner can shake it
  const BLAST_RADIUS = 70;
  const SPIN_MS = 1300;          // matches the existing `oops` spin
  const MAX_BOUNCES = 6;
  const SPAWN_OFFSET = 28;       // clear of the firer's own nose on frame one
  const OWNER_IMMUNE_MS = 1000;
  const WORLD_W = 1600, WORLD_H = 1000;

  const KINDS = ['request', 'segregation', 'conflict'];

  // Smallest signed angle from a to b, in (-PI, PI]. Without this a shot whose
  // target is slightly clockwise would turn the long way round.
  function angleDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function spawn(kind, player, targetId, now, id) {
    const angle = player.angle;
    return {
      id,
      kind,
      x: player.x + Math.cos(angle) * SPAWN_OFFSET,
      y: player.y + Math.sin(angle) * SPAWN_OFFSET,
      angle,
      ownerId: player.id,
      targetId: targetId || null,
      bornAt: now,
      expiresAt: now + SHOT_LIFETIME_MS,
      bounces: 0,
      dead: false,
    };
  }

  // Mirror law: v' = v - 2 (v . n) n, with n a unit normal.
  function reflect(vx, vy, nx, ny) {
    const dot = vx * nx + vy * ny;
    return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
  }

  // One tick of flight. Mutates and returns the shot.
  //  - `request` steers toward `target`, capped at HOMING_TURN per second
  //  - `segregation` reflects off the track corridor edge
  //  - `conflict` flies straight
  function advance(shot, target, map, dt) {
    if (shot.kind === 'request' && target && !target.finished && !target.retired) {
      const want = Math.atan2(target.y - shot.y, target.x - shot.x);
      const diff = angleDelta(shot.angle, want);
      const max = HOMING_TURN * dt;
      shot.angle += Math.max(-max, Math.min(max, diff));
    }

    shot.x += Math.cos(shot.angle) * SHOT_SPEED * dt;
    shot.y += Math.sin(shot.angle) * SHOT_SPEED * dt;

    if (shot.kind === 'segregation' && map) {
      // Reflect off the corridor rather than the world bounds: the circuits sit
      // in the middle of a 1600x1000 world, so a shot bouncing off the world
      // edge would spend its life over grass no car ever drives on.
      const near = RTMaps.closest(map.path, shot.x, shot.y);
      if (near.dist > map.halfWidth - SHOT_RADIUS) {
        const at = RTMaps.pointAt(map.path, near.u);
        let nx = shot.x - at.x, ny = shot.y - at.y;
        const len = Math.hypot(nx, ny);
        if (len > 1e-6) {
          nx /= len; ny /= len;
          const v = reflect(Math.cos(shot.angle), Math.sin(shot.angle), nx, ny);
          shot.angle = Math.atan2(v.vy, v.vx);
          // Nudge back inside so the next tick cannot re-trigger on the same
          // frame's overshoot and flip the shot straight back out.
          shot.x = at.x + nx * (map.halfWidth - SHOT_RADIUS - 2);
          shot.y = at.y + ny * (map.halfWidth - SHOT_RADIUS - 2);
          shot.bounces++;
          if (shot.bounces > MAX_BOUNCES) shot.dead = true;
        }
      }
    }

    // Belt and braces: a numerical edge case must not leave a shot loose forever.
    if (shot.x < 0 || shot.x > WORLD_W || shot.y < 0 || shot.y > WORLD_H) shot.dead = true;
    return shot;
  }

  // Who does this shot hit right now?
  //  - `request` explodes: every eligible car within BLAST_RADIUS
  //  - the other two hit only the nearest eligible car
  // Shielded, finished and retired cars are skipped, and so is the firer during
  // their immunity window -- after which their own ricochet can catch them.
  function hitTest(shot, players, now) {
    const eligible = [];
    for (const p of players) {
      if (p.finished || p.retired) continue;
      if (p.shieldUntil > now) continue;
      if (p.id === shot.ownerId && now - shot.bornAt < OWNER_IMMUNE_MS) continue;
      const d = Math.hypot(p.x - shot.x, p.y - shot.y);
      if (d <= HIT_DIST) eligible.push({ p, d });
    }
    if (!eligible.length) return [];
    if (shot.kind !== 'request') {
      eligible.sort((a, b) => a.d - b.d);
      return [eligible[0].p];
    }
    // Blast: the direct hit plus everyone caught in the radius around it.
    const hit = eligible.sort((a, b) => a.d - b.d)[0].p;
    const caught = [];
    for (const p of players) {
      if (p.finished || p.retired) continue;
      if (p.shieldUntil > now) continue;
      if (p.id === shot.ownerId && now - shot.bornAt < OWNER_IMMUNE_MS) continue;
      if (Math.hypot(p.x - hit.x, p.y - hit.y) <= BLAST_RADIUS) caught.push(p);
    }
    return caught;
  }

  // The highest-ranked player who is not the firer. For everyone except the
  // leader that IS the leader, and unlike "always rank 1" it is always defined
  // the moment the leader picks one of these up.
  function pickTarget(players, firer, scoreOf) {
    let best = null, bestScore = -Infinity;
    for (const p of players) {
      if (p.id === firer.id || p.finished || p.retired) continue;
      const s = scoreOf(p);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best;
  }

  return {
    KINDS, spawn, advance, reflect, hitTest, pickTarget, angleDelta,
    SHOT_SPEED, SHOT_LIFETIME_MS, SHOT_RADIUS, HIT_DIST, HOMING_TURN,
    BLAST_RADIUS, SPIN_MS, MAX_BOUNCES, SPAWN_OFFSET, OWNER_IMMUNE_MS,
  };
});
