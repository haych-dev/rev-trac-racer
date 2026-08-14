# Rev-Trac Racer: lobby controls, owned profiles, leaderboard, hardening

Date: 2026-08-07
Status: approved

## Goal

Four changes to Rev-Trac Racer:

1. Show the controls in the lobby so players know how to drive before the lights go out.
2. Require a driver name and persist it, instead of silently falling back to `Racer`.
3. Add a leaderboard that tracks people by name across races.
4. Close the cheating routes that would make that leaderboard meaningless.

## Investigation: what is actually exploitable today

The simulation is already server-authoritative, and this shapes the whole design.
`public/game.js` holds no physics constants. The client sends four input booleans
and `useItem`, and never sends a position. `ACCEL`, `MAX_SPEED`, `BOOST_SPEED`,
lap counting and collision response all live in `server.js` and run in the 30 Hz
`tick()`. A player can rewrite the entire client and still not move faster than
`MAX_SPEED`.

So "stop people modifying the game code to get ahead" is already satisfied for
physics. The real exposure is elsewhere:

| Vector | Today | Addressed by |
|---|---|---|
| Name spoofing | `name` arrives from the client at `server.js:530`/`544` with no ownership | Owned profiles (§2) |
| Solo/collusion farming | Win an empty room repeatedly; nothing notices | 2+ distinct profiles that raced, one award each (§4) |
| Scripted bots | `test/bots.js` proves a script can drive a perfect line using only legal inputs | **Out of scope** (§7) |
| No rate limits | `input`, `useItem`, `createRoom` unbounded | Token buckets (§6) |
| `/debug/rooms` | Publicly leaks every room, code, socket ID and name (`server.js:9`) | `RTR_DEBUG` gate (§6) |
| Sector cutting | Bounded by sequential `nextSector` + 140 off-track cap, but a grass diagonal may still pay on some maps | Accepted; a balance question, not a security hole |

Two parts of the request are already partly built: the controls exist but on the
**home** screen (`index.html:39-49`), not the lobby; and the name already persists
to `localStorage['rtr-name']` (`game.js:208`) but is not required (`game.js:211`
falls back to `'Racer'`).

## Decisions

| Question | Decision |
|---|---|
| Identity | Owned names backed by a signed httpOnly cookie |
| Leaderboard | Track records (per map) + standings (races/wins/podiums) |
| Persistence | Docker named volume holding one atomically-written JSON file |
| Hardening scope | Pragmatic: close every cheap certain hole; no bot detection |

Two judgment calls, confirmed as designed:

- **Solo runs do set track records.** A fast time is fast whether or not anyone
  else was on track. Standings are what require company.
- **Retired drivers still count a race.** Rage-quitting does not erase
  participation, but earns no win or podium.

## 1. Module layout

`server.js` is 635 lines and this work would push it past 1000. Four focused
modules, each usable and testable on its own, with no new npm dependencies —
HMAC comes from `node:crypto` and cookie parsing is a five-line split rather
than pulling in `cookie-parser`.

| Module | Purpose | Depends on |
|---|---|---|
| `store.js` | Load/save `store.json` atomically, own the schema and its version | `node:fs` |
| `profiles.js` | Mint profile IDs, sign/verify cookies, claim/rename/release names | `store.js` |
| `leaderboard.js` | Record a finished race; derive standings and track records | `store.js` |
| `ratelimit.js` | Token bucket keyed by socket ID or IP | nothing |

`server.js` wires these into the HTTP routes and socket handlers and keeps
owning the simulation.

## 2. Identity

### Bootstrap

```
GET /api/profile/me
  invalid/absent cookie -> mint crypto.randomUUID() + HMAC-SHA256 signature
                           Set-Cookie: rtr_pid=<id>.<sig>
                             httpOnly, SameSite=Lax, Path=/, Max-Age 5y
                             NOT Secure — the deploy host serves plain HTTP over LAN
                        -> { id, name: null }
  valid cookie          -> { id, name: "Michael" }
```

The `Secure` flag is deliberately omitted. The two dashboards on this host
already carry `INSECURE_COOKIES: "1"` for the same reason; a `Secure` cookie
would never be sent over `http://<deploy-host>:3005` and identity would silently
never work.

### Claiming a name

```
POST /api/profile/name { name }
  trim; require 3–16 chars; charset [A-Za-z0-9 _-]
  case-insensitive uniqueness via profiles[].nameLower
  taken by a different profile -> 409 { error: "That name is taken" }
  free -> claim, persist, and on rename free the previous name
```

Stats live on the profile ID, so renaming carries a driver's whole history with
them.

### Reading the leaderboard

```
GET /api/leaderboard
  -> { standings: [ { name, races, wins, podiums, bestByMap } ],
       records:   { "<mapId>": [ { name, timeMs, at } ] } }
```

Read-only and unauthenticated — anyone who can reach the game can see the board.
Profile IDs are never included in the response; only display names. The endpoint
is derived entirely from stored counters, so it does no aggregation over `races`.

This is a **read** path only. Nothing a client sends can ever write to the
leaderboard: the only writer is `checkRaceEnd` on the server, from a race the
server itself simulated. There is deliberately no `POST` equivalent to curl.

### The trust fix

`createRoom` and `joinRoom` **stop accepting `name` from the client**. The server
verifies the cookie from the socket handshake (`socket.request.headers.cookie`),
resolves the profile, and uses its stored name. A socket with no cookie, or a
cookie whose HMAC does not verify, is refused with a clear error and never
joins a room.

Three refusal cases, all returning a distinct error so the client can react
correctly:

| Handshake state | Result |
|---|---|
| No `rtr_pid` cookie | refused — `"No profile"`; client re-runs bootstrap |
| Signature does not verify | refused — `"Invalid profile"` |
| Valid cookie, no name claimed yet | refused — `"Claim a name first"`; client returns to the home gate |

The third case is reachable in normal use, not just under attack: `game.js`
opens its socket on page load, before the player has typed anything. So the
socket legitimately exists in a nameless state and must be refused from rooms
without being treated as hostile.

This is the change that makes the leaderboard mean anything: impersonation now
requires stealing a cookie, not typing a different string.

### Cookie secret

Generated on first boot and persisted in the store, overridable with
`RTR_SECRET`. Without persistence every container restart would invalidate
every player's identity.

### Orphaned names

Clearing cookies orphans a name, since the claim is held by a profile ID nobody
can present any more. `scripts/admin.js release <name>` frees it. This is the
one manual operation the design introduces, and it is the accepted cost of
having no PIN.

**The service must be stopped while it runs.** The store is a single in-memory
object owned by the server process, persisted on write. A second process editing
the file is invisible to the running server, and the server overwrites the file
on its next save — so a release against a live server reports success, does not
change the board, and is then silently reverted. Verified on the deployed host:
after `docker exec … admin.js release`, the file showed zero named profiles while
the API still served all of them, and one subsequent profile mint restored every
name. The supported procedure is:

```bash
docker compose stop racer
docker compose run --rm racer node scripts/admin.js release "Old Name"
docker compose start racer
```

`docker compose run` mounts the same named volume, so the one-off container sees
the same store. `admin.js` refuses to mutate when it detects the server
listening on `PORT` in its own container, which catches the `docker exec` form.

## 3. Store shape

```json
{
  "version": 1,
  "secret": "<hex>",
  "profiles": {
    "<pid>": { "name": "Michael", "nameLower": "michael",
               "createdAt": 0, "races": 0, "wins": 0, "podiums": 0 }
  },
  "records": {
    "<mapId>": [ { "pid": "...", "name": "Michael", "timeMs": 46900, "at": 0 } ]
  },
  "races": [
    { "at": 0, "mapId": 0, "laps": 3,
      "players": [ { "pid": "...", "name": "...", "pos": 1,
                     "timeMs": 46900, "finished": true } ] }
  ]
}
```

Standings read straight off the profile counters, so the leaderboard page costs
no aggregation. `records` keeps the top 10 per map, best-only per profile.
`races` is capped at the most recent 200 entries so the file cannot grow without
bound.

Writes go to `store.json.tmp` and then `rename()` onto `store.json`, which is
atomic on the same filesystem. A crash mid-write leaves the previous good file
intact. A single Node process owns the file, so there is no cross-process
locking to consider.

`RTR_STORE_PATH` overrides the location. Test runs point it at a temp file so
they never touch the real leaderboard.

## 4. Recording a race

Hooks into `checkRaceEnd` once `results` is computed.

**Track records.** Written even for solo races. Two guards:

- The time must clear a plausibility floor of
  `map.path.total * TOTAL_LAPS / BOOST_SPEED`. `path.total` is the existing
  arc length already computed in `maps.js`. On Go-Live GP that floor is 13.5s
  against a real competitive time of ~46.9s, so it can only ever reject an
  absurd value from a bug or a clock problem — never a legitimate run.
- **Nothing is recorded when `TOTAL_LAPS !== 3`.** The `LAPS` env override
  exists for testing, and a 1-lap race would otherwise set a permanent
  unbeatable record.

**Standings.** Only when the race had **2 or more distinct profiles that
actually raced**, and **each profile is awarded at most once**, however many
seats it held.

- "Actually raced" means the car crossed at least one arc-length sector
  (`cpCount > 0` in the simulation). `checkRaceEnd` passes this as `progressed`
  on each entry; a car parked on the grid is `false`. Crossing a sector and then
  retiring still counts — retiring is quitting, not farming — but a player who
  leaves before crossing one does not open the gate.
- Seats are collapsed per profile before anything is awarded, keeping the best
  (lowest) `pos`. For finishers `pos` is time order, so best-pos is also
  best-time and track records are unchanged.
- `races` increments for everyone present at the finish, retired included.
- `wins` increments for position 1, `podiums` for positions 1–3, both only for
  genuine finishers (`finished && !retired`).

Belt and braces: `joinRoom` also refuses a second seat to a profile already in
that room (`You are already in this room in another tab`), so one cookie cannot
occupy multiple seats in the first place. Rejoining from the *same* socket is
still fine. `createRoom` needs no equivalent check — a fresh room holds only its
creator.

**What this actually guarantees.** Standings need two people's worth of *driving*,
not two cookies. It closes: the empty room; one cookie filling several seats
(one seat, and one award, per profile); and a second profile minted from
`/api/profile/me` and parked on the grid to unlock the gate.

**What it does not.** Profile IDs are cheap — minting is rate limited, not
scarce — so someone determined can still mint a second profile and *genuinely
drive both cars* to a rigged result. That is the same class of problem as bot
detection (§7) and is deliberately out of scope: catching it means judging how a
car was driven, and any threshold there false-positives on real players. The
rule raises the cost of farming from "open a second tab" to "drive two cars at
once, every race".

## 5. Lobby controls

The `.howto` block at `index.html:39-49` is extracted into a single template
rendered on **both** the home and lobby screens, so the two cannot drift apart.

Content expands to a real controls table — accelerate/brake, steer, use item,
exit race — alongside the existing powerup list, plus the two rules that
actually catch people out: races are 3 laps, and grass is slow.

On the lobby screen it sits inside a `<details open>`. The lobby already stacks
tracks, cars, drivers and actions; a collapsible block keeps Start Race above
the fold on a laptop while still being open by default for first-timers.

## 6. Hardening

| Guard | Limit | Over-limit behaviour |
|---|---|---|
| `input` | 60/s per socket | drop silently |
| `useItem` | 10/s per socket | drop silently |
| `createRoom` / `joinRoom` | 5 per 10s per socket | error callback |
| `GET /api/profile/me` — minting only | 30/min per IP | HTTP 429 |
| `POST /api/profile/name` | 30/min per IP | HTTP 429 |
| Concurrent sockets per IP | 64 | refuse connection |
| Total rooms | 200 | `createRoom` errors |
| `/debug/rooms` | — | 404 unless `RTR_DEBUG=1` |

Dropping input floods silently is correct rather than disconnecting: the tick
reads whichever value arrived last, so a flood was never a speed advantage in
the first place — only a resource cost.

`GET /api/profile/me` is limited because minting is the one unauthenticated path
that *writes*: a request with no valid cookie creates a profile and rewrites the
whole store file synchronously. Left open it is an amplification vector — 300
requests produced 300 profiles and 2.9s of blocked event loop in testing, which
degrades the game for everyone racing. The limit applies only when a request
actually mints; a request presenting a valid cookie is a pure read and is never
throttled, so a returning player is unaffected.

### Why the per-IP limits are loose

The deploy host is reachable only over LAN/VPN, so a group of colleagues can egress from
a single NAT address. Tight per-IP limits would then punish the normal case —
eight people joining a race from one office would trip a 20-socket cap, and a
team creating profiles together would trip a 10/min claim limit.

The per-IP numbers are therefore DoS backstops sized well above realistic use,
not security boundaries. The actual integrity guarantees come from cookie-signed
profile ownership (§2) and the standings rule of §4 (2+ distinct profiles that
actually raced, one award per profile), neither of which depends on IP at all.
Per-socket limits stay tight because one socket is one player.

## 7. Explicitly out of scope: bot detection

Not attempted, for three reasons:

1. The project's own test harness is a bot. Blocking scripted clients breaks
   `test/bots.js`, `test/capacity.js` and `test/exit.js`.
2. Heuristics on reaction time and input periodicity false-positive on strong
   players, and the penalty for a wrong call is high in an office game.
3. Any threshold is trivially defeated by adding jitter, so it is an arms race
   with no end state.

Bots use only legal inputs, so they cannot exceed `MAX_SPEED` or skip sectors.
The exposure is a good driver, not a broken game.

## 8. Testing

Existing harnesses need updating for the profile requirement: each bot performs
`GET /api/profile/me`, claims a unique name, and passes the cookie through
socket.io-client `extraHeaders`. All test runs set `RTR_STORE_PATH` to a temp
file.

New tests, each pinning a claim made above:

**`test/store.js`**
- write → reload round-trips
- a crash mid-write leaves the previous good file readable
- claim, case-insensitive uniqueness rejection, rename frees the old name,
  `release` frees an orphan

**`test/leaderboard.js`**
- a solo race sets a track record and no standings
- a 2-profile race increments `races`, `wins`, `podiums` correctly
- a time under the plausibility floor is rejected
- `LAPS=1` writes no record
- a retired driver gains a race but no win or podium
- one profile holding several seats earns one race, one win and one podium, and
  one record row — not one per seat
- a profile that never moved (`progressed: false`) does not open the standings
  gate; two that both moved do; a driver who moved and then retired still counts

**`test/security.js`**
- a client-supplied `name` on `createRoom`/`joinRoom` is ignored
- a cookieless socket is refused with `"No profile"`
- a forged-signature cookie is refused with `"Invalid profile"`
- a valid cookie with no claimed name is refused with `"Claim a name first"`
- an `input` flood is dropped and the socket survives
- `/debug/rooms` 404s without `RTR_DEBUG=1`
- `GET /api/leaderboard` returns names but never profile IDs

**`test/capacity.js`**
- a second socket carrying the same cookie is refused a seat in a room its
  profile already occupies, and the first socket keeps its place

`test/validate-maps.js` is untouched and must keep passing.

## 9. Deploy delta

`docker-compose.yml` gains the named volume. The version currently running on
The deploy host has none, so without this the leaderboard resets on every
`docker compose up -d --build`:

```yaml
services:
  racer:
    volumes:
      - rtr-data:/app/data
volumes:
  rtr-data:
```

A named volume avoids both the SELinux `:z` relabel and the `setfacl -m u:100`
dance the dashboards need, because the racer container runs as root and Docker
owns the volume. The leaderboard is read through the app's own page, so there is
no routine need to inspect the file by hand.

Also changed: `README.md` gains the profile/leaderboard behaviour, the new env
vars (`RTR_DEBUG`, `RTR_SECRET`, `RTR_STORE_PATH`) and the `scripts/admin.js`
usage.

## File summary

New: `store.js`, `profiles.js`, `leaderboard.js`, `ratelimit.js`,
`scripts/admin.js`, `test/store.js`, `test/leaderboard.js`, `test/security.js`

Changed: `server.js` (wire modules, drop client-supplied names, gate debug
route, apply rate limits), `public/index.html` (required-name gate, shared
controls block, leaderboard screen), `public/game.js` (profile bootstrap, name
claim, controls render, leaderboard fetch), `public/style.css`,
`docker-compose.yml`, `README.md`, `test/bots.js`, `test/capacity.js`,
`test/exit.js`
