# Rev-Trac Racer 🏁

A chaotic top-down multiplayer racing game. Race your changes to production —
drift, draft, and sabotage up to seven colleagues (or AI drivers) on the way.

## Quick start

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. The server prints the address colleagues on your
network can use. Set `PORT` to run somewhere else.

Create a room, hit **Copy invite link**, and send it round. No accounts, no
build step.

## How to play

| | |
|---|---|
| `W` `A` `S` `D` / arrows | drive |
| `Shift` (hold in a corner) | drift — release for a mini-turbo |
| `Space` | use your powerup |
| `H` | horn |
| `R` | put the car back on track (small time penalty) |
| `M` | cycle sound: everything → effects only → mute |
| `Esc` | leave the race |

Things worth knowing:

- **Drifting charges a boost.** Hold a drift ~0.7s for blue sparks, ~1.5s for
  orange; release to fire it.
- **Slipstream.** Tuck in close behind another car for extra top speed.
- **Red chevrons are boost pads.** Oil makes you slide. Black ice is black ice.
- **Grass is slow** — unless you are mid Chevron Boost, which can cut corners.
- **The points leader starts at the back** of the next grid.

## Powerups

Grab a **?** box. Drivers further back roll better items.

| | Powerup | Effect |
|---|---|---|
| ❯❯❯ | Chevron Boost | Warp speed for two seconds |
| 📋 | CAB Meeting | Drop it behind you — whoever hits it is stuck in review |
| 🔒 | Transport Lock | Locks the car ahead in place |
| ⚡ | Emergency Change | Six seconds of total immunity |
| 💥 | OOPS! | Everyone ahead of you spins out |
| 🚀 | Rollback Rocket | Homing rocket that hunts the car ahead |
| 🔄 | Retrofit | Swap places with the car ahead |
| 🧊 | Change Freeze | Everyone else drives on ice |
| 🐛 | Regression Bug | Inverts everyone else's steering |
| 🖋️ | Undocumented Change | Splatters ink across rival screens |
| 🚛 | Mass Transport | Grow huge and flatten anything you touch |
| 🤖 | Automation | Four seconds of flawless autopilot at full boost |

## Chaos events

With chaos on (the default), something goes wrong every 15–25 seconds:
**Change Freeze** (the whole track ices over), **Prod Outage** (lights out —
headlights only), **CAB in Session** (meetings rain onto the track),
**Regression** (everyone's steering inverts), **Hypercare** (everything is
faster), **Emergency Release**, **Go-Live Bonus**, and the **Surprise Audit**
that stops whoever is leading.

## Modes and the championship

- **Grand Prix** — 1 to 12 laps. Points for every position
  (15 · 12 · 10 · 8 · 6 · 5 · 4 · 3), +1 for fastest lap.
- **Elimination** — every 14 seconds the car in last place is decommissioned.
  Last one running wins.

Points accumulate across races in a room, so a session is a championship.
After each race there are awards (Fastest Lap, Release Wrecker, CAB Magnet,
Drift King…). Lap records and all-time wins are kept in `data/records.json`
and shown in the **Hall of Fame** on the home screen.

Short of people? The host can add up to seven **AI drivers** at three skill
levels. Late arrivals can join a room mid-race and spectate until the next one.

## Tracks

| Track | Theme | |
|---|---|---|
| Go-Live GP | meadow | ●○○○○ The classic circuit |
| Prod Speedway | neon night | ●○○○○ A flat-out tri-oval |
| Transport Twister | desert | ●●○○○ A ring with two chicanes |
| Sandbox Scramble | beach | ●●○○○ Three sweeping esses |
| Hotfix Hairpin | lava | ●●●○○ Sweepers into a deep hairpin |
| Audit Trail | autumn | ●●●○○ A staircase of switchbacks |
| Integration Esses | snow | ●●●●○ A weave with black ice |
| Double Downtime | datacenter | ●●●●● Two opposing hairpin fingers |
| Merge Conflict | the void | ●●●●● A figure-8 with a live crossing |

## Cars

Sixteen cars across eight body types. Bodies differ modestly in top speed,
acceleration, handling, weight (who wins a shunt) and off-road pace — the
lobby shows the stats. Lap times across bodies are within about 4%.

## How it is built

```
server.js            rooms, lobby, championship, socket wiring
lib/race.js          the simulation: physics, powerups, chaos, laps, results
lib/bots.js          AI drivers (also drives Automation and victory laps)
lib/records.js       persistent hall of fame
public/maps.js       tracks + geometry      ┐
public/cars.js       car roster + stats     ├ shared by server and client
public/items.js      powerups, flags, copy  ┘
public/js/render.js  canvas renderer: themes, scenery, particles
public/js/audio.js   synthesized sound effects and music (no audio files)
public/js/main.js    screens, networking, interpolation, HUD
```

The server is authoritative: it steps the simulation at 60 Hz and broadcasts
snapshots at 30 Hz; clients interpolate between snapshots ~100 ms in the past.
`lib/race.js` has no sockets or timers in it, so a full race runs headless in
milliseconds — that is how the bots and car balance were tuned.

To add a track, add an entry to `public/maps.js` (control points are smoothed
automatically; item rows, boost pads and oil are placed for you) and run
`node test/validate-maps.js`.

## Tests

```bash
npm test
```

- `test/validate-maps.js` — every track stays in bounds and never overlaps itself
- `test/sim.js` — headless races on every track, both modes, every powerup,
  car balance, determinism
- `test/e2e.js` — spawns a real server and walks the room lifecycle over sockets

## Hosting

Rooms and races live in server memory and players hold a WebSocket open, so
host it on something long-running (a VM, a container, an office machine) rather
than a serverless platform. One process comfortably runs many rooms.

### Deploying to the VPS

Production target is the Hostinger VPS `srv1964127` (145.79.11.91), as the
Docker Compose project `rev-trac-racer` in `/docker/rev-trac-racer`, behind the
box's shared Traefik at https://racer.srv1964127.hstgr.cloud.

```bash
DEPLOY_KEY=~/.ssh/<key> ./deploy.sh
```

`DEPLOY_KEY` is an SSH key the box accepts for `root`. The script ships the
committed `HEAD` with `git archive`, rebuilds the image on the box, restarts
the container and waits for the site to answer. Anyone mid-race is dropped.
The hall of fame lives in the `racer-data` Docker volume and survives deploys.

`*.srv1964127.hstgr.cloud` already resolves to the box. To serve it on another
hostname, point that name's A record at 145.79.11.91 first, then change the
`Host(...)` rule in `docker-compose.vps.yml` and redeploy (Traefik needs the
name to resolve before it can issue the certificate).

To try the container locally: `docker build -t rev-trac-racer . && docker run --rm -p 3000:3000 rev-trac-racer`.
