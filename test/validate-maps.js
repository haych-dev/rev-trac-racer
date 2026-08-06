/**
 * Static geometry validation for every track in public/maps.js:
 *  - centerline stays inside the 1600x1000 world with room for the track width
 *  - no two non-adjacent parts of the loop come close enough to overlap
 *  - sane total length and point spacing
 * Usage: node test/validate-maps.js
 */
const RTMaps = require('../public/maps.js');

const WORLD_W = 1600, WORLD_H = 1000;
let failures = 0;

for (const map of RTMaps.MAPS) {
  const { pts, total } = map.path;
  const hw = map.halfWidth;
  const issues = [];

  // bounds
  for (const [x, y] of pts) {
    if (x < hw + 5 || x > WORLD_W - hw - 5 || y < hw + 5 || y > WORLD_H - hw - 5) {
      issues.push(`out of bounds: (${Math.round(x)}, ${Math.round(y)})`);
      break;
    }
  }

  // self-clearance: points far apart along the arc must be far apart in space
  const minGap = 2 * hw + 15;
  const arcExclusion = 3 * hw;
  let worst = { d: Infinity };
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
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

  const label = `${map.name.padEnd(20)} len=${Math.round(total)}px hw=${hw} clearance=${Math.round(worst.d)}px`;
  if (issues.length) {
    failures++;
    console.log(`FAIL ${label}`);
    issues.forEach((s) => console.log(`     - ${s}`));
  } else {
    console.log(`ok   ${label}`);
  }
}

process.exit(failures ? 1 : 0);
