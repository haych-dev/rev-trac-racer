# Rev-Trac Racer 🏁

A top-down multiplayer racing game where you race your changes to production.
Create a room, share the 4-letter code with up to 7 colleagues, pick a car, and go.

## Quick start

```bash
npm install
npm start
```

Then open http://localhost:3000 (or set `PORT=xxxx` to run on another port).
Everyone racing must be able to reach the same server — on a LAN, share
`http://<your-ip>:3000`.

## How to play

| Action | Keys |
|---|---|
| Accelerate / brake | `W`/`S` or `↑`/`↓` |
| Steer | `A`/`D` or `←`/`→` |
| Use powerup | `Space` |

Races are 3 laps. Stay on the asphalt — grass is slow. Drive through the
**?** boxes to grab a powerup.

## Powerups

| Powerup | Effect |
|---|---|
| ❯❯❯ **Chevron Boost** | Warp speed for ~2 seconds |
| 📋 **CAB Meeting** | Drops a hazard behind you — whoever hits it gets stuck in review (spin out) |
| 🔒 **Transport Lock** | Freezes the car directly ahead of you |
| ⚡ **Emergency Change** | 5-second shield — skip the red tape, immune to everything |
| 💥 **OOPS!** | Everyone ahead of you spins out |

Racers near the back get better odds on Boost and OOPS!

## Tracks

The host picks the track in the lobby:

| Track | Character |
|---|---|
| **Go-Live GP** | The classic circuit — balanced corners, honest racing |
| **Transport Twister** | A flowing ring broken up by two nasty chicanes |
| **Prod Speedway** | A flat-out tri-oval — three corners, zero excuses |
| **Sandbox Scramble** | A wobbly loop with three sweeping esses |
| **Hotfix Hairpin** | Sweepers into a deep hairpin — brake or backout |
| **Integration Esses** | A snaking weave of esses across the whole top half |
| **Double Downtime** | Two deep hairpin fingers — one down, one up |
| **Audit Trail** | A staircase of switchbacks — every corner gets reviewed |

Tracks are defined as centerline control-point loops in [public/maps.js](public/maps.js)
(shared by server and client, smoothed with Chaikin subdivision) — add a new entry there
and it shows up in the lobby automatically. `node test/validate-maps.js` checks that a
new track stays in bounds and never overlaps itself.

## Rooms

- Up to **8 players** per room, each with a unique car from a garage of 16
- The host picks the track; non-host players ready up; the host starts the race
- After a race, results are shown and everyone returns to the lobby for a rematch

## Driver profiles

A driver name is required, and it belongs to you. On your first visit the server
sets a signed `rtr_pid` cookie and your name is claimed by that profile, so
nobody else can race under it — the server never accepts a name from the client
when you create or join a room. Renaming keeps your stats, because they are held
against the profile rather than the name.

Clearing your cookies orphans the name. Release it with:

```bash
docker exec rev-trac-racer node scripts/admin.js release "Old Name"
docker exec rev-trac-racer node scripts/admin.js list
```

## Leaderboard

Two boards, at **Leaderboard** on the home screen:

- **Track records** — the fastest race time per track. Solo runs count; a fast
  time is fast whether or not anyone else was on track. Records are only written
  for standard 3-lap races, so a `LAPS=1` test run can never set one.
- **Standings** — races, wins and podiums, counted only for races with 2 or more
  distinct profiles, so an empty room earns nothing.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port (3005 in the container) |
| `LAPS` | 3 | Laps per race; any value other than 3 disables track-record writing entirely |
| `RTR_STORE_PATH` | `data/store.json` | Where profiles and the leaderboard live — point it at a temp file when running tests |
| `RTR_DEBUG` | unset | `1` exposes `/debug/rooms`, which leaks room codes, socket ids and player names |
| `RTR_SECRET` | generated | Cookie signing key; generated on first boot and persisted in the store, so identity survives restarts |
| `RTR_TRUST_PROXY` | unset | `1` makes the per-IP rate limits read `X-Forwarded-For`. Leave it unset unless a trusted proxy sits in front — otherwise a client can rotate the header and defeat every per-IP limit |

## Tech

- Node.js + Express + Socket.IO
- Server-authoritative simulation at 30 Hz (physics, collisions, laps, items)
- Plain HTML5 Canvas client with position smoothing — no build step

## Tests

Server-free unit tests:

```bash
npm test        # store, profiles, ratelimit, leaderboard, map validation
```

The socket harnesses need a running server. Always point `RTR_STORE_PATH` at a
throwaway file so test drivers never reach the real leaderboard:

```bash
RTR_STORE_PATH=/tmp/rtr-test.json PORT=4100 LAPS=1 node server.js
```

```bash
node test/bots.js http://localhost:4100 8 0   # full race with 8 bot drivers
node test/capacity.js http://localhost:4100   # 8-player cap, mid-race join
node test/exit.js http://localhost:4100       # mid-race exit
node test/security.js http://localhost:4100   # identity and hardening
```

(the second argument to `bots.js` is the map id, 0–7)
