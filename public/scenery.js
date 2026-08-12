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
  const STAND_W = 120, STAND_H = 210;     // grandstand footprint
  const STAND_CLEAR = 30;                 // stand must clear the corridor by this
  const CAR_FLOOR = 135;                  // paddock cars stay this far off the loop
  const TREE_FLOOR = 150;

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
    //
    // Scanned on a grid rather than dropped at fixed corners. Fixed corners were
    // tried and left five of the eight tracks with no grandstand at all: the
    // circuits that use the full world pass within a stand's width of every
    // corner. A stand is accepted only where its centre AND all four corners
    // clear the decorated corridor, so some land in the infield — which is where
    // real circuits put them.
    const need = map.halfWidth + runoffFor(map) + STAND_CLEAR;
    function standFits(x, y) {
      if (x - STAND_W / 2 < WORLD_INSET || x + STAND_W / 2 > WORLD_W - WORLD_INSET) return false;
      if (y - STAND_H / 2 < WORLD_INSET || y + STAND_H / 2 > WORLD_H - WORLD_INSET) return false;
      const corners = [
        [x, y],
        [x - STAND_W / 2, y - STAND_H / 2], [x + STAND_W / 2, y - STAND_H / 2],
        [x - STAND_W / 2, y + STAND_H / 2], [x + STAND_W / 2, y + STAND_H / 2],
      ];
      return corners.every(function (c) { return clear(c[0], c[1], need); });
    }
    const stands = [];
    for (let y = WORLD_INSET + STAND_H / 2; y <= WORLD_H - WORLD_INSET - STAND_H / 2 && stands.length < 2; y += 70) {
      for (let x = WORLD_INSET + STAND_W / 2; x <= WORLD_W - WORLD_INSET - STAND_W / 2 && stands.length < 2; x += 70) {
        if (!standFits(x, y)) continue;
        // keep the two stands apart so they do not read as one long building
        if (stands.some(function (s) {
          return Math.abs(s.x - x) < STAND_W + 40 && Math.abs(s.y - y) < STAND_H + 40;
        })) continue;
        stands.push({ x, y, w: STAND_W, h: STAND_H });
      }
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
      if (clear(x, y, CAR_FLOOR) && !onStand(x, y, 20)) cars.push({ x, y, angle, color });
    }

    const trees = [];
    for (let i = 0; i < 60; i++) {
      const x = WORLD_INSET + rand() * (WORLD_W - 2 * WORLD_INSET);
      const y = WORLD_INSET + rand() * (WORLD_H - 2 * WORLD_INSET);
      const r = 11 + rand() * 9;
      if (clear(x, y, TREE_FLOOR) && !onStand(x, y, r)) trees.push({ x, y, r });
    }

    return { stands, cars, trees };
  }

  return {
    PALETTE, runoffFor, furnitureFor, sceneryFor,
    KERB, KERB_DASH, RUNOFF_MAX, RUNOFF_MIN,
    WORLD_W, WORLD_H, WORLD_INSET, FURNITURE_GAP, FURNITURE_TOL,
    START_U_LO, START_U_HI,
    STAND_W, STAND_H, STAND_CLEAR, CAR_FLOOR, TREE_FLOOR,
  };
});
