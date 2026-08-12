# Reference-style track rendering — design

**Date:** 2026-08-12
**Status:** approved
**Goal:** make the eight circuits look like a top-down kart-circuit illustration — bright
grass, red/white kerbs, sand run-off, striped barrier boards, tyre stacks and trackside
scenery — without touching the simulation.

## 1. Why, and what this is not

The user supplied a reference illustration (flat top-down kart circuit) and asked for
tracks "more like this with bumpers etc".

This is a **rendering change only**. Decided explicitly with the user:

- **No physics.** `server.js` is not modified. Off-track behaviour stays exactly as it is
  (`server.js:531` caps speed at `OFFTRACK_MAX`). Barrier boards and tyre stacks are
  scenery; a car can drive through them.
- **No collision, no walls.** A solid barrier was considered and rejected. On a
  centreline-plus-half-width track model a wall is a tube around the centreline, and on the
  tighter circuits that tube self-intersects near the hairpins — the corridors merge and the
  wall vanishes exactly where it would matter. It is also a real gameplay change.
- **No track re-authoring and no `halfWidth` changes.** Narrowing a track would alter its
  difficulty and devalue the lap records already standing on the live board.
- **No new npm dependencies.** No test framework.

Accepting that barriers are non-solid is a deliberate trade. It is defensible because they
sit at the far edge of the run-off, and anything out there is already crawling at
`OFFTRACK_MAX`, so the pass-through is rarely on screen.

## 2. The bug this fixes

`drawTrack` (`public/game.js:611`) draws the kerb as a solid red stroke of width
`hw*2 + 16`, then a white dashed stroke over it, with `ctx.lineCap = 'round'` still set
from line 621.

A round cap extends **each dash by half the line width at each end**. The line width here is
`hw*2 + 16` — around 200px — so every 26px dash is extended by ~100px in both directions and
the dashes fuse into a near-solid white band.

That is why today's kerb reads as a plain white edge rather than red/white blocks. The fix is
`lineCap = 'butt'` for the dashed pass only. It is one line, and it accounts for most of the
visual difference between "current" and "treatment A" in the mockup.

## 3. The geometry constraint that shapes everything

Decoration bands cannot be a fixed width. Two neighbouring parts of the same loop can be
close together, and a band wide enough to look good on an open circuit would flood the gap
on a tight one — sand bleeding across the grass, and a barrier fence disappearing precisely
where the track needs one.

`test/validate-maps.js` already measures the relevant number: the minimum distance between
two arc-distant points on the loop. Subtracting the track width gives the usable grass gap.
Measured, per side:

| Track | halfWidth | clearance | budget per side |
|---|---|---|---|
| Go-Live GP | 90 | 283 | 51px |
| Prod Speedway | 85 | 235 | 32px |
| Transport Twister | 80 | 218 | 29px |
| Audit Trail | 74 | 201 | 26px |
| Sandbox Scramble | 88 | 223 | 23px |
| Hotfix Hairpin | 75 | 195 | 22px |
| Integration Esses | 72 | 188 | 22px |
| Double Downtime | 70 | 157 | **8px** |

A kerb plus sand plus a fence needs roughly 50px per side. Only Go-Live GP has it.
**Every width is therefore derived from the track's own clearance**, and every discrete
object is placed through a clearance test. No track is hand-tuned, and no track can render
broken. Double Downtime simply gets no sand.

## 4. Architecture

One new client-only file, `public/scenery.js`, UMD-wrapped exactly like `maps.js` and
`cars.js` so node can `require` it:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTScenery = factory();
})(typeof self !== 'undefined' ? self : this, function () { /* ... */ });
```

It is split along a hard boundary, because one half is testable in node and the other is not:

**Derivation — pure, no canvas, unit-tested.** Takes a map object from `RTMaps`, returns
plain data.

- `runoffFor(map) -> number` — sand half-width in px, `0` when there is no room.
- `furnitureFor(map) -> Array<{kind:'board'|'tyres', x, y, angle}>`
- `sceneryFor(map) -> { stands: Array<{x,y,w,h}>, cars: Array<{x,y,angle,color}>, trees: Array<{x,y,r}> }`
- `PALETTE` — the colour object, exported so one edit reverts the whole look.

**Painting — canvas, verified in the browser.**

- `paintTrack(ctx, map)` — the full static layer: grass, sand, kerbs, asphalt, centreline,
  start/finish, logo plate, furniture, scenery.
- `paintPreview(ctx, map)` — palette, sand and kerbs only, for the lobby cards.

`public/maps.js` gains one thing: each map object carries a precomputed `clearance`.
This is a small, deliberate deviation from the "client-only" boundary, flagged to the user.
Justification: `test/validate-maps.js` already computes this exact number with an inline
O(n²) loop, and `scenery.js` needs the identical definition. Computing it once where the map
is built means the validator and the renderer cannot drift apart, and removes a duplicated
loop. Cost is ~170k hypot operations across all eight maps at module load — a few
milliseconds, paid once, on both server and client. No server behaviour changes.

`public/game.js` changes: `drawTrack` becomes a blit from a cached layer; `drawMapPreview`
calls `paintPreview`; `drawCarBody` gains an outline. `public/index.html` gains a
`<script src="scenery.js">` tag between `maps.js` and `game.js`.

## 5. Derivation rules

Exact values. All lengths in world px.

**Run-off:** `runoff = min(34, (map.clearance - 2*halfWidth) / 2)`, and treated as `0` if
below `12` — a band thinner than that reads as a rendering artefact rather than sand. Under
this rule Double Downtime (budget 8) gets none, and every other track gets some.

**Kerb:** 14px each side. The band is stroked at `halfWidth*2 + 28` in `PALETTE.kerbRed`,
then over-stroked with `setLineDash([22, 22])` in `PALETTE.kerbWhite` **with
`lineCap = 'butt'`**, then restored to `'round'` for the asphalt pass. `lineJoin` stays
`'round'` throughout so corners do not develop mitre spikes.

**Furniture:** walk the loop in 46px steps. At each step, for each side, take the unit
normal and step out to `want = halfWidth + runoff + 16`. Keep the slot only if all of:

- the point is inside the world with a 24px inset, and
- `RTMaps.closest(map.path, x, y).dist >= want - 6` — this is the clearance test, and it is
  what makes tight tracks safe. If another part of the loop is nearer than the intended
  offset, the two corridors have merged here and the slot is dropped.
- arc position `u` is outside `[0, 0.02] ∪ [0.985, 1)`, keeping the start/finish clear.

Of surviving slots: the first 55% of the PRNG range becomes a `board`, the next 17% becomes
`tyres`, the remainder stays empty so the spacing is irregular rather than mechanical.

**Scenery:** placed only where `RTMaps.closest(...).dist` exceeds a floor (190 for stands,
175 for cars, 150 for trees) **and** the candidate is outside an exclusion rectangle around
`map.logo` inflated by 30px. The logo exclusion is required: the infield is far from the
centreline, so the distance test alone drops trees straight onto the Rev-Trac wordmark — the
mockup did exactly that. Counts are up to 2 stands, 26 cars, 60 trees, each subject to the
tests, so open circuits get more than cramped ones.

**Determinism:** a seeded xorshift32 PRNG keyed on `map.id`. Every client decorates a track
identically and screenshots reproduce. `Math.random` is not used.

## 6. Palette

```js
PALETTE = {
  grass:'#7fb442', grassAlt:'#6da438', sand:'#e6d9a8', asphalt:'#494d54',
  kerbRed:'#e0353d', kerbWhite:'#f7f8fa', centre:'rgba(255,255,255,0.5)',
}
```

This moves the game from dark green to bright green — the largest change in this work, larger
than the bumpers. It is confined to this one object, so reverting is a single edit.

## 7. Caching

`drawTrack` currently re-strokes the entire world every frame at 60Hz. Everything in §5 is
static, so it renders once into an offscreen canvas which the frame loop blits.

- One cached layer, for the current map only. A 1600×1000 RGBA canvas is ~6MB; caching all
  eight would be ~51MB, which is not worth it. The cache is keyed by map id and rebuilt when
  the id changes.
- The canvas backing store is already exactly 1600×1000 (`index.html:84`) and only
  CSS-scaled, so the blit is 1:1 with no resampling.
- **`logoImg` loads asynchronously.** If the layer is built before it arrives, the logo is
  missing for the life of the page. The layer is therefore built only once
  `logoImg.complete && logoImg.naturalWidth` is true, and `logoImg.onload` invalidates the
  cache. Until then the frame loop paints the layer directly, so the first frames are correct
  and merely unoptimised.

Net result is fewer per-frame stroke operations than today, with far more on screen.

## 8. Car legibility

Two cars are green — `Release Rocket` `#57cc3f` and `Patch Panther` `#9ef01a` — and sit close
to `PALETTE.grass`. They spend nearly all their time on dark asphalt, so this only bites when
a car runs wide, but the insurance is cheap: `drawCarBody` gains a 1.5px
`rgba(0,0,0,0.45)` outline. It helps on grass and also sharpens every car against asphalt.

## 9. Testing

Following the repo's existing convention — plain node scripts with a `check()` helper,
`PASS`/`FAIL` output and `process.exit(pass ? 0 : 1)`. No framework is introduced.

New `test/scenery.js`, run across all eight maps, asserting the derivation invariants:

- `runoffFor` never exceeds `(clearance - 2*halfWidth) / 2`, is never negative, and is `0`
  exactly for the tracks whose budget is under 12px.
- every `furnitureFor` item is at least `want - 6` from the centreline, inside the world
  inset, and outside the start/finish arc exclusion.
- every `sceneryFor` item clears its distance floor and lies outside the inflated logo box.
- calling each function twice yields identical output (determinism).
- at least one item is produced on every map, so a clearance test that rejected everything
  cannot pass silently.

`test/scenery.js` is added to the `npm test` chain. `test/validate-maps.js` is updated to
read `map.clearance` instead of recomputing it; its assertions do not change.

The painting half has no automated coverage — canvas output is not meaningfully assertable
without a rendering dependency, which §1 rules out. It is verified in the browser against a
real race before this is called done, and that verification is the gate.

## 10. Out of scope

Barrier collision. Track re-authoring. `halfWidth` changes. Server changes. Sprite or image
assets — everything is drawn with canvas primitives, so there is nothing new to load.
