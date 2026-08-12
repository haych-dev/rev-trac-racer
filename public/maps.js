/* Rev-Trac Racer — shared track definitions (used by server and client).
 * A map is a closed centerline loop (points ordered in the direction of travel)
 * plus a track half-width. All geometry helpers work on arc-length fraction u ∈ [0,1).
 * Hand-crafted circuits are authored as coarse control points and smoothed with
 * Chaikin subdivision; u=0 (the start line) sits at the first control point, so
 * every track starts mid-straight.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTMaps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TAU = Math.PI * 2;

  // Closed-loop corner-cutting smoothing.
  function chaikin(pts, iters) {
    let p = pts;
    for (let k = 0; k < iters; k++) {
      const q = [];
      for (let i = 0; i < p.length; i++) {
        const [x1, y1] = p[i];
        const [x2, y2] = p[(i + 1) % p.length];
        q.push([x1 * 0.75 + x2 * 0.25, y1 * 0.75 + y2 * 0.25]);
        q.push([x1 * 0.25 + x2 * 0.75, y1 * 0.25 + y2 * 0.75]);
      }
      p = q;
    }
    return p;
  }

  // Rounded-rectangle centerline, starting at bottom center heading +x.
  function roundedRectPoints(cx, cy, bx, by, r, step = Math.PI / 12) {
    const pts = [[cx, cy + by + r], [cx + bx, cy + by + r]];
    for (let a = Math.PI / 2 - step; a > 0.0001; a -= step)
      pts.push([cx + bx + r * Math.cos(a), cy + by + r * Math.sin(a)]);
    pts.push([cx + bx + r, cy + by], [cx + bx + r, cy - by]);
    for (let a = -step; a > -Math.PI / 2 + 0.0001; a -= step)
      pts.push([cx + bx + r * Math.cos(a), cy - by + r * Math.sin(a)]);
    pts.push([cx + bx, cy - by - r], [cx - bx, cy - by - r]);
    for (let a = -Math.PI / 2 - step; a > -Math.PI + 0.0001; a -= step)
      pts.push([cx - bx + r * Math.cos(a), cy - by + r * Math.sin(a)]);
    pts.push([cx - bx - r, cy - by], [cx - bx - r, cy + by]);
    for (let a = Math.PI - step; a > Math.PI / 2 + 0.0001; a -= step)
      pts.push([cx - bx + r * Math.cos(a), cy + by + r * Math.sin(a)]);
    pts.push([cx - bx, cy + by + r]);
    return pts;
  }

  // Radially-modulated ellipse. t decreases so travel matches the classic map's
  // handedness (+x along the bottom). t0 picks where the start line sits.
  function parametricPoints(cx, cy, rx, ry, modFn, n, t0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = t0 - (i / n) * TAU;
      const m = modFn(t);
      pts.push([cx + Math.cos(t) * rx * m, cy + Math.sin(t) * ry * m]);
    }
    return pts;
  }

  function buildPath(pts) {
    const n = pts.length;
    const cum = [0];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      total += Math.hypot(x2 - x1, y2 - y1);
      cum.push(total);
    }
    return { pts, cum, total, n };
  }

  // Point + unit tangent at arc-length fraction u.
  function pointAt(path, u) {
    u = ((u % 1) + 1) % 1;
    const d = u * path.total;
    let lo = 0, hi = path.n;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (path.cum[mid] <= d) lo = mid; else hi = mid;
    }
    const segLen = path.cum[lo + 1] - path.cum[lo] || 1;
    const f = (d - path.cum[lo]) / segLen;
    const [x1, y1] = path.pts[lo];
    const [x2, y2] = path.pts[(lo + 1) % path.n];
    return {
      x: x1 + (x2 - x1) * f,
      y: y1 + (y2 - y1) * f,
      tx: (x2 - x1) / segLen,
      ty: (y2 - y1) / segLen,
    };
  }

  // Closest point on the loop: distance from centerline + progress fraction u.
  function closest(path, x, y) {
    let best = { dist: Infinity, u: 0 };
    for (let i = 0; i < path.n; i++) {
      const [x1, y1] = path.pts[i];
      const [x2, y2] = path.pts[(i + 1) % path.n];
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((x - x1) * dx + (y - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + dx * t, py = y1 + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < best.dist) best = { dist: d, u: (path.cum[i] + Math.sqrt(len2) * t) / path.total };
    }
    return best;
  }

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

  const defs = [
    {
      id: 0, name: 'Go-Live GP', halfWidth: 90,
      desc: 'The classic circuit. Balanced corners, honest racing.',
      pts: roundedRectPoints(800, 500, 350, 80, 200),
    },
    {
      id: 1, name: 'Transport Twister', halfWidth: 80,
      desc: 'A flowing ring broken up by two nasty chicanes.',
      pts: chaikin([
        [1080, 850], [1230, 850],                    // start / finish straight
        [1400, 760], [1465, 560], [1440, 360],       // right sweep
        [1300, 190], [1050, 160],                    // top-right
        [900, 255], [760, 255],                      // top chicane (kinks inward)
        [640, 160], [350, 160],                      // top-left
        [195, 300], [150, 520], [210, 720],          // left sweep
        [350, 850], [600, 850],                      // bottom run
        [700, 745], [830, 745],                      // bottom chicane
        [930, 850],
      ], 3),
    },
    {
      id: 2, name: 'Prod Speedway', halfWidth: 85,
      desc: 'A flat-out tri-oval. Three corners, zero excuses.',
      pts: chaikin([
        [700, 870], [1150, 870],                     // start / finish straight
        [1330, 830], [1440, 700], [1420, 540],       // turn 1
        [1180, 330], [940, 190],                     // back diagonal
        [790, 150], [640, 190],                      // top vertex
        [400, 330], [180, 540],                      // front diagonal
        [160, 700], [270, 830], [450, 870],          // final corner
      ], 3),
    },
    {
      id: 3, name: 'Sandbox Scramble', halfWidth: 88,
      desc: 'A wobbly loop with three sweeping esses.',
      pts: parametricPoints(800, 500, 520, 300, (t) => 1 + 0.12 * Math.cos(3 * t + 0.6), 90, Math.PI / 2),
    },
    {
      id: 4, name: 'Hotfix Hairpin', halfWidth: 75,
      desc: 'Sweepers, then a deep hairpin. Brake or backout.',
      logo: { x: 430, y: 545, w: 330 },
      pts: chaikin([
        [700, 860], [1150, 860],                     // start / finish straight
        [1420, 760], [1465, 540], [1420, 300],       // right sweep
        [1250, 165], [1090, 190],                    // top-right corner
        [1030, 300], [1005, 430],                    // dive toward the hairpin
        [930, 525], [810, 525],                      // hairpin bottom
        [735, 430], [715, 300],                      // climb back out
        [655, 180], [380, 160],                      // top run
        [185, 290], [148, 530], [215, 745],          // left sweep
        [420, 860],
      ], 3),
    },
    {
      id: 5, name: 'Integration Esses', halfWidth: 72,
      desc: 'A snaking weave of esses across the whole top half.',
      logo: { x: 800, y: 610, w: 420 },
      pts: chaikin([
        [700, 865], [1150, 865],                     // start / finish straight
        [1400, 790], [1465, 580], [1425, 350],       // right sweep
        [1290, 190], [1150, 195],                    // into the weave
        [1050, 315], [950, 340],                     // ess 1 (down)
        [850, 220], [750, 195],                      // ess 2 (up)
        [650, 315], [550, 340],                      // ess 3 (down)
        [450, 220], [360, 195],                      // ess 4 (up)
        [195, 300], [150, 520], [215, 740],          // left sweep
        [400, 860],
      ], 3),
    },
    {
      id: 6, name: 'Double Downtime', halfWidth: 70,
      desc: 'Two deep hairpin fingers — one down, one up. Unplanned.',
      logo: { x: 1200, y: 620, w: 270 },
      pts: chaikin([
        [900, 860], [1180, 860],                     // start / finish straight
        [1420, 780], [1468, 560], [1430, 330],       // right sweep
        [1270, 170], [1085, 195],                    // top-right corner
        [1030, 320], [1005, 440],                    // finger 1: dive down
        [925, 525], [815, 525],                      // finger 1: U-turn
        [745, 435], [725, 305],                      // finger 1: climb out
        [655, 180], [400, 165],                      // top run
        [205, 290], [152, 520], [225, 735],          // left sweep
        [345, 845],                                  // bottom-left exit
        [420, 745], [445, 625],                      // finger 2: climb up
        [520, 545], [625, 560],                      // finger 2: U-turn
        [685, 655], [695, 765],                      // finger 2: dive back
        [780, 855],                                  // rejoin the straight
      ], 3),
    },
    {
      id: 7, name: 'Audit Trail', halfWidth: 74,
      desc: 'A staircase of switchbacks. Every corner gets reviewed.',
      logo: { x: 640, y: 530, w: 400 },
      pts: chaikin([
        [600, 862], [1150, 862],                     // start / finish straight
        [1385, 830], [1452, 705],                    // turn 1
        [1448, 540], [1335, 475],                    // step 1: jink left
        [1205, 465], [1148, 370],                    // step 2: climb
        [1135, 262], [1020, 205],                    // step 3: jink left again
        [880, 195], [400, 170],                      // top run
        [205, 295], [152, 520], [222, 742],          // left sweep
        [400, 858],
      ], 3),
    },
  ];

  const MAPS = defs.map((d) => {
    const path = buildPath(d.pts);
    let logo = d.logo;
    if (!logo) {
      const cx = d.pts.reduce((s, p) => s + p[0], 0) / d.pts.length;
      const cy = d.pts.reduce((s, p) => s + p[1], 0) / d.pts.length;
      logo = { x: cx, y: cy, w: 440 };
    }
    return { ...d, path, logo, clearance: selfClearance(path, d.halfWidth).dist };
  });

  return { MAPS, pointAt, closest, selfClearance };
});
