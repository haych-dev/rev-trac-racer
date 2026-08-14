# Projectile powerups — design

**Date:** 2026-08-14
**Status:** approved
**Goal:** add three arrow projectiles — a homing Rev-Trac Request, a bouncing Segregation of
Duties, and a straight-flying Conflict Check — taking the roster from five powerups to eight.

## 1. Why this is bigger than it looks

Every existing powerup is instant-effect. `boost`, `shield`, `lock` and `oops` set a timer on
a player the moment they fire; `cab` drops a hazard that then **sits still**. Nothing in this
game has ever moved under its own power.

So this is not "three more entries in `ITEMS`". It is a projectile system inside the
server-authoritative simulation: entities with velocity, integrated each tick, collided
against cars, expired on a lifetime. That is the code most likely to break a race, and the
code that must stay authoritative — a client that could simulate its own projectiles could
fabricate hits, which is exactly the class of cheat the identity work was built to prevent.

## 2. The three arrows

| Item id | Name | Flight | On hit |
|---|---|---|---|
| `request` | Rev-Trac Request | Homes toward its target, turn rate capped so it can be out-driven | Explodes: spins the target **and every unshielded car within `BLAST_RADIUS`** |
| `segregation` | Rev-Trac Segregation of Duties | Reflects off the track edges, ricocheting along the corridor | Spins the first car it touches, then despawns |
| `conflict` | Rev-Trac Conflict Check | Straight along the firing car's heading | Spins the first car it touches, then despawns |

`conflict`'s name is chosen so the mechanic explains itself: a conflict check finds the first
conflict in its path.

**Constants** (world px, seconds; car is 420 and 660 boosted, tick is 30Hz, `CAR_RADIUS` 18):

- `SHOT_SPEED = 780` — faster than a boosting car, so it closes, but not instantly.
- `SHOT_LIFETIME_MS = 5000`, `SHOT_RADIUS = 10`, `HIT_DIST = CAR_RADIUS + SHOT_RADIUS`.
- `HOMING_TURN = 2.6 rad/s` — enough to track, loose enough that a hard corner can shake it.
- `BLAST_RADIUS = 70`, `SPIN_MS = 1300` (matching the existing `oops` spin).
- `MAX_SHOTS_PER_ROOM = 24`, `OWNER_IMMUNE_MS = 1000`.
- Spawn offset `28`px ahead of the nose, so a shot never collides with its own firer on frame one.

## 3. Targeting and balance

**`request` targets the highest-ranked player who is not the firer**, using the existing
`scoreOf()`. For everyone except the leader that *is* the leader, which is the requested
behaviour; and it is always defined, which "always target rank 1" is not the moment the
leader picks one up. Finished and retired players are never targets. With no valid target
(a solo race) the item is consumed and nothing spawns — consistent with `lock`, which
already no-ops when nobody is ahead.

**The existing 5s Emergency Change shield blocks all three**, exactly as it already blocks
`lock` and `oops`. A shielded car is skipped by the hit test rather than despawning the
shot, so the shot flies on.

**The firer is immune for `OWNER_IMMUNE_MS`, then vulnerable to their own shot.** Irrelevant
for the two that fly away; for `segregation` it means a bad angle can ricochet back into you.
That is a real cost on a strong item, and the funniest outcome in the set.

`rollItem` keeps its existing catch-up shape — players in the back half get better odds on
the aggressive items. The three new ones join that table; `request` is weighted higher for
players at the back and zero for the current leader, who has nobody ahead to request.

## 4. Bouncing off the track, not the world

`segregation` reflects off the **track corridor**, not the world bounds. `RTMaps.closest()`
already returns distance from the centreline, so when a shot exceeds `halfWidth` the
velocity is reflected about the track normal:

```
n = normalise(shot - closestPointOnCentreline)
v' = v - 2 (v · n) n
```

World bounds were the obvious alternative and are wrong: the circuits sit in the middle of a
1600×1000 world, so an arrow bouncing off the world edge spends most of its life sailing over
empty grass where no car will ever be. The corridor is where the cars are.

Bounces are capped at `MAX_BOUNCES = 6`, and a shot that somehow ends up outside the world
rectangle despawns — a belt-and-braces guard so a numerical edge case cannot leave a shot
ricocheting forever.

## 5. Architecture

New `projectiles.js`, UMD-wrapped like `maps.js`, `cars.js` and `scenery.js`, holding **pure
functions with no server import**:

- `spawn(kind, player, targetId, now) -> shot`
- `advance(shot, target, map, dtSeconds) -> shot` — integrates, homes, reflects
- `reflect(vx, vy, nx, ny) -> {vx, vy}`
- `pickTarget(players, firer) -> player | null`
- `hitTest(shot, players, now) -> player[]`

`server.js` owns `room.shots`, calls these in `tick()`, and applies effects. The split exists
for testability: homing turn-rate, reflection and collision are precisely the maths that goes
subtly wrong, and as pure functions they get a `test/projectiles.js` in this repo's plain-node
style — `check(label, cond)`, `PASS (N checks)`, `process.exit(failed ? 1 : 0)`. No framework,
no new dependency. It also keeps `server.js` — already 811 lines — from absorbing the whole
system.

**Wire format** gains `shots: [{ id, x, y, angle, kind }]`, rounded like the player fields.
No target id and no owner id go over the wire: a client has no legitimate use for them, and
the leaderboard work established that the wire format leaks nothing it does not have to.

**Clients render only.** No client-side projectile simulation, no client-reported hits.

## 6. Client

Three arrow glyphs drawn on the race canvas, distinguished by colour:

- `request` crimson `#e0353d`, with a faint pulse ring so a seeking missile reads as dangerous
- `segregation` purple `#8a5cc4`
- `conflict` cyan `#00b3d6`

Each is a filled triangle with a short tail, rotated to `angle`, sized to read at track scale
without obscuring the car it is chasing.

The how-to block gains the three entries. That takes it to eight powerups, which is a lot to
hold in your head; the block was restructured into a scannable two-column layout in the
previous change, and the three additions are written to the same name-over-description shape.

The HUD item label and colour come from the same table as the existing five.

## 7. Testing

`test/projectiles.js`, new, covering the pure half:

- a straight shot travels `SHOT_SPEED * dt` per tick along its heading and does not turn.
- a homing shot turns toward its target, never by more than `HOMING_TURN * dt` in one tick,
  and converges when the target holds still.
- a homing shot whose target is directly behind it takes multiple ticks to come about — it
  cannot snap around instantly.
- `reflect()` obeys the mirror law: the angle of incidence equals the angle of reflection, and
  reflecting twice about the same normal returns the original vector.
- a shot fired inside the corridor and driven at the edge reflects **back toward** the
  centreline rather than through it.
- `hitTest` ignores shielded, finished, retired and the owner-within-immunity, and returns
  every car inside `BLAST_RADIUS` for `request` but only the nearest for the other two.
- `pickTarget` returns the highest-ranked other player, skips finished and retired, and
  returns null in a solo race.

Existing suites must stay green: `store` 63, `leaderboard` 64, `scenery` 192, `validate-maps`
8 maps, and the three socket harnesses (`bots`, `capacity`, `exit`).

**Playwright is now available** for visual verification (installed in a scratchpad, not a repo
dependency), so unlike the previous two changes the arrows will actually be looked at before
this is called done — fired in a live race, captured, and inspected.

## 8. Out of scope

No changes to car physics, lap counting, checkpoints, the leaderboard, or identity. No new npm
dependency in the app. Projectiles do not collide with each other, with item pads, or with CAB
hazards — only with cars.

## 9. Known risk

This is the first moving entity in the simulation and it ships to a server colleagues are
actively racing on — the board has grown from 2 named drivers to 5 since the last deploy. A
projectile bug is the kind that ruins a race rather than merely looking wrong. It should be
proven with a real multi-driver bot race locally before it goes anywhere near the deploy host.
