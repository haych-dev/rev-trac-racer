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
    // corner. A stand is accepted only where its centre, all four corners, AND
    // all four edge midpoints clear the decorated corridor — a track approaching
    // an edge dead-on can pass at the corners while still crossing the edge
    // itself — so some land in the infield — which is where real circuits put them.
    const need = map.halfWidth + runoffFor(map) + STAND_CLEAR;
    function standFits(x, y) {
      if (x - STAND_W / 2 < WORLD_INSET || x + STAND_W / 2 > WORLD_W - WORLD_INSET) return false;
      if (y - STAND_H / 2 < WORLD_INSET || y + STAND_H / 2 > WORLD_H - WORLD_INSET) return false;
      const corners = [
        [x, y],
        [x - STAND_W / 2, y - STAND_H / 2], [x + STAND_W / 2, y - STAND_H / 2],
        [x - STAND_W / 2, y + STAND_H / 2], [x + STAND_W / 2, y + STAND_H / 2],
        [x, y - STAND_H / 2], [x, y + STAND_H / 2],
        [x - STAND_W / 2, y], [x + STAND_W / 2, y],
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
    // save/restore so lineJoin/lineCap/lineWidth/strokeStyle/dash don't escape
    // into whatever paints next -- paintStartLine here, but also the caller's
    // own context on the uncached (logo-not-yet-settled) path in game.js.
    ctx.save();
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
    ctx.restore();
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
    ctx.save();
    ctx.font = '800 26px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(map.name.toUpperCase(), lg.x, lg.y + (lg.w * LOGO_ASPECT) / 2 + 46);
    ctx.restore();
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

  return {
    PALETTE, runoffFor, furnitureFor, sceneryFor,
    paintTrack, paintPreview,
    KERB, KERB_DASH, RUNOFF_MAX, RUNOFF_MIN,
    WORLD_W, WORLD_H, WORLD_INSET, FURNITURE_GAP, FURNITURE_TOL,
    START_U_LO, START_U_HI,
    STAND_W, STAND_H, STAND_CLEAR, CAR_FLOOR, TREE_FLOOR,
  };
});
