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
// A runoffFor that always returns 0 (or any other constant) would pass every
// per-map "never negative" / "capped" check above. Require actual variation.
check('run-off values are not all identical across the maps',
  new Set(RTMaps.MAPS.map((m) => S.runoffFor(m))).size > 1);

console.log('scenery.js — furniture placement');

const allFurniture = [];
for (const map of RTMaps.MAPS) {
  const items = S.furnitureFor(map);
  allFurniture.push(...items);
  const want = map.halfWidth + S.runoffFor(map) + S.FURNITURE_GAP;
  check(`${map.name}: produces at least one item`, items.length > 0);
  check(`${map.name}: every kind is known`,
    items.every((f) => f.kind === 'board' || f.kind === 'tyres'));
  check(`${map.name}: every board carries a finite angle`,
    items.every((f) => f.kind !== 'board' || Number.isFinite(f.angle)));
  // An angle hardcoded to 0 would pass "finite", so also check it actually
  // matches the track's own tangent direction at the sample the board came from.
  check(`${map.name}: every board's angle matches the track tangent at its u`,
    items.every((f) => {
      if (f.kind !== 'board') return true;
      const pt = RTMaps.pointAt(map.path, f.u);
      const expected = Math.atan2(pt.ty, pt.tx);
      return Math.abs(f.angle - expected) < 1e-6;
    }));
  check(`${map.name}: every item clears the corridor test`,
    items.every((f) => RTMaps.closest(map.path, f.x, f.y).dist >= want - S.FURNITURE_TOL));
  check(`${map.name}: every item is inside the world inset`,
    items.every((f) => f.x >= S.WORLD_INSET && f.x <= S.WORLD_W - S.WORLD_INSET &&
                       f.y >= S.WORLD_INSET && f.y <= S.WORLD_H - S.WORLD_INSET));
  check(`${map.name}: nothing sits on the start line`,
    items.every((f) => f.u > S.START_U_LO && f.u < S.START_U_HI));
}

// An implementation that always emits 'board' (never rolls into the 'tyres'
// branch) would pass "every kind is known" on every map. Require both kinds to
// actually occur somewhere in the suite.
check('both furniture kinds occur somewhere in the suite',
  allFurniture.some((f) => f.kind === 'board') && allFurniture.some((f) => f.kind === 'tyres'));
// An angle hardcoded to a single constant would still be "finite" and could
// even match the tangent by coincidence on one sample; require real variety.
check('board angles vary across the suite',
  new Set(allFurniture.filter((f) => f.kind === 'board').map((f) => f.angle.toFixed(6))).size > 1);

console.log('scenery.js — trackside scenery');

// The known paddock-car palette (public/scenery.js's CAR_COLORS). Duplicated
// here, not imported, because the module intentionally does not export it —
// this lets the test independently verify every car color is a real palette
// entry rather than something hardcoded outside it.
const KNOWN_CAR_COLORS = ['#e0353d', '#f2b134', '#3f7fd4', '#4aa564', '#d8dde6', '#8a5cc4'];
const allCars = [];

for (const map of RTMaps.MAPS) {
  const sc = S.sceneryFor(map);
  const lg = map.logo, lgH = lg.w * S.LOGO_ASPECT, pad = S.LOGO_PAD;
  const outsideLogo = (o) =>
    o.x <= lg.x - lg.w / 2 - pad || o.x >= lg.x + lg.w / 2 + pad ||
    o.y <= lg.y - lgH / 2 - pad || o.y >= lg.y + lgH / 2 + pad;
  const far = (o, min) => RTMaps.closest(map.path, o.x, o.y).dist > min;
  const all = [...sc.stands, ...sc.cars, ...sc.trees];
  check(`${map.name}: scenery avoids the logo plate`, all.every(outsideLogo));
  // Every track must get a grandstand. Fixed corner positions left five of eight
  // with none, so this assertion is what proves the grid scan actually adapts.
  check(`${map.name}: gets one or two grandstands`,
    sc.stands.length >= 1 && sc.stands.length <= 2);
  const need = map.halfWidth + S.runoffFor(map) + S.STAND_CLEAR;
  check(`${map.name}: every stand clears the corridor across its whole footprint`,
    sc.stands.every((s) => [
      [s.x, s.y],
      [s.x - s.w / 2, s.y - s.h / 2], [s.x + s.w / 2, s.y - s.h / 2],
      [s.x - s.w / 2, s.y + s.h / 2], [s.x + s.w / 2, s.y + s.h / 2],
      [s.x, s.y - s.h / 2], [s.x, s.y + s.h / 2],
      [s.x - s.w / 2, s.y], [s.x + s.w / 2, s.y],
    ].every(([px, py]) => RTMaps.closest(map.path, px, py).dist > need)));
  check(`${map.name}: every stand is fully inside the world`,
    sc.stands.every((s) =>
      s.x - s.w / 2 >= S.WORLD_INSET && s.x + s.w / 2 <= S.WORLD_W - S.WORLD_INSET &&
      s.y - s.h / 2 >= S.WORLD_INSET && s.y + s.h / 2 <= S.WORLD_H - S.WORLD_INSET));
  check(`${map.name}: cars clear their distance floor`, sc.cars.every((o) => far(o, S.CAR_FLOOR)));
  check(`${map.name}: trees clear their distance floor`, sc.trees.every((o) => far(o, S.TREE_FLOOR)));
  // "some trees" (> 0) would pass if only 1 of 60 attempts survived. Require
  // enough that the infield actually reads as decorated.
  check(`${map.name}: several trees are placed`, sc.trees.length >= 5);
  check(`${map.name}: every car has a colour`, sc.cars.every((o) => typeof o.color === 'string'));
  // Nothing may sit on a grandstand; a tree on a roof reads as a rendering bug.
  const onStand = (o, pad) => sc.stands.some((s) =>
    o.x > s.x - s.w / 2 - pad && o.x < s.x + s.w / 2 + pad &&
    o.y > s.y - s.h / 2 - pad && o.y < s.y + s.h / 2 + pad);
  check(`${map.name}: no car sits on a grandstand`, sc.cars.every((o) => !onStand(o, 20)));
  check(`${map.name}: no tree sits on a grandstand`, sc.trees.every((o) => !onStand(o, o.r)));
  allCars.push(...sc.cars);
}

// A hardcoded '#000' would pass "every car has a colour" on every map. Require
// real variety, and that every value actually comes from the known palette.
check('cars use more than one distinct colour across the suite',
  new Set(allCars.map((o) => o.color)).size > 1);
check('every car colour comes from the known palette',
  allCars.every((o) => KNOWN_CAR_COLORS.includes(o.color)));

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
// Comparing only MAPS[0] vs MAPS[1] would miss a bug where maps 3-8 collide with
// each other while 0 and 1 happen to differ, so compare every pair in the suite.
//
// Caveat: this cannot detect an RNG-seeding bug. Furniture coordinates derive from
// each map's own path geometry, so the real eight maps produce different output
// regardless of how the PRNG is seeded -- proven by hardcoding the seed and
// watching the whole suite still pass. What this check does usefully guard
// against is a map-array duplication or aliasing mistake (e.g. the same map
// object appearing twice in RTMaps.MAPS).
const furniturePerMap = RTMaps.MAPS.map((m) => JSON.stringify(S.furnitureFor(m)));
let allPairsDiffer = true;
for (let i = 0; i < furniturePerMap.length; i++) {
  for (let j = i + 1; j < furniturePerMap.length; j++) {
    if (furniturePerMap[i] === furniturePerMap[j]) allPairsDiffer = false;
  }
}
check('every pair of maps gets different furniture', allPairsDiffer);

const failed = checks.filter((c) => !c.cond);
console.log(failed.length ? `FAIL (${failed.length}/${checks.length})` : `PASS (${checks.length} checks)`);
process.exit(failed.length ? 1 : 0);
