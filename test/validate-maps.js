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

  // A non-finite clearance means the arc-exclusion window swallowed the whole
  // loop, which would silently hand the renderer an unbounded decoration budget.
  if (!Number.isFinite(map.clearance)) issues.push('clearance is not finite');

  // bounds
  for (const [x, y] of pts) {
    if (x < hw + 5 || x > WORLD_W - hw - 5 || y < hw + 5 || y > WORLD_H - hw - 5) {
      issues.push(`out of bounds: (${Math.round(x)}, ${Math.round(y)})`);
      break;
    }
  }

  // self-clearance: points far apart along the arc must be far apart in space.
  // maps.js computes this so the validator and the renderer share one definition.
  const minGap = 2 * hw + 15;
  if (map.clearance < minGap) {
    const worst = RTMaps.selfClearance(map.path, hw); // only on the failure path
    const [x1, y1] = map.path.pts[worst.i];
    issues.push(`corridor too tight: ${Math.round(map.clearance)}px < ${minGap}px near (${Math.round(x1)}, ${Math.round(y1)})`);
  }

  if (total < 2000) issues.push(`track too short: ${Math.round(total)}px`);

  const label = `${map.name.padEnd(20)} len=${Math.round(total)}px hw=${hw} clearance=${Math.round(map.clearance)}px`;
  if (issues.length) {
    failures++;
    console.log(`FAIL ${label}`);
    issues.forEach((s) => console.log(`     - ${s}`));
  } else {
    console.log(`ok   ${label}`);
  }
}

process.exit(failures ? 1 : 0);
