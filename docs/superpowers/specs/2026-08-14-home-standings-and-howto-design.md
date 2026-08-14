# Home standings panel and a scannable how-to — design

**Date:** 2026-08-14
**Status:** approved
**Goal:** put the standings beside the home panel, and make the how-to block on the lobby
(room-creation) screen easier to digest.

## 1. Scope

Client-only. No server change, no change to `/api/leaderboard`, no new dependencies.
Three files: `public/index.html`, `public/style.css`, `public/game.js`.

Confirmed with the user before building:
- "the creation screen" means the **lobby** — the screen reached via Create Room, where you
  pick a track and a car — not the home screen.
- the standings sit **beside** the home panel in two columns, stacking on narrow screens.
- the existing Leaderboard button and full leaderboard screen **stay**. The new panel does
  not replace them.

## 2. Standings beside the home panel

`.screen.active` was already `display: flex; align-items: flex-start; justify-content:
center`, so a second `.panel` sibling inside `#screen-home` sits beside the first with no
layout rework. The only structural CSS change is `flex-wrap: wrap` on `.screen.active`, so
the two panels stack instead of being squeezed once they no longer fit; each panel already
carries `max-width: 95vw`.

The new `<aside id="home-standings" class="panel side">` is 340px against the main panel's
520px, and shows **standings only** — rank, driver, wins, best time — capped at 8 rows with
a "+N more" line beneath. Track records stay exclusive to the full screen, which is what
keeps the two views distinct rather than redundant.

**It is decoration, and behaves like it.** The panel sits beside the name / create / join
flow, which is the screen's actual job, so every failure path is silent: a non-OK response
or a throw leaves one line of text and touches none of those controls. The fetch in
`bootstrap()` is deliberately not awaited, so a slow or throttled leaderboard cannot delay
the name gate.

Refresh is centralised in `showScreen()` rather than at each call site, because home is
reachable from the lobby, the leaderboard and a race exit — and stale standings right after
a race is exactly what someone would notice. `showScreen` and `refreshHomeStandings` are
both function declarations, so the forward reference is hoisted and safe.

**One renderer, two shapes.** `renderStandings(tbody, standings, compact, limit)` is shared
by the panel and the full screen, so the two can never disagree about a driver's rank or
figures. `compact` drops the races and podiums columns the narrow panel has no room for.
Every name goes through `esc()` in both forms. The driver column is the only one allowed to
consume slack, and truncates with an ellipsis, so a 16-character name cannot push the wins
and best-time columns off the panel.

`bestOf(s)` extracts the existing inline expression unchanged — verified identical to the
previous code on all four input shapes (absent `bestByMap`, empty, one entry, several),
including that an empty map yields `null` rather than `Math.min()`'s `Infinity`.

## 3. A scannable how-to

The block is one template rendered into both the home screen and the lobby, deliberately, so
the two copies cannot drift. That property is worth keeping, so instead of forking a
lobby-only variant the **markup becomes inherently scannable and the layout adapts**:

- `.howto-grid` gives two columns under `.panel.wide` (the lobby, 760px) and one under the
  narrower home panel. A container-width selector, not a viewport media query, because what
  matters is the room the panel has, not the size of the window.
- **Powerups become name-over-description.** The coloured name sits on its own line with the
  description muted beneath, so the list is scanned by powerup name rather than read as five
  wrapped sentences. Same five powerups, same flavour text.
- **The trailing paragraph becomes three chips** — `3 laps to win`, `Grass is slow`,
  `? box = powerup` — instead of a sentence you must read to extract three facts.

## 4. Testing

`public/game.js` has no automated coverage in this repo and none is added here: this is a
layout change, and a DOM harness built for it would test a stub rather than a browser.

What is verified: `node --check`; the full suite still green (319 checks); the three socket
harnesses (`bots`, `capacity`, `exit`) still pass against a server running this code, which
proves the render refactor did not disturb the game flow; and `bestOf` proven behaviour-
identical to the expression it replaced.

The visual result requires a human — browser tooling has been unavailable for this work.

## 5. Known trade-off

The home screen now carries the panel, the standings and the how-to. If it reads as
cluttered, the cheap fix is collapsing the home how-to behind a `<details>` as the lobby
already does. Not done pre-emptively, because it hides the instructions from first-time
players, which is the opposite of the request.
