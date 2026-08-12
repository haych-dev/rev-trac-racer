# Reference-Style Track Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the eight circuits look like a flat top-down kart-circuit illustration — bright grass, red/white kerbs, sand run-off, striped barrier boards, tyre stacks and trackside scenery — without touching the simulation.

**Architecture:** One new client-only module `public/scenery.js` splits into a pure derivation half (widths and object placements derived from each track's own geometry, unit-tested from node) and a canvas painting half (verified in the browser). Every width and placement is derived from a per-map `clearance` value so no track is hand-tuned and none can render broken. The whole track is static, so it is painted once into an offscreen canvas that the frame loop blits.

**Tech Stack:** Plain ES2019 browser JavaScript, no build step. UMD modules so node can `require` them. HTML5 Canvas 2D. Tests are plain node scripts.

**Spec:** `docs/superpowers/specs/2026-08-12-racer-track-scenery-design.md`

## Global Constraints

- **No new npm dependencies.** Not for the app, not for tests.
- **No test framework.** Tests are plain node scripts using the existing `check(label, cond)` pattern: push to a `checks` array, log `  ok  ` / `  FAIL`, end with `PASS (N checks)` or `FAIL (n/N)` and `process.exit(failed.length ? 1 : 0)`. Copy the shape from `test/store.js`.
- **`server.js` is not modified by any task in this plan.** No physics change. Off-track behaviour stays as-is.
- **No collision.** Barrier boards and tyre stacks are cosmetic; cars pass through them.
- **No `halfWidth` changes and no track re-authoring.** Changing either alters difficulty and devalues lap records already on the live board.
- **No image or sprite assets.** Everything is drawn with canvas primitives.
- **`Math.random` is never used.** All placement uses the seeded PRNG so every client decorates a track identically.
- **UMD wrapper style** must match `public/maps.js` and `public/cars.js` exactly:
  ```js
  (function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.RTName = factory();
  })(typeof self !== 'undefined' ? self : this, function () { /* body */ });
  ```
- **World size is 1600×1000**, matching the canvas backing store at `public/index.html:84`.
- Existing tests must keep passing: `npm test` runs `test/store.js`, `test/leaderboard.js`, `test/validate-maps.js`.

---

### Task 1: Per-map `clearance` in maps.js

Each map gains a precomputed self-clearance: the minimum distance between two points on the loop that are far apart along the arc but close in space. Everything in later tasks sizes itself from this number. `test/validate-maps.js` already computes it with an inline loop; that loop moves into `maps.js` so the validator and the renderer cannot drift apart.

**Files:**
- Modify: `public/maps.js` (add `selfClearance`, export it, set `clearance` on each map)
- Test: `test/validate-maps.js` (read `map.clearance`; add a finiteness assertion)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `RTMaps.selfClearance(path, halfWidth) -> { dist: number, i: number, j: number }` — `i`/`j` are indices into `path.pts` at the tightest pair, used only for diagnostics.
  - `map.clearance` — a `number` on every entry of `RTMaps.MAPS`, equal to `selfClearance(map.path, map.halfWidth).dist`.

- [ ] **Step 1: Write the failing assertion**

In `test/validate-maps.js`, immediately after `const hw = map.halfWidth;`, add:

```js
  // A non-finite clearance means the arc-exclusion window swallowed the whole
  // loop, which would silently hand the renderer an unbounded decoration budget.
  if (!Number.isFinite(map.clearance)) issues.push('clearance is not finite');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/validate-maps.js`
Expected: every map FAILs with `- clearance is not finite`, because `map.clearance` is currently `undefined` and `Number.isFinite(undefined)` is `false`. Exit code 1.

- [ ] **Step 3: Add `selfClearance` to maps.js**

In `public/maps.js`, insert after the `closest` function (after line 109, before `const defs = [`):

```js
  // Minimum distance between two points on the loop that are far apart along the
  // arc but close in space. Neighbouring parts of the same circuit bound how wide
  // any trackside decoration can be before the two corridors merge, so this is
  // the number every decoration width is derived from.
  // Returns the tightest pair's indices too, for diagnostics.
  function selfClearance(path, halfWidth) {
    const { pts, cum, total, n } = path;
    const arcExclusion = 3 * halfWidth;
    let best = { dist: Infinity, i: 0, j: 0 };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const fwd = cum[j] - cum[i];
        if (Math.min(fwd, total - fwd) <= arcExclusion) continue;
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d < best.dist) best = { dist: d, i, j };
      }
    }
    return best;
  }
```

- [ ] **Step 4: Set `clearance` on each map and export the helper**

In `public/maps.js`, change the `MAPS` builder and the return. Replace:

```js
    return { ...d, path, logo };
  });

  return { MAPS, pointAt, closest };
```

with:

```js
    return { ...d, path, logo, clearance: selfClearance(path, d.halfWidth).dist };
  });

  return { MAPS, pointAt, closest, selfClearance };
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node test/validate-maps.js`
Expected: PASS — eight `ok` lines, exit code 0.

- [ ] **Step 6: Replace the validator's inline loop with `map.clearance`**

In `test/validate-maps.js`, delete the whole self-clearance block — from the `// self-clearance:` comment through the closing brace of the `if (worst.d < minGap) { ... }` statement (currently lines 26-42) — and replace it with:

```js
  // self-clearance: points far apart along the arc must be far apart in space.
  // maps.js computes this so the validator and the renderer share one definition.
  const minGap = 2 * hw + 15;
  if (map.clearance < minGap) {
    const worst = RTMaps.selfClearance(map.path, hw); // only on the failure path
    const [x1, y1] = map.path.pts[worst.i];
    issues.push(`corridor too tight: ${Math.round(map.clearance)}px < ${minGap}px near (${Math.round(x1)}, ${Math.round(y1)})`);
  }
```

Then update the label line, which referenced the deleted `worst`:

```js
  const label = `${map.name.padEnd(20)} len=${Math.round(total)}px hw=${hw} clearance=${Math.round(map.clearance)}px`;
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: `PASS (63 checks)`, `PASS (64 checks)`, then eight `ok` map lines. Exit code 0. The printed `clearance=` numbers must be unchanged from before this task: 283, 218, 235, 223, 195, 188, 157, 201 for maps 0-7 in order.

- [ ] **Step 8: Commit**

```bash
git add public/maps.js test/validate-maps.js
git commit -m "refactor(maps): precompute per-map self-clearance

Trackside decoration widths have to be derived from how close neighbouring parts
of a circuit come to each other, and test/validate-maps.js already computed
exactly that with an inline loop. Moving it into maps.js means the validator and
the renderer share one definition and cannot drift apart.

Also asserts the value is finite: a non-finite clearance would mean the
arc-exclusion window swallowed the whole loop, silently handing the renderer an
unbounded decoration budget."
```

---

### Task 2: Derivation half of scenery.js

The pure half: palette, seeded PRNG, and the three functions that turn a map into decoration data. No canvas. Fully unit-tested from node.

**Files:**
- Create: `public/scenery.js`
- Create: `test/scenery.js`
- Modify: `package.json` (add `test/scenery.js` to the `test` script)

**Interfaces:**
- Consumes: `map.clearance` (Task 1), `RTMaps.pointAt(path, u)`, `RTMaps.closest(path, x, y)`.
- Produces, all on `RTScenery`:
  - `PALETTE` — `{ grass, grassAlt, sand, asphalt, kerbRed, kerbWhite, centre }`, all CSS colour strings.
  - `runoffFor(map) -> number` — sand half-width in px beyond the kerb; `0` when there is no room.
  - `furnitureFor(map) -> Array<{ kind: 'board'|'tyres', x: number, y: number, u: number, angle?: number }>` — `angle` present on `board` only, in radians. `u` is the arc fraction of the sample the item was placed from, carried so the start-line exclusion is directly assertable rather than re-derived by projecting the offset point back onto the centreline (which can disagree by a hair and make the test flaky).
  - `sceneryFor(map) -> { stands: Array<{x,y,w,h}>, cars: Array<{x,y,angle,color}>, trees: Array<{x,y,r}> }` — `stands` `x,y` are the rectangle **centre**, not a corner.
  - Constants used by Task 3's painting and by the tests: `KERB`, `KERB_DASH`, `RUNOFF_MAX`, `RUNOFF_MIN`, `WORLD_W`, `WORLD_H`, `WORLD_INSET`, `FURNITURE_GAP`, `FURNITURE_TOL`, `START_U_LO`, `START_U_HI`.

- [ ] **Step 1: Write the failing test**

Create `test/scenery.js`:

```js
/** Unit tests for the derivation half of public/scenery.js.
 *  The painting half needs a canvas and is verified in the browser.
 *  Usage: node test/scenery.js */
const RTMaps = require('../public/maps.js');
const S = require('../public/scenery.js');

const checks = [];
function check(label, cond) {
  checks.push({ label, cond: !!cond });
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
}

console.log('scenery.js — run-off budget');

for (const map of RTMaps.MAPS) {
  const budget = (map.clearance - 2 * map.halfWidth) / 2;
  const ro = S.runoffFor(map);
  check(`${map.name}: run-off within the geometric budget`, ro <= budget + 1e-9);
  check(`${map.name}: run-off never negative`, ro >= 0);
  check(`${map.name}: run-off is 0 or at least RUNOFF_MIN`, ro === 0 || ro >= S.RUNOFF_MIN);
  check(`${map.name}: run-off capped at RUNOFF_MAX`, ro <= S.RUNOFF_MAX);
}

// Double Downtime has an 8px budget — under RUNOFF_MIN, so it must get no sand.
// Go-Live GP has 51px and must get the full cap. These two anchor the rule: a
// runoffFor that returned a constant would fail one of them.
const tight = RTMaps.MAPS.find((m) => m.name === 'Double Downtime');
const roomy = RTMaps.MAPS.find((m) => m.name === 'Go-Live GP');
check('the tightest track gets no sand', S.runoffFor(tight) === 0);
check('the roomiest track gets the full cap', S.runoffFor(roomy) === S.RUNOFF_MAX);

console.log('scenery.js — furniture placement');

for (const map of RTMaps.MAPS) {
  const items = S.furnitureFor(map);
  const want = map.halfWidth + S.runoffFor(map) + S.FURNITURE_GAP;
  check(`${map.name}: produces at least one item`, items.length > 0);
  check(`${map.name}: every kind is known`,
    items.every((f) => f.kind === 'board' || f.kind === 'tyres'));
  check(`${map.name}: every board carries a finite angle`,
    items.every((f) => f.kind !== 'board' || Number.isFinite(f.angle)));
  check(`${map.name}: every item clears the corridor test`,
    items.every((f) => RTMaps.closest(map.path, f.x, f.y).dist >= want - S.FURNITURE_TOL));
  check(`${map.name}: every item is inside the world inset`,
    items.every((f) => f.x >= S.WORLD_INSET && f.x <= S.WORLD_W - S.WORLD_INSET &&
                       f.y >= S.WORLD_INSET && f.y <= S.WORLD_H - S.WORLD_INSET));
  check(`${map.name}: nothing sits on the start line`,
    items.every((f) => f.u > S.START_U_LO && f.u < S.START_U_HI));
}

console.log('scenery.js — trackside scenery');

for (const map of RTMaps.MAPS) {
  const sc = S.sceneryFor(map);
  const lg = map.logo, lgH = lg.w * 0.262, pad = 30;
  const outsideLogo = (o) =>
    o.x <= lg.x - lg.w / 2 - pad || o.x >= lg.x + lg.w / 2 + pad ||
    o.y <= lg.y - lgH / 2 - pad || o.y >= lg.y + lgH / 2 + pad;
  const far = (o, min) => RTMaps.closest(map.path, o.x, o.y).dist > min;
  const all = [...sc.stands, ...sc.cars, ...sc.trees];
  check(`${map.name}: scenery avoids the logo plate`, all.every(outsideLogo));
  check(`${map.name}: stands clear their distance floor`, sc.stands.every((o) => far(o, 190)));
  check(`${map.name}: cars clear their distance floor`, sc.cars.every((o) => far(o, 175)));
  check(`${map.name}: trees clear their distance floor`, sc.trees.every((o) => far(o, 150)));
  check(`${map.name}: some trees are placed`, sc.trees.length > 0);
  check(`${map.name}: every car has a colour`, sc.cars.every((o) => typeof o.color === 'string'));
  // Nothing may sit on a grandstand; a tree on a roof reads as a rendering bug.
  const onStand = (o, pad) => sc.stands.some((s) =>
    o.x > s.x - s.w / 2 - pad && o.x < s.x + s.w / 2 + pad &&
    o.y > s.y - s.h / 2 - pad && o.y < s.y + s.h / 2 + pad);
  check(`${map.name}: no car sits on a grandstand`, sc.cars.every((o) => !onStand(o, 20)));
  check(`${map.name}: no tree sits on a grandstand`, sc.trees.every((o) => !onStand(o, o.r)));
}

console.log('scenery.js — determinism');

// Placement must not depend on Math.random: every client has to decorate a track
// the same way, and the offscreen layer is only built once per map.
for (const map of RTMaps.MAPS) {
  check(`${map.name}: furnitureFor is deterministic`,
    JSON.stringify(S.furnitureFor(map)) === JSON.stringify(S.furnitureFor(map)));
  check(`${map.name}: sceneryFor is deterministic`,
    JSON.stringify(S.sceneryFor(map)) === JSON.stringify(S.sceneryFor(map)));
}

// Different maps must not decorate identically, which a constant seed would cause.
check('different maps get different furniture',
  JSON.stringify(S.furnitureFor(RTMaps.MAPS[0])) !== JSON.stringify(S.furnitureFor(RTMaps.MAPS[1])));

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/scenery.js`
Expected: crashes immediately with `Cannot find module '../public/scenery.js'`. Exit code 1.

- [ ] **Step 3: Write the derivation half**

Create `public/scenery.js`:

```js
/* Rev-Trac Racer — trackside decoration (client-only, purely cosmetic).
 *
 * Widths and object placements are derived from each track's own geometry, so no
 * circuit is hand-tuned and none can render broken: a track whose corridors run
 * close together simply gets less decoration.
 *
 * Two halves, deliberately separated. Everything above the painting marker is
 * pure and unit-tested from node (test/scenery.js). Everything below needs a
 * canvas and is verified in the browser.
 *
 * The server never loads this file and nothing here affects the simulation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./maps.js'));
  else root.RTScenery = factory(root.RTMaps);
})(typeof self !== 'undefined' ? self : this, function (RTMaps) {
  const WORLD_W = 1600, WORLD_H = 1000;   // matches the canvas at index.html:84

  const KERB = 14;                        // kerb width, each side of the asphalt
  const KERB_DASH = [22, 22];
  const RUNOFF_MAX = 34;                  // sand never grows past this
  const RUNOFF_MIN = 12;                  // thinner reads as an artefact, not sand
  const WORLD_INSET = 24;                 // keep objects off the world edge
  const FURNITURE_STEP = 46;              // sampling interval along the loop
  const FURNITURE_GAP = 16;               // beyond the outer edge of the run-off
  const FURNITURE_TOL = 6;                // slack in the corridor test
  const START_U_LO = 0.02, START_U_HI = 0.985;  // kept clear for the start line
  const LOGO_PAD = 30;                    // exclusion margin around the wordmark
  const LOGO_ASPECT = 0.262;              // logo height / width, as game.js uses

  const PALETTE = {
    grass: '#7fb442', grassAlt: '#6da438', sand: '#e6d9a8', asphalt: '#494d54',
    kerbRed: '#e0353d', kerbWhite: '#f7f8fa', centre: 'rgba(255,255,255,0.5)',
  };

  const CAR_COLORS = ['#e0353d', '#f2b134', '#3f7fd4', '#4aa564', '#d8dde6', '#8a5cc4'];

  // xorshift32. Seeded per map so every client decorates a track identically and
  // screenshots reproduce; Math.random would break both.
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }

  // Sand half-width beyond the kerb, from the track's own self-clearance. Zero
  // when two parts of the loop run close enough that a band would flood the gap.
  function runoffFor(map) {
    const budget = (map.clearance - 2 * map.halfWidth) / 2;
    if (!Number.isFinite(budget) || budget < RUNOFF_MIN) return 0;
    return Math.min(RUNOFF_MAX, budget);
  }

  // Barrier boards and tyre stacks along the outer edge of the run-off.
  function furnitureFor(map) {
    const rand = rng(map.id * 2654435761 + 7);
    const want = map.halfWidth + runoffFor(map) + FURNITURE_GAP;
    const out = [];
    for (let d = 0; d < map.path.total; d += FURNITURE_STEP) {
      const u = d / map.path.total;
      const pt = RTMaps.pointAt(map.path, u);
      for (const side of [1, -1]) {
        // Draw the roll before any rejection test, so which slots survive never
        // shifts the PRNG stream for the slots that follow.
        const roll = rand();
        if (u <= START_U_LO || u >= START_U_HI) continue;
        const x = pt.x - pt.ty * side * want;
        const y = pt.y + pt.tx * side * want;
        if (x < WORLD_INSET || x > WORLD_W - WORLD_INSET) continue;
        if (y < WORLD_INSET || y > WORLD_H - WORLD_INSET) continue;
        // The corridor test. If some other part of the loop is nearer than the
        // offset we asked for, the two corridors have merged here — there is no
        // trackside to stand on, so drop the slot.
        if (RTMaps.closest(map.path, x, y).dist < want - FURNITURE_TOL) continue;
        if (roll < 0.55) out.push({ kind: 'board', x, y, u, angle: Math.atan2(pt.ty, pt.tx) });
        else if (roll < 0.72) out.push({ kind: 'tyres', x, y, u });
        // the rest stay empty, so spacing reads irregular rather than mechanical
      }
    }
    return out;
  }

  // Grandstands, paddock cars and trees, in deep grass only.
  function sceneryFor(map) {
    const rand = rng(map.id * 40503 + 31);
    const lg = map.logo;
    const lgH = lg.w * LOGO_ASPECT;

    // The infield is far from the centreline, so a distance test alone drops
    // trees straight onto the Rev-Trac wordmark. Exclude its plate explicitly.
    function clear(x, y, min) {
      if (x > lg.x - lg.w / 2 - LOGO_PAD && x < lg.x + lg.w / 2 + LOGO_PAD &&
          y > lg.y - lgH / 2 - LOGO_PAD && y < lg.y + lgH / 2 + LOGO_PAD) return false;
      return RTMaps.closest(map.path, x, y).dist > min;
    }

    // Stands first, so cars and trees can be kept off them. Without this a tree
    // lands on a grandstand roof and reads as a rendering bug.
    const stands = [];
    for (const [x, y] of [[105, 180], [WORLD_W - 105, WORLD_H - 180]]) {
      if (clear(x, y, 190)) stands.push({ x, y, w: 150, h: 300 });
    }
    function onStand(x, y, pad) {
      return stands.some(function (s) {
        return x > s.x - s.w / 2 - pad && x < s.x + s.w / 2 + pad &&
               y > s.y - s.h / 2 - pad && y < s.y + s.h / 2 + pad;
      });
    }

    const cars = [];
    for (let i = 0; i < 26; i++) {
      const x = 40 + rand() * (WORLD_W - 80);
      const y = 40 + rand() * (WORLD_H - 80);
      const angle = rand() < 0.5 ? 0 : Math.PI / 2;
      const color = CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)];
      if (clear(x, y, 175) && !onStand(x, y, 20)) cars.push({ x, y, angle, color });
    }

    const trees = [];
    for (let i = 0; i < 60; i++) {
      const x = WORLD_INSET + rand() * (WORLD_W - 2 * WORLD_INSET);
      const y = WORLD_INSET + rand() * (WORLD_H - 2 * WORLD_INSET);
      const r = 11 + rand() * 9;
      if (clear(x, y, 150) && !onStand(x, y, r)) trees.push({ x, y, r });
    }

    return { stands, cars, trees };
  }

  return {
    PALETTE, runoffFor, furnitureFor, sceneryFor,
    KERB, KERB_DASH, RUNOFF_MAX, RUNOFF_MIN,
    WORLD_W, WORLD_H, WORLD_INSET, FURNITURE_GAP, FURNITURE_TOL,
    START_U_LO, START_U_HI,
  };
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node test/scenery.js`
Expected: PASS with every check `ok`. If `the roomiest track gets the full cap` fails, `RUNOFF_MAX` is above Go-Live GP's 51px budget — do not change the assertion, check the constant.

- [ ] **Step 5: Prove the corridor test is load-bearing**

Temporarily comment out the corridor-test line in `furnitureFor`:

```js
        // if (RTMaps.closest(map.path, x, y).dist < want - FURNITURE_TOL) continue;
```

Run: `node test/scenery.js`
Expected: FAIL — `every item clears the corridor test` fails on several maps. Then restore the line and confirm PASS again. A test that passes with the rule removed is worthless; this step proves it is not.

- [ ] **Step 6: Wire it into npm test**

In `package.json`, change the `test` script to:

```json
    "test": "node test/store.js && node test/leaderboard.js && node test/scenery.js && node test/validate-maps.js"
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all four scripts pass, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add public/scenery.js test/scenery.js package.json
git commit -m "feat(scenery): derive trackside decoration from track geometry

Widths and placements come from each circuit's own self-clearance rather than
fixed numbers, because the tracks have between 51px and 8px of grass between
neighbouring parts of the same loop. A fixed band would flood the tight ones.
Double Downtime therefore gets no sand, and every discrete object passes a
closest() corridor test that drops slots where two corridors have merged.

Placement is seeded per map id, never Math.random: the offscreen layer is built
once per map and every client has to decorate a track the same way.

This is the pure half only -- no canvas, so it is unit tested across all eight
maps. The corridor test was verified load-bearing by removing it and watching
the assertions fail."
```

---

### Task 3: Painting half of scenery.js, and the cached track layer

Adds the canvas half and switches `game.js` over to it. The whole track becomes one offscreen image that the frame loop blits, replacing four full-path strokes per frame.

**Files:**
- Modify: `public/scenery.js` (append the painting half)
- Modify: `public/index.html:84` area (add the `scenery.js` script tag)
- Modify: `public/game.js` (replace `trackPath2D`/`drawTrack`; add the layer cache and the logo invalidation)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces:
  - `RTScenery.paintTrack(ctx, map, logoImg)` — paints the complete static layer into `ctx` in world coordinates. `logoImg` may be `null` or not yet loaded, in which case the wordmark is skipped.
  - `RTScenery.paintPreview(ctx, map)` — palette, sand and kerbs only, for Task 4's lobby cards.

- [ ] **Step 1: Append the painting half to public/scenery.js**

Insert immediately before the final `return { ... };` block:

```js
  // ---- painting -----------------------------------------------------------
  // Canvas from here down. node never calls into this half, so Path2D and
  // friends being browser-only is fine; test/scenery.js covers the pure half.

  const pathCache = new Map();            // map id -> Path2D

  function trackPath(map) {
    let p = pathCache.get(map.id);
    if (!p) {
      p = new Path2D();
      map.pts.forEach(function (pt, i) {
        if (i === 0) p.moveTo(pt[0], pt[1]); else p.lineTo(pt[0], pt[1]);
      });
      p.closePath();
      pathCache.set(map.id, p);
    }
    return p;
  }

  function paintGrass(ctx, seed) {
    ctx.fillStyle = PALETTE.grass;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    const rand = rng(seed);
    ctx.fillStyle = PALETTE.grassAlt;
    for (let i = 0; i < 40; i++) {
      const x = rand() * WORLD_W, y = rand() * WORLD_H, r = 40 + rand() * 90;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.6, rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let y = 0; y < WORLD_H; y += 80) ctx.fillRect(0, y, WORLD_W, 40);
  }

  function paintSurface(ctx, map, runoff) {
    const path = trackPath(map), hw = map.halfWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (runoff > 0) {
      ctx.lineWidth = hw * 2 + runoff * 2;
      ctx.strokeStyle = PALETTE.sand;
      ctx.stroke(path);
    }

    ctx.lineWidth = hw * 2 + KERB * 2;
    ctx.strokeStyle = PALETTE.kerbRed;
    ctx.stroke(path);
    // Butt caps, not round. A round cap extends every dash by half the line
    // width at each end; at this width (~200px) a 22px dash grows by ~100px in
    // both directions and the dashes fuse into a solid white band. That was the
    // old renderer's bug -- the kerb read as a plain white edge, never red/white.
    ctx.lineCap = 'butt';
    ctx.setLineDash(KERB_DASH);
    ctx.strokeStyle = PALETTE.kerbWhite;
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.lineCap = 'round';

    ctx.lineWidth = hw * 2;
    ctx.strokeStyle = PALETTE.asphalt;
    ctx.stroke(path);

    ctx.lineWidth = 4;
    ctx.strokeStyle = PALETTE.centre;
    ctx.setLineDash([30, 34]);
    ctx.stroke(path);
    ctx.setLineDash([]);
  }

  function paintStartLine(ctx, map) {
    const hw = map.halfWidth, st = RTMaps.pointAt(map.path, 0), sq = 15;
    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.rotate(Math.atan2(st.ty, st.tx));
    for (let row = 0; row < Math.ceil((hw * 2) / sq); row++) {
      for (let col = 0; col < 2; col++) {
        ctx.fillStyle = (row + col) % 2 === 0 ? '#fff' : '#111';
        ctx.fillRect((col - 2) * sq, -hw + row * sq, sq, Math.min(sq, hw * 2 - row * sq));
      }
    }
    ctx.restore();
  }

  function paintBoard(ctx, x, y, angle) {
    const w = 46, h = 13;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = PALETTE.kerbWhite;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();
    ctx.strokeStyle = PALETTE.kerbRed;
    ctx.lineWidth = 7;
    for (let i = -h; i < w + h; i += 13) {
      ctx.beginPath();
      ctx.moveTo(-w / 2 + i, -h / 2 - 2);
      ctx.lineTo(-w / 2 + i - h - 4, h / 2 + 2);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function paintTyres(ctx, x, y) {
    const offsets = [[0, 0], [13, -6], [-12, -7], [1, -14]];
    for (const off of offsets) {
      ctx.beginPath();
      ctx.arc(x + off[0], y + off[1], 8.5, 0, Math.PI * 2);
      ctx.fillStyle = '#2b2f35';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + off[0], y + off[1], 3.6, 0, Math.PI * 2);
      ctx.fillStyle = '#8b9099';
      ctx.fill();
    }
  }

  function paintScenery(ctx, sc) {
    for (const s of sc.stands) {
      const bx = s.x - s.w / 2, by = s.y - s.h / 2;
      ctx.fillStyle = '#5b6272';
      ctx.fillRect(bx, by, s.w, s.h);
      ctx.fillStyle = '#d8dde6';
      const rows = 5, gap = 10, inner = (s.h - 32) / rows;
      for (let i = 0; i < rows; i++) {
        ctx.fillRect(bx + 14, by + 16 + i * inner, s.w - 28, inner - gap);
      }
    }
    for (const c of sc.cars) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle);
      ctx.fillStyle = c.color;
      ctx.fillRect(-16, -9, 32, 18);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-6, -9, 11, 18);
      ctx.restore();
    }
    for (const t of sc.trees) {
      ctx.beginPath();
      ctx.arc(t.x + 2, t.y + 3, t.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
      ctx.fillStyle = '#2f6b2a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(t.x - t.r * 0.28, t.y - t.r * 0.28, t.r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#3d8534';
      ctx.fill();
    }
  }

  // game.js has its own roundRect, but it closes over that module's ctx and is
  // not reachable from here. One local helper beats inlining arcTo at the sites.
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function paintLogo(ctx, map, logoImg) {
    const lg = map.logo;
    if (logoImg && logoImg.complete && logoImg.naturalWidth) {
      const lw = lg.w;
      const lh = lw * (logoImg.naturalHeight / logoImg.naturalWidth);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#f4f5f7';
      roundRect(ctx, lg.x - lw / 2 - 18, lg.y - lh / 2 - 14, lw + 36, lh + 28, 14);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.drawImage(logoImg, lg.x - lw / 2, lg.y - lh / 2, lw, lh);
      ctx.restore();
    }
    ctx.font = '800 26px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(map.name.toUpperCase(), lg.x, lg.y + (lg.w * LOGO_ASPECT) / 2 + 46);
  }

  // The complete static layer, in world coordinates. Scenery goes down before
  // furniture so boards read on top of trees, and the wordmark goes last so
  // nothing can cover it.
  function paintTrack(ctx, map, logoImg) {
    paintGrass(ctx, map.id + 1);
    paintSurface(ctx, map, runoffFor(map));
    paintStartLine(ctx, map);
    paintScenery(ctx, sceneryFor(map));
    for (const f of furnitureFor(map)) {
      if (f.kind === 'board') paintBoard(ctx, f.x, f.y, f.angle);
      else paintTyres(ctx, f.x, f.y);
    }
    paintLogo(ctx, map, logoImg);
  }

  // Lobby cards: palette and surface only. At card size a barrier board is 2-3px
  // and reads as noise, so furniture and scenery are deliberately omitted.
  function paintPreview(ctx, map) {
    ctx.fillStyle = PALETTE.grass;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    paintSurface(ctx, map, runoffFor(map));
    paintStartLine(ctx, map);
  }
```

Then add `paintTrack` and `paintPreview` to the returned object:

```js
  return {
    PALETTE, runoffFor, furnitureFor, sceneryFor,
    paintTrack, paintPreview,
    KERB, KERB_DASH, RUNOFF_MAX, RUNOFF_MIN,
    WORLD_W, WORLD_H, WORLD_INSET, FURNITURE_GAP, FURNITURE_TOL,
    START_U_LO, START_U_HI,
  };
```

- [ ] **Step 2: Confirm the node half still works**

Run: `node test/scenery.js`
Expected: PASS, unchanged count. This proves the browser-only painting code did not break the `require` path — `Path2D` must only be referenced inside function bodies, never at module scope.

- [ ] **Step 3: Add the script tag**

In `public/index.html`, find the existing script tags for `maps.js`, `cars.js` and `game.js` near the bottom of the file. Add `scenery.js` **after** `maps.js` and **before** `game.js`, because it reads `RTMaps` at factory time:

```html
    <script src="scenery.js"></script>
```

- [ ] **Step 4: Replace game.js rendering with a cached blit**

In `public/game.js`, replace the whole block from `const trackPathCache = new Map();` through the end of `drawTrack` (currently lines 598-679) with:

```js
  // The track is entirely static, so it is painted once into an offscreen canvas
  // and blitted each frame. This replaces four full-path strokes per frame, so it
  // is cheaper than the old renderer despite drawing far more.
  // Only the current map is cached: one 1600x1000 layer is ~6MB, and caching all
  // eight would be ~51MB for no benefit — you race one track at a time.
  let trackLayer = null;    // { mapId, canvas }

  function trackLayerFor(map) {
    if (trackLayer && trackLayer.mapId === map.id) return trackLayer.canvas;
    const cv = document.createElement('canvas');
    cv.width = WORLD_W;
    cv.height = WORLD_H;
    RTScenery.paintTrack(cv.getContext('2d'), map, logoImg);
    trackLayer = { mapId: map.id, canvas: cv };
    return cv;
  }

  function drawTrack(map) {
    // logoImg loads asynchronously. Caching before it lands would bake a missing
    // wordmark in for the life of the page, so paint straight to the screen until
    // it is ready; logoImg.onload drops any layer built without it.
    if (!(logoImg.complete && logoImg.naturalWidth)) {
      RTScenery.paintTrack(ctx, map, logoImg);
      return;
    }
    ctx.drawImage(trackLayerFor(map), 0, 0);
  }
```

- [ ] **Step 5: Invalidate the layer when the logo arrives**

In `public/game.js`, replace lines 62-63:

```js
  const logoImg = new Image();
  logoImg.src = 'revtrac-logo.svg';
```

with:

```js
  const logoImg = new Image();
  // Drop any layer painted before the wordmark arrived. The handler cannot fire
  // until module evaluation finishes, so referencing trackLayer (declared further
  // down) is safe.
  logoImg.onload = function () { trackLayer = null; };
  logoImg.src = 'revtrac-logo.svg';
```

- [ ] **Step 6: Check for orphaned references**

Run: `grep -n 'trackPath2D\|trackPathCache' public/game.js`
Expected: no output. Both were removed with Step 4; `roundRect` is still used by `drawPads`, so leave it alone.

- [ ] **Step 7: Verify in the browser**

```bash
RTR_STORE_PATH=/tmp/rtr-scenery.json PORT=4200 LAPS=1 node server.js
```

Open `http://localhost:4200`, claim a name, create a room, start a race. Confirm:
- kerbs are alternating red and white **blocks**, not a solid white band
- Go-Live GP shows a sand run-off; Double Downtime shows none
- barrier boards and tyre stacks sit outside the run-off, and none overlap the asphalt
- no scenery covers the Rev-Trac wordmark or the track name
- the browser console is clean — no errors, no warnings
- a hard reload still shows the logo (proves the invalidation works)

- [ ] **Step 8: Commit**

```bash
git add public/scenery.js public/game.js public/index.html
git commit -m "feat(render): paint the reference-style track into a cached layer

Adds the painting half of scenery.js and switches drawTrack to blitting one
offscreen canvas instead of re-stroking the world every frame. Net fewer stroke
operations per frame than before, despite grass mottling, sand, furniture and
scenery being new.

The kerb now uses butt caps for its dashed pass. With the round cap the old code
left set, each 22px dash grew by half the ~200px line width at both ends and the
dashes fused -- which is why the kerb has always read as a plain white edge
rather than red/white blocks.

The layer waits for logoImg and is invalidated by its onload. Building it before
the wordmark loads would bake a missing logo in for the life of the page."
```

---

### Task 4: Lobby preview cards, and car legibility verification

The lobby's eight map cards currently draw an abstract navy-on-grey icon. They move to the real palette so the card resembles the track you land on. Then the one open visual risk gets checked.

**Files:**
- Modify: `public/game.js:333-360` (`drawMapPreview`)
- Modify: `README.md` (one paragraph)

**Interfaces:**
- Consumes: `RTScenery.paintPreview(ctx, map)` and `RTScenery.PALETTE` from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Rewrite drawMapPreview**

Replace the whole of `drawMapPreview` (currently lines 333-360) with:

```js
  function drawMapPreview(cv, map, selected) {
    const c = cv.getContext('2d');
    const scale = Math.min(cv.width / WORLD_W, cv.height / WORLD_H);
    c.fillStyle = RTScenery.PALETTE.grass;
    c.fillRect(0, 0, cv.width, cv.height);
    c.save();
    c.translate((cv.width - WORLD_W * scale) / 2, (cv.height - WORLD_H * scale) / 2);
    c.scale(scale, scale);
    RTScenery.paintPreview(c, map);
    // Start marker, sized in world units so it survives the scale.
    const st = RTMaps.pointAt(map.path, 0);
    c.fillStyle = selected ? '#fff' : 'rgba(255,255,255,0.7)';
    c.beginPath();
    c.arc(st.x, st.y, 22, 0, Math.PI * 2);
    c.fill();
    c.restore();
    if (selected) {
      c.strokeStyle = BRAND_RED;
      c.lineWidth = 3;
      c.strokeRect(1.5, 1.5, cv.width - 3, cv.height - 3);
    }
  }
```

The selected state moves from tinting the track to a red border, because the track now has its own fixed colours and cannot carry that signal.

- [ ] **Step 2: Verify the lobby in the browser**

With the server from Task 3 Step 7 running, open `http://localhost:4200`, claim a name and create a room. Confirm:
- all eight cards render as green circuits with visible red/white kerbs
- the selected card is unmistakable from the others at card size
- the start marker is visible on every card
- the console is clean

- [ ] **Step 3: Verify car legibility against the bright grass**

`Release Rocket` (`#57cc3f`) and `Patch Panther` (`#9ef01a`) are close in hue to `PALETTE.grass` (`#7fb442`). `drawCarBody` already strokes every main body shape with `rgba(0,0,0,0.45)` at `lineWidth = 2` (`public/game.js:93`), so the mitigation should already be in place — this step confirms it rather than changing anything.

In two browser windows, join one room with each of those two cars, drive both off the track onto the grass, and judge whether the silhouette and the name label stay readable.

Expected: readable, no change needed. If either disappears into the grass, the minimal fix is raising `lineWidth` to 3 or darkening the stroke to `rgba(0,0,0,0.6)` in `drawCarBody` — do not add new geometry, and do not change the car's colour, which is shared with the server roster in `cars.js`.

- [ ] **Step 4: Document it**

In `README.md`, add this to the section describing the tracks:

```markdown
Track decoration (kerbs, sand run-off, barrier boards, tyre stacks, grandstands,
trees) is drawn by `public/scenery.js` and is **purely cosmetic** — the server
never loads that file and nothing in it affects the simulation. Cars pass through
barriers; running off the track only caps your speed, as it always has.

Every width and placement is derived from the track's own geometry rather than
hand-tuned, because the circuits have between 51px and 8px of grass between
neighbouring parts of the same loop. A track with no room simply gets less
decoration: Double Downtime has no sand run-off, and barrier boards appear only
where a `closest()` corridor test confirms there is trackside to stand on. To
change the whole look, edit `PALETTE` in `public/scenery.js`.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: four scripts pass, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add public/game.js README.md
git commit -m "feat(lobby): preview cards use the real track palette

The cards drew an abstract navy-on-grey icon, so after the render change they no
longer resembled the track you land on. They now share the surface painter, so a
card cannot drift from the race view. Furniture and scenery are deliberately left
out: at card size a barrier board is 2-3px and reads as noise.

Selection moves from tinting the track to a red border -- the track now has fixed
colours and cannot carry that signal.

Also documents in the README that all of this is cosmetic and derived from track
geometry, so nobody goes looking for the collision code."
```

---

## Self-Review

**Spec coverage.** §2 kerb bug → Task 3 Step 1 (`paintSurface`, butt caps). §3 clearance constraint → Task 1, consumed by Task 2's `runoffFor` and corridor test. §4 architecture and `map.clearance` deviation → Tasks 1-3. §5 derivation rules, all exact values → Task 2 Step 3. §6 palette → Task 2 Step 3 `PALETTE`. §7 caching, logo async → Task 3 Steps 4-5. §8 car legibility, verification-only → Task 4 Step 3. §9 testing → Task 2 Steps 1-7 plus Task 1's finiteness assertion. §10 out of scope → Global Constraints. Lobby previews → Task 4. No gaps.

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code. Every run step names the command and the expected result. Task 4 Step 3 is a verification step with an explicit conditional remedy rather than a vague "handle it".

**Type consistency.** `map.clearance` is a number everywhere (Task 1 stores `.dist`, Tasks 2 and the validator read the number). `selfClearance` returns `{dist,i,j}` and is only destructured that way in Task 1 Step 6. `runoffFor`/`furnitureFor`/`sceneryFor`/`paintTrack`/`paintPreview` keep identical signatures in the module, the tests and the callers. `stands` entries are centre-based `{x,y,w,h}` in Task 2 and consumed centre-based in Task 3's `paintScenery`. `furnitureFor` items use `angle` (not `a`) in both the module and the test. `PALETTE.centre` is used, not `centreline`.

**One risk flagged for the reviewer.** Task 3 Step 4 deletes a large contiguous block of `game.js` by line number. Line numbers shift as earlier steps edit the same file, so the implementer must match on the code, not the numbers.
