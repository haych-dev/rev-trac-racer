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

## The front page

The home screen follows the rev-trac.com look: DM Sans, the navy and red, pill
buttons, and the three hero arrows behind the card where you pick a name and
create or join a room. Below that are the Hall of Fame, the controls and
powerups, and a **demo request** band.

The demo form has no server behind it. It checks the fields, writes the email
and opens the visitor's own mail app with it addressed to `hello@rev-trac.com`;
nothing is sent or stored by this site. If no mail app opens there is a "Copy
the request" button, and the band also links the address, the contact form and
the recorded demos on rev-trac.com. To send requests somewhere else, change
`data-to` on `#demo-form` in `public/index.html`.

Every colour, font size, space and shadow is a named value in
`public/tokens.css`; `public/style.css` only refers to those names. DM Sans is
served from `public/fonts/` (SIL Open Font License, licence alongside), so the
page makes no third-party requests.

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
and shown in the **Hall of Fame** on the home screen. All-time standings only
count races with two or more people driving (see below); lap records always count.

Short of people? The host can add up to seven **AI drivers** at three skill
levels. Late arrivals can join a room mid-race and spectate until the next one.

## Driver names and abuse limits

**Names are owned.** On first visit the server gives the browser a profile: a
random id in a signed, `HttpOnly` cookie. Saving a driver name claims it for
that profile, and nobody else can take it (names are 3–16 letters, digits,
spaces, `_` or `-`; the AI drivers' names are reserved). The server takes the
name from the profile, never from what a client sends, so impersonating someone
needs their cookie, not a text field.

- One profile, one seat: the same browser cannot sit in two rooms at once.
- You can rename from the home screen when you are not in a room. The hall of
  fame is keyed by profile, so your history follows you, and whoever picks up
  your old name starts from zero.
- Identity is the cookie. Clearing cookies orphans the name; free it with
  `node scripts/admin.js release "<name>"` (the server must be stopped — the
  script explains why and how).

**The Hall of Fame cannot be farmed** (`lib/records.js`). Everything it stores
comes from the simulation the server just ran, never from a client, and:

- **All-time standings need a real race.** Races, wins, podiums and points
  only count when two or more distinct profiles actually drove. Beating AI
  drivers on your own does not count, and neither does a second browser parked
  on the grid. The results screen says so when a race did not count.
- **One profile, one result per race**, at its best finish.
- **Wins and podiums need a real result.** Quitting still goes on your record
  as a race, but never as a win, a podium or points. In a Grand Prix you must
  cross the line; in Elimination, being knocked out second or third is a podium.
- **Records must be physically possible.** A lap or race time quicker than a car
  boosting flat-out for the whole distance is rejected.
- **Lap records do count solo runs** — a fast lap is fast whoever else is there.
  Bots never hold records.

What this does not stop: one person genuinely driving two cars at once in two
browsers. The points in a room's own championship are unaffected by any of this.

**Rate limits** are token buckets (`lib/ratelimit.js`). They are backstops
against flooding, not the integrity mechanism:

| Limit | Scope | Allowance |
|---|---|---|
| Driving input | per socket | 60/s |
| Powerup, horn, reset | per socket | 10/s |
| Lobby actions (settings, car, ready…) | per socket | burst 20, then 5/s |
| Create / join room | per socket | 5, refilling 1 per 2s |
| New profiles | per IP | 30, refilling 1 per 2s |
| Name changes | per IP | 30, refilling 1 per 2s |

Over-budget messages are dropped, not punished. There are also caps of 64
sockets per IP, 200 rooms, 16 KB per socket message and 4 KB per JSON body.

| Variable | Purpose |
|---|---|
| `RTR_STORE_PATH` | profiles file (default `data/store.json`) |
| `RECORDS_FILE` | hall-of-fame file (default `data/records.json`) |
| `RTR_TRUST_PROXY=1` | take the client address from `X-Forwarded-For`. Only behind a proxy that overwrites that header; otherwise a client can dodge every per-IP limit by inventing addresses |
| `RTR_COOKIE_SECURE=1` | mark the profile cookie `Secure`. Only when served over HTTPS; on plain HTTP it would never be sent back |
| `RTR_SECRET` | override the cookie-signing secret (normally generated once and kept in the store) |

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
lib/records.js       persistent hall of fame, keyed by profile
lib/profiles.js      owned driver names (signed-cookie identity)
lib/store.js         atomic JSON file holding the profiles
lib/ratelimit.js     token-bucket rate limiter
scripts/admin.js     list profiles / release an orphaned name
public/maps.js       tracks + geometry      ┐
public/cars.js       car roster + stats     ├ shared by server and client
public/items.js      powerups, flags, copy  ┘
public/js/render.js  canvas renderer: themes, scenery, particles
public/js/audio.js   synthesized sound effects and music (no audio files)
public/js/main.js    screens, networking, interpolation, HUD, demo form
public/tokens.css    design tokens: brand colours, type, space, shadows
public/style.css     all styling, written against the tokens
public/fonts/        DM Sans (self-hosted) and its licence
```

The server is authoritative: it steps the simulation at 60 Hz and broadcasts a
snapshot every tick. Clients draw the race slightly in the past, interpolating
between snapshots; that delay is input lag, so each client measures how evenly
its snapshots arrive and keeps the delay as small as its connection allows
(about 35 ms on a good one, up to 130 ms on a jittery one).
`lib/race.js` has no sockets or timers in it, so a full race runs headless in
milliseconds — that is how the bots and car balance were tuned.

Handling lives in the `P` table at the top of `lib/race.js` (top speed,
acceleration, steering rate, grip). Change a number, run `node test/sim.js`,
and it reports lap times per track and whether the car bodies are still balanced.

To add a track, add an entry to `public/maps.js` (control points are smoothed
automatically; item rows, boost pads and oil are placed for you) and run
`node test/validate-maps.js`. Tracks are drawn on a 1600×1000 design grid and
scaled into the world by `SCALE` in that file — that one number sets how big
every track is relative to the cars, and the whole track always fits on screen.

## Tests

```bash
npm test
```

- `test/validate-maps.js` — every track stays in bounds and never overlaps itself
- `test/identity.js` — rate limiter, signed profiles, the store, and the
  profile-keyed hall of fame, with no server
- `test/sim.js` — headless races on every track, both modes, every powerup,
  car balance, determinism
- `test/e2e.js` — spawns a real server and walks identity, the room lifecycle
  and the rate limits over real HTTP and sockets

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
Driver profiles and the hall of fame live in the `racer-data` Docker volume
and survive deploys. The compose file sets `RTR_TRUST_PROXY=1` (Traefik
overwrites `X-Forwarded-For`, and the container's port is not published) and
`RTR_COOKIE_SECURE=1` (the site is HTTPS-only).

`*.srv1964127.hstgr.cloud` already resolves to the box. To serve it on another
hostname, point that name's A record at 145.79.11.91 first, then change the
`Host(...)` rule in `docker-compose.vps.yml` and redeploy (Traefik needs the
name to resolve before it can issue the certificate).

To try the container locally: `docker build -t rev-trac-racer . && docker run --rm -p 3000:3000 rev-trac-racer`.
