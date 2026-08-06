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

## Tech

- Node.js + Express + Socket.IO
- Server-authoritative simulation at 30 Hz (physics, collisions, laps, items)
- Plain HTML5 Canvas client with position smoothing — no build step

## Tests

Run the server with quick 1-lap races, then the bot harness:

```bash
PORT=4100 LAPS=1 node server.js
```

```bash
node test/bots.js http://localhost:4100 8 0
```

(the last argument is the map id, 0–7)

```bash
node test/capacity.js http://localhost:4100
```

`test/bots.js` runs a full race with N bot drivers (join → ready → race →
item pickup/use → finish). `test/capacity.js` verifies the 8-player cap and
mid-race join rejection.
