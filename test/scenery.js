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
  // Every track must get a grandstand. Fixed corner positions left five of eight
  // with none, so this assertion is what proves the grid scan actually adapts.
  check(`${map.name}: gets one or two grandstands`,
    sc.stands.length >= 1 && sc.stands.length <= 2);
  const need = map.halfWidth + S.runoffFor(map) + S.STAND_CLEAR;
  check(`${map.name}: every stand clears the corridor at all four corners`,
    sc.stands.every((s) => [
      [s.x, s.y],
      [s.x - s.w / 2, s.y - s.h / 2], [s.x + s.w / 2, s.y - s.h / 2],
      [s.x - s.w / 2, s.y + s.h / 2], [s.x + s.w / 2, s.y + s.h / 2],
    ].every(([px, py]) => RTMaps.closest(map.path, px, py).dist > need)));
  check(`${map.name}: every stand is fully inside the world`,
    sc.stands.every((s) =>
      s.x - s.w / 2 >= S.WORLD_INSET && s.x + s.w / 2 <= S.WORLD_W - S.WORLD_INSET &&
      s.y - s.h / 2 >= S.WORLD_INSET && s.y + s.h / 2 <= S.WORLD_H - S.WORLD_INSET));
  check(`${map.name}: cars clear their distance floor`, sc.cars.every((o) => far(o, S.CAR_FLOOR)));
  check(`${map.name}: trees clear their distance floor`, sc.trees.every((o) => far(o, S.TREE_FLOOR)));
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
