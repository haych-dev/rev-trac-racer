'use strict';
/**
 * Static geometry validation for every track in public/maps.js:
 *  - centerline stays inside the world with room for the track width
 *  - no two non-adjacent parts of the loop come close enough to overlap
 *    (except around a declared crossing, e.g. the figure-8)
 *  - furniture (item boxes, boost pads, oil) was generated
 * Usage: node test/validate-maps.js
 */
const RTMaps = require('../public/maps.js');

const { w: WORLD_W, h: WORLD_H } = RTMaps.WORLD;
let failures = 0;

for (const map of RTMaps.MAPS) {
  const { pts, total } = map.path;
  const hw = map.halfWidth;
  const issues = [];

  for (const [x, y] of pts) {
    if (x < hw + 5 || x > WORLD_W - hw - 5 || y < hw + 5 || y > WORLD_H - hw - 5) {
      issues.push(`out of bounds: (${Math.round(x)}, ${Math.round(y)})`);
      break;
    }
  }

  const minGap = 2 * hw + 15;
  const arcExclusion = 3 * hw;
  const nearCrossing = ([x, y]) => map.crossing && Math.hypot(x - map.crossing.x, y - map.crossing.y) < 240 * RTMaps.SCALE;
  let worst = { d: Infinity };
  for (let i = 0; i < pts.length; i++) {
    if (nearCrossing(pts[i])) continue;
    for (let j = i + 1; j < pts.length; j++) {
      if (nearCrossing(pts[j])) continue;
      const arcFwd = map.path.cum[j] - map.path.cum[i];
      const arc = Math.min(arcFwd, total - arcFwd);
      if (arc <= arcExclusion) continue;
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d < worst.d) worst = { d, i, j };
    }
  }
  if (worst.d < minGap) {
    const [x1, y1] = pts[worst.i];
    issues.push(`corridor too tight: ${Math.round(worst.d)}px < ${minGap}px near (${Math.round(x1)}, ${Math.round(y1)})`);
  }

  if (total < 2000) issues.push(`track too short: ${Math.round(total)}px`);
  if (map.itemBoxes.length !== 24) issues.push(`expected 24 item boxes, got ${map.itemBoxes.length}`);
  if (map.oil.length < 2) issues.push(`expected at least 2 oil slicks, got ${map.oil.length}`);
  if (map.boostPads.length !== map.pads) issues.push(`expected ${map.pads} boost pads, got ${map.boostPads.length}`);
  if (!map.oil.length) issues.push('no oil slicks were placed');
  if (!RTMaps.THEMES[map.theme]) issues.push(`unknown theme ${map.theme}`);

  const label = `${map.name.padEnd(19)} len=${Math.round(total)}px hw=${hw} clearance=${Math.round(worst.d)}px pads=${map.boostPads.length} oil=${map.oil.length}${map.crossing ? ' (crossing)' : ''}`;
  if (issues.length) {
    failures++;
    console.log(`FAIL ${label}`);
    issues.forEach((s) => console.log(`     - ${s}`));
  } else {
    console.log(`ok   ${label}`);
  }
}

process.exit(failures ? 1 : 0);
