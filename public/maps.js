/* Rev-Trac Racer — shared track definitions (used by server and client).
 *
 * A map is a closed centerline loop (points ordered in the direction of travel)
 * plus a track half-width. All geometry helpers work on arc-length fraction
 * u ∈ [0,1); u = 0 is the start/finish line.
 *
 * Hand-crafted circuits are authored as coarse control points and smoothed with
 * Chaikin subdivision. Track furniture (item rows, boost pads, oil) is placed
 * deterministically at load, so server and client always agree.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTMaps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const WORLD = { w: 1600, h: 1000 };
  const ITEM_ROW_FRACS = [0.12, 0.28, 0.45, 0.62, 0.78, 0.92];

  // ---- small shared helpers ------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const wrap01 = (u) => ((u % 1) + 1) % 1;
  // signed shortest difference a - b on the loop, in [-0.5, 0.5]
  const uDiff = (a, b) => { const d = a - b; return d - Math.round(d); };
  const angNorm = (a) => {
    while (a > Math.PI) a -= TAU;
    while (a < -Math.PI) a += TAU;
    return a;
  };

  // ---- point generators ----------------------------------------------------
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

  // Radially-modulated ellipse; t decreases so travel is +x along the bottom.
  function parametricPoints(cx, cy, rx, ry, modFn, n, t0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = t0 - (i / n) * TAU;
      const m = modFn(t);
      pts.push([cx + Math.cos(t) * rx * m, cy + Math.sin(t) * ry * m]);
    }
    return pts;
  }

  // Figure-8 (lemniscate of Gerono): crosses itself at (cx, cy).
  function figure8Points(cx, cy, a, b, n, t0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = t0 + (i / n) * TAU;
      pts.push([cx + a * Math.cos(t), cy + b * Math.sin(2 * t)]);
    }
    return pts;
  }

  // ---- path geometry -------------------------------------------------------
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
    u = wrap01(u);
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

  // Projection of (x, y) onto segment i. lat is the signed offset along the
  // left-hand normal (-ty, tx) — the same normal used to place track furniture.
  function projectOnSeg(path, i, x, y, best) {
    const [x1, y1] = path.pts[i];
    const [x2, y2] = path.pts[(i + 1) % path.n];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - x1) * dx + (y - y1) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x1 + dx * t, py = y1 + dy * t;
    const ex = x - px, ey = y - py;
    const d = Math.hypot(ex, ey);
    if (d < best.dist) {
      const len = Math.sqrt(len2);
      best.dist = d;
      best.u = (path.cum[i] + len * t) / path.total;
      best.lat = (ex * -dy + ey * dx) / len;
    }
  }

  // Closest point anywhere on the loop.
  function closest(path, x, y) {
    const best = { dist: Infinity, u: 0, lat: 0 };
    for (let i = 0; i < path.n; i++) projectOnSeg(path, i, x, y, best);
    return best;
  }

  // Closest point restricted to ±win (fraction of a lap) around uHint. Keeps
  // progress continuous where the track crosses or runs close to itself.
  function closestNear(path, x, y, uHint, win) {
    const best = { dist: Infinity, u: uHint, lat: 0 };
    for (let i = 0; i < path.n; i++) {
      const mid = (path.cum[i] + path.cum[i + 1]) / 2 / path.total;
      if (Math.abs(uDiff(mid, uHint)) > win) continue;
      projectOnSeg(path, i, x, y, best);
    }
    return best;
  }

  // ---- deterministic track furniture --------------------------------------
  function heading(path, u) {
    const p = pointAt(path, u);
    return Math.atan2(p.ty, p.tx);
  }
  // How much the track turns across ±span px around u (0 = dead straight).
  function bend(path, u, span) {
    const d = span / path.total;
    return Math.abs(angNorm(heading(path, u + d) - heading(path, u - d)));
  }

  function placeItemBoxes(path, hw) {
    const boxes = [];
    const lat = hw - 35;
    let id = 0;
    for (const f of ITEM_ROW_FRACS) {
      const pt = pointAt(path, f);
      for (const off of [-lat, 0, lat]) {
        boxes.push({ id: id++, x: pt.x - pt.ty * off, y: pt.y + pt.tx * off });
      }
    }
    return boxes;
  }

  // Boost pads go on the straightest stretches, away from the grid and item rows.
  function placeBoostPads(path, count) {
    const cands = [];
    for (let k = 0; k < 240; k++) {
      const u = k / 240;
      if (Math.abs(uDiff(u, 0)) < 0.05) continue;
      if (ITEM_ROW_FRACS.some((f) => Math.abs(uDiff(u, f)) * path.total < 120)) continue;
      cands.push({ u, b: bend(path, u, 150) });
    }
    cands.sort((a, b) => a.b - b.b);
    const out = [];
    for (const c of cands) {
      if (out.length >= count) break;
      if (out.every((o) => Math.abs(uDiff(o.u, c.u)) > 0.13)) out.push(c);
    }
    return out.map((c) => {
      const p = pointAt(path, c.u);
      return { u: c.u, x: p.x, y: p.y, angle: Math.atan2(p.ty, p.tx) };
    });
  }

  function placeOil(path, hw, count, rng, pads) {
    const out = [];
    for (let tries = 0; tries < 200 && out.length < count; tries++) {
      const u = 0.08 + rng() * 0.86;
      const lat = (rng() * 2 - 1) * (hw - 32);
      if (ITEM_ROW_FRACS.some((f) => Math.abs(uDiff(u, f)) * path.total < 110)) continue;
      if (pads.some((p) => Math.abs(uDiff(u, p.u)) * path.total < 130)) continue;
      if (out.some((o) => Math.abs(uDiff(u, o.u)) < 0.08)) continue;
      const pt = pointAt(path, u);
      out.push({ u, lat, x: pt.x - pt.ty * lat, y: pt.y + pt.tx * lat, r: 22 + rng() * 7 });
    }
    return out;
  }

  // ---- themes (visual only; read by the client renderer) -------------------
  const THEMES = {
    meadow:     { ground: '#3d9442', ground2: '#378a3c', track: '#3d424d', kerbA: '#d63a44', kerbB: '#f4f5f7', scenery: ['tree', 'tree', 'bush', 'tyres', 'tree'] },
    desert:     { ground: '#d9b46c', ground2: '#cfa85f', track: '#4c4741', kerbA: '#e07a1f', kerbB: '#f6ead2', scenery: ['cactus', 'rock', 'cactus', 'bush'] },
    night:      { ground: '#151b30', ground2: '#111629', track: '#2b3046', kerbA: '#ff3d81', kerbB: '#22d3ee', scenery: ['building', 'building', 'lamp'], dark: true },
    beach:      { ground: '#ecd9a0', ground2: '#e3cd90', track: '#4a4d55', kerbA: '#1e88e5', kerbB: '#ffffff', scenery: ['palm', 'umbrella', 'palm', 'rock'] },
    lava:       { ground: '#3a2626', ground2: '#312020', track: '#2e2e36', kerbA: '#ff7a00', kerbB: '#ffd60a', scenery: ['lavapool', 'rock', 'rock', 'deadtree'], dark: true },
    snow:       { ground: '#e9f2f9', ground2: '#dce8f2', track: '#566070', kerbA: '#2d6fd6', kerbB: '#ffffff', scenery: ['pine', 'pine', 'snowman', 'rock'] },
    datacenter: { ground: '#222933', ground2: '#1c222b', track: '#3a4252', kerbA: '#57cc3f', kerbB: '#141920', scenery: ['rack', 'rack', 'crate'], dark: true, grid: true },
    autumn:     { ground: '#8f7a3a', ground2: '#857034', track: '#403c3a', kerbA: '#b3541e', kerbB: '#f1e3c6', scenery: ['treeOrange', 'treeRed', 'bush', 'treeYellow'] },
    void:       { ground: '#1a1030', ground2: '#150c27', track: '#2c2542', kerbA: '#b14dff', kerbB: '#22d3ee', scenery: ['crystal', 'crystal', 'star'], dark: true },
  };

  // ---- track roster --------------------------------------------------------
  const defs = [
    {
      id: 0, name: 'Go-Live GP', theme: 'meadow', stars: 1, halfWidth: 90, pads: 2, oil: 1,
      desc: 'The classic circuit. Balanced corners, honest racing.',
      pts: roundedRectPoints(800, 500, 350, 80, 200),
    },
    {
      id: 1, name: 'Transport Twister', theme: 'desert', stars: 2, halfWidth: 80, pads: 2, oil: 2,
      desc: 'A flowing ring broken up by two nasty chicanes.',
      pts: chaikin([
        [1080, 850], [1230, 850],
        [1400, 760], [1465, 560], [1440, 360],
        [1300, 190], [1050, 160],
        [900, 255], [760, 255],
        [640, 160], [350, 160],
        [195, 300], [150, 520], [210, 720],
        [350, 850], [600, 850],
        [700, 745], [830, 745],
        [930, 850],
      ], 3),
    },
    {
      id: 2, name: 'Prod Speedway', theme: 'night', stars: 1, halfWidth: 85, pads: 3, oil: 1,
      desc: 'A flat-out neon tri-oval. Three corners, zero excuses.',
      pts: chaikin([
        [700, 870], [1150, 870],
        [1330, 830], [1440, 700], [1420, 540],
        [1180, 330], [940, 190],
        [790, 150], [640, 190],
        [400, 330], [180, 540],
        [160, 700], [270, 830], [450, 870],
      ], 3),
    },
    {
      id: 3, name: 'Sandbox Scramble', theme: 'beach', stars: 2, halfWidth: 88, pads: 2, oil: 2,
      desc: 'A wobbly beach loop with three sweeping esses.',
      pts: parametricPoints(800, 500, 520, 300, (t) => 1 + 0.12 * Math.cos(3 * t + 0.6), 90, Math.PI / 2),
    },
    {
      id: 4, name: 'Hotfix Hairpin', theme: 'lava', stars: 3, halfWidth: 75, pads: 2, oil: 2,
      desc: 'Sweepers, then a deep hairpin. Brake or backout.',
      logo: { x: 430, y: 545, w: 330 },
      pts: chaikin([
        [700, 860], [1150, 860],
        [1420, 760], [1465, 540], [1420, 300],
        [1250, 165], [1090, 190],
        [1030, 300], [1005, 430],
        [930, 525], [810, 525],
        [735, 430], [715, 300],
        [655, 180], [380, 160],
        [185, 290], [148, 530], [215, 745],
        [420, 860],
      ], 3),
    },
    {
      id: 5, name: 'Integration Esses', theme: 'snow', stars: 4, halfWidth: 72, pads: 2, oil: 1,
      desc: 'A snaking weave across the top — with black ice.',
      logo: { x: 800, y: 610, w: 420 },
      ice: [[0.47, 0.55], [0.63, 0.69]],
      pts: chaikin([
        [700, 865], [1150, 865],
        [1400, 790], [1465, 580], [1425, 350],
        [1290, 190], [1150, 195],
        [1050, 315], [950, 340],
        [850, 220], [750, 195],
        [650, 315], [550, 340],
        [450, 220], [360, 195],
        [195, 300], [150, 520], [215, 740],
        [400, 860],
      ], 3),
    },
    {
      id: 6, name: 'Double Downtime', theme: 'datacenter', stars: 5, halfWidth: 70, pads: 2, oil: 2,
      desc: 'Two deep hairpin fingers — one down, one up. Unplanned.',
      logo: { x: 1200, y: 620, w: 270 },
      pts: chaikin([
        [900, 860], [1180, 860],
        [1420, 780], [1468, 560], [1430, 330],
        [1270, 170], [1085, 195],
        [1030, 320], [1005, 440],
        [925, 525], [815, 525],
        [745, 435], [725, 305],
        [655, 180], [400, 165],
        [205, 290], [152, 520], [225, 735],
        [345, 845],
        [420, 745], [445, 625],
        [520, 545], [625, 560],
        [685, 655], [695, 765],
        [780, 855],
      ], 3),
    },
    {
      id: 7, name: 'Audit Trail', theme: 'autumn', stars: 3, halfWidth: 74, pads: 2, oil: 2,
      desc: 'A staircase of switchbacks. Every corner gets reviewed.',
      logo: { x: 640, y: 530, w: 400 },
      pts: chaikin([
        [600, 862], [1150, 862],
        [1385, 830], [1452, 705],
        [1448, 540], [1335, 475],
        [1205, 465], [1148, 370],
        [1135, 262], [1020, 205],
        [880, 195], [400, 170],
        [205, 295], [152, 520], [222, 742],
        [400, 858],
      ], 3),
    },
    {
      id: 8, name: 'Merge Conflict', theme: 'void', stars: 5, halfWidth: 74, pads: 2, oil: 1,
      desc: 'A figure-8 with a live crossing. Resolve it at 400 km/h.',
      logo: { x: 428, y: 500, w: 225 },
      crossing: { x: 800, y: 500 },
      pts: figure8Points(800, 500, 600, 300, 128, Math.PI * 0.3),
    },
  ];

  const MAPS = defs.map((d) => {
    const path = buildPath(d.pts);
    const rng = mulberry32(1000 + d.id * 7919);
    let logo = d.logo;
    if (!logo) {
      const cx = d.pts.reduce((s, p) => s + p[0], 0) / d.pts.length;
      const cy = d.pts.reduce((s, p) => s + p[1], 0) / d.pts.length;
      logo = { x: cx, y: cy, w: 440 };
    }
    const boostPads = placeBoostPads(path, d.pads || 0);
    return {
      ...d,
      path,
      logo,
      ice: d.ice || [],
      itemBoxes: placeItemBoxes(path, d.halfWidth),
      boostPads,
      oil: placeOil(path, d.halfWidth, d.oil || 0, rng, boostPads),
    };
  });

  return { MAPS, THEMES, WORLD, pointAt, closest, closestNear, bend, mulberry32, wrap01, uDiff, angNorm };
});
