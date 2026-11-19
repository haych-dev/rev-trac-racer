/* Rev-Trac Racer — canvas renderer.
 * The world (RTMaps.WORLD) is always fitted whole to the screen, so the
 * entire track is visible. Everything static about a track (ground,
 * scenery, asphalt, pads, logo) is painted once into an offscreen layer;
 * skid marks accumulate in a second layer; cars, effects and overlays are
 * drawn fresh each frame. */
(() => {
  'use strict';
  const RT = (window.RT = window.RT || {});
  const { THEMES, WORLD, pointAt, closest, mulberry32 } = RTMaps;
  const F = RTItems.FLAGS;
  const W = WORLD.w, H = WORLD.h;
  // The whole world is always fitted to the screen, so the bigger the world,
  // the smaller a world unit is drawn. UI holds labels, markers and pop-up
  // text at a constant size on screen; cars and track furniture are physical
  // objects and are left at their true size.
  const UI = W / 1600;
  const TAU = Math.PI * 2;
  const BRAND_RED = '#ef4d57';
  const NAVY = '#1e396b';
  const FONT = '"Segoe UI", system-ui, sans-serif';

  let canvas = null, ctx = null, k = 1;
  const staticCv = document.createElement('canvas');
  const skidCv = document.createElement('canvas');
  const skidCtx = skidCv.getContext('2d');
  const lightCv = document.createElement('canvas');
  lightCv.width = W / 2; lightCv.height = H / 2;
  const lightCtx = lightCv.getContext('2d');

  let curMap = null;
  let staticDirty = true;
  const logoImg = new Image();
  logoImg.onload = () => { staticDirty = true; };
  logoImg.src = 'revtrac-logo.svg';

  const particles = [];
  const texts = [];
  let shake = 0;
  const wheelPrev = new Map(); // car index -> rear wheel positions last frame
  const carScale = new Map();  // car index -> smoothed draw scale (giant mode)
  const pathCache = new Map();
  const sceneryCache = new Map();

  // ---- shape helpers -------------------------------------------------------
  function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function poly(c, pts) {
    c.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? c.moveTo(x, y) : c.lineTo(x, y)));
    c.closePath();
  }
  function disc(c, x, y, r, col) {
    c.fillStyle = col;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
  }
  function shadow(c, r) {
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.beginPath();
    c.ellipse(r * 0.28, r * 0.34, r, r * 0.86, 0, 0, TAU);
    c.fill();
  }
  // Rev-Trac brand chevrons: three thick round-capped arrows, staggered,
  // scaling and fading up toward the leading one.
  function chevrons(c, h, color, alphas) {
    const scales = [0.86, 0.93, 1];
    const gap = h * 0.3;
    c.save();
    c.strokeStyle = color;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (let i = 0; i < 3; i++) {
      const hh = h * scales[i], w = hh * 0.5, cx = (i - 1) * gap;
      c.globalAlpha = alphas[i];
      c.lineWidth = hh * 0.24;
      c.beginPath();
      c.moveTo(cx - w / 2, -hh / 2);
      c.lineTo(cx + w / 2, 0);
      c.lineTo(cx - w / 2, hh / 2);
      c.stroke();
    }
    c.restore();
  }

  // ---- car bodies ----------------------------------------------------------
  // Drawn centered on the origin pointing +x, roughly 48x26 units.
  const TIRE = '#16181d';
  const GLASS = 'rgba(15,18,28,0.85)';
  const SHADE = 'rgba(0,0,0,0.3)';
  const ACCENT = 'rgba(255,255,255,0.55)';

  function drawCarBody(c, car) {
    const col = car.color;
    c.save();
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 2;
    switch (car.body) {
      case 'formula':
        c.fillStyle = TIRE;
        c.fillRect(7, -13.5, 8, 5); c.fillRect(7, 8.5, 8, 5);
        c.fillRect(-17, -14, 9, 5.5); c.fillRect(-17, 8.5, 9, 5.5);
        c.fillStyle = col;
        rr(c, -23, -12, 4.5, 24, 1.5); c.fill(); c.stroke();
        rr(c, 19.5, -11, 4, 22, 1.5); c.fill(); c.stroke();
        rr(c, -17, -5.5, 34, 11, 5); c.fill(); c.stroke();
        poly(c, [[15, -4.5], [23, 0], [15, 4.5]]); c.fill(); c.stroke();
        disc(c, -3, 0, 4, GLASS);
        c.fillStyle = ACCENT; c.fillRect(9, -1.5, 7, 3);
        break;
      case 'muscle':
        c.fillStyle = '#22262e';
        rr(c, -23, -12, 4, 24, 1.5); c.fill(); c.stroke();
        c.fillStyle = col;
        rr(c, -21, -11, 42, 22, 6); c.fill(); c.stroke();
        c.fillStyle = GLASS; rr(c, -7, -8, 16, 16, 4); c.fill();
        c.fillStyle = SHADE; rr(c, 9, -3.5, 8, 7, 2); c.fill();
        c.fillStyle = ACCENT; c.fillRect(10, -6.5, 10, 3); c.fillRect(10, 3.5, 10, 3);
        break;
      case 'van':
        c.fillStyle = col;
        rr(c, -22, -12, 44, 24, 5); c.fill(); c.stroke();
        c.fillStyle = SHADE; rr(c, -17, -8.5, 23, 17, 3); c.fill();
        c.fillStyle = GLASS; rr(c, 10, -9.5, 6.5, 19, 2); c.fill();
        c.fillStyle = ACCENT; c.fillRect(19.5, -7, 2.5, 14);
        break;
      case 'kart':
        c.fillStyle = TIRE;
        c.fillRect(6, -11.5, 7, 4.5); c.fillRect(6, 7, 7, 4.5);
        c.fillRect(-13, -11.5, 7, 4.5); c.fillRect(-13, 7, 7, 4.5);
        c.fillStyle = col;
        rr(c, -13, -7, 27, 14, 4); c.fill(); c.stroke();
        c.fillStyle = SHADE; c.fillRect(10, -6, 3, 12);
        disc(c, -2, 0, 4.5, GLASS);
        disc(c, -2, 0, 2.6, '#dfe3ea');
        break;
      case 'ute':
        c.fillStyle = col;
        rr(c, -21, -10.5, 21, 21, 3); c.fill(); c.stroke();
        c.fillStyle = SHADE; rr(c, -19, -8.5, 17, 17, 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.2)';
        c.fillRect(-16, -8.5, 2, 17); c.fillRect(-9, -8.5, 2, 17);
        c.fillStyle = col;
        rr(c, 0, -11, 22, 22, 4); c.fill(); c.stroke();
        c.fillStyle = GLASS; rr(c, 2.5, -8, 5.5, 16, 2); c.fill();
        break;
      case 'roadster':
        c.fillStyle = '#22262e';
        rr(c, -23, -7, 3.5, 14, 1.5); c.fill(); c.stroke();
        c.fillStyle = col;
        c.beginPath(); c.ellipse(0, 0, 21, 10.5, 0, 0, TAU); c.fill(); c.stroke();
        c.fillStyle = GLASS;
        c.beginPath(); c.ellipse(-4, 0, 6.5, 5.5, 0, 0, TAU); c.fill();
        c.fillStyle = ACCENT; rr(c, 3.5, -7, 3, 14, 1.5); c.fill();
        break;
      case 'beetle':
        c.fillStyle = col;
        c.beginPath(); c.ellipse(0, 0, 18.5, 12, 0, 0, TAU); c.fill(); c.stroke();
        c.fillStyle = SHADE;
        c.beginPath(); c.ellipse(-1.5, 0, 10.5, 8.5, 0, 0, TAU); c.fill();
        c.fillStyle = GLASS; rr(c, 7, -6.5, 3, 13, 1.5); c.fill();
        disc(c, 16, -5.5, 1.8, ACCENT); disc(c, 16, 5.5, 1.8, ACCENT);
        break;
      case 'wedge':
      default:
        c.fillStyle = '#22262e';
        rr(c, -24, -12, 3.5, 24, 1.5); c.fill(); c.stroke();
        c.fillStyle = col;
        poly(c, [[24, 0], [12, -10], [-16, -11], [-21, -6], [-21, 6], [-16, 11], [12, 10]]);
        c.fill(); c.stroke();
        c.fillStyle = GLASS; rr(c, -6, -5.5, 12, 11, 3); c.fill();
        c.fillStyle = ACCENT; c.fillRect(10, -1.5, 9, 3);
        break;
    }
    c.restore();
  }

  // ---- scenery -------------------------------------------------------------
  function treeLike(c, o, dark, mid, light) {
    const r = 17 * o.s;
    shadow(c, r);
    disc(c, 0, 0, r, dark);
    disc(c, -r * 0.18, -r * 0.2, r * 0.68, mid);
    disc(c, -r * 0.32, -r * 0.36, r * 0.3, light);
  }
  const SCENERY = {
    tree: (c, o) => treeLike(c, o, '#2a6b2e', '#3f9443', '#62bd66'),
    treeOrange: (c, o) => treeLike(c, o, '#a34c18', '#d9742a', '#f2a55a'),
    treeRed: (c, o) => treeLike(c, o, '#86281c', '#c0402c', '#e3745a'),
    treeYellow: (c, o) => treeLike(c, o, '#9a7712', '#d9ad2b', '#f4d566'),
    bush(c, o) {
      const r = 8 * o.s;
      shadow(c, r * 1.5);
      disc(c, -r * 0.7, 0, r, '#2f7a34'); disc(c, r * 0.7, r * 0.2, r, '#37873c'); disc(c, 0, -r * 0.5, r, '#48a04e');
    },
    tyres(c, o) {
      for (const [x, y] of [[-9, 4], [9, 4], [0, -9]]) {
        disc(c, x * o.s + 2, y * o.s + 3, 9 * o.s, 'rgba(0,0,0,0.25)');
        disc(c, x * o.s, y * o.s, 9 * o.s, '#17191e');
        disc(c, x * o.s, y * o.s, 4.5 * o.s, '#4b505b');
        disc(c, x * o.s, y * o.s, 2.5 * o.s, '#17191e');
      }
    },
    cactus(c, o) {
      const r = 11 * o.s;
      shadow(c, r * 1.2);
      disc(c, -r * 1.05, r * 0.2, r * 0.48, '#3a7436'); disc(c, r * 1.0, -r * 0.3, r * 0.44, '#3a7436');
      disc(c, 0, 0, r, '#3f7d3a'); disc(c, -r * 0.2, -r * 0.2, r * 0.6, '#5aa052');
      disc(c, r * 0.2, -r * 0.3, r * 0.2, '#ff8fb1');
    },
    rock(c, o) {
      const rng = mulberry32(Math.floor(o.r * 1e6));
      const pts = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU, rad = (10 + rng() * 7) * o.s;
        pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
      }
      c.save(); c.translate(3, 4); c.fillStyle = 'rgba(0,0,0,0.22)'; poly(c, pts); c.fill(); c.restore();
      c.fillStyle = '#7d8088'; poly(c, pts); c.fill();
      c.fillStyle = '#a3a6ae'; poly(c, pts.map(([x, y]) => [x * 0.55 - 2, y * 0.55 - 2])); c.fill();
    },
    building(c, o) {
      const rng = mulberry32(Math.floor(o.r * 1e6));
      const w = 50 * o.s, h = 36 * o.s;
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(-w / 2 + 5, -h / 2 + 6, w, h);
      c.fillStyle = '#1b2240'; c.fillRect(-w / 2, -h / 2, w, h);
      c.strokeStyle = o.r > 0.5 ? '#ff3d81' : '#22d3ee'; c.lineWidth = 2; c.strokeRect(-w / 2, -h / 2, w, h);
      for (let iy = 0; iy < 3; iy++) for (let ix = 0; ix < 5; ix++) {
        if (rng() < 0.4) continue;
        c.fillStyle = rng() < 0.5 ? 'rgba(255,220,120,0.9)' : 'rgba(120,220,255,0.85)';
        c.fillRect(-w / 2 + 6 + ix * (w - 12) / 5, -h / 2 + 6 + iy * (h - 10) / 3, 4, 4);
      }
    },
    lamp(c) {
      const g = c.createRadialGradient(0, 0, 2, 0, 0, 52);
      g.addColorStop(0, 'rgba(255,225,140,0.42)'); g.addColorStop(1, 'rgba(255,225,140,0)');
      c.fillStyle = g; c.beginPath(); c.arc(0, 0, 52, 0, TAU); c.fill();
      disc(c, 0, 0, 3.5, '#ffe9a8');
    },
    palm(c, o) {
      shadow(c, 16 * o.s);
      for (let i = 0; i < 7; i++) {
        c.save(); c.rotate((i / 7) * TAU + o.r * TAU);
        c.fillStyle = i % 2 ? '#2f8040' : '#3c9a4a';
        c.beginPath(); c.ellipse(11 * o.s, 0, 11 * o.s, 3.6 * o.s, 0, 0, TAU); c.fill();
        c.restore();
      }
      disc(c, 0, 0, 4 * o.s, '#7a5230');
    },
    umbrella(c, o) {
      const r = 15 * o.s, colA = o.r > 0.5 ? '#ef4d57' : '#1e88e5';
      shadow(c, r);
      for (let i = 0; i < 8; i++) {
        c.fillStyle = i % 2 ? '#ffffff' : colA;
        c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, r, (i / 8) * TAU, ((i + 1) / 8) * TAU); c.closePath(); c.fill();
      }
      disc(c, 0, 0, 2, '#333');
    },
    lavapool(c, o) {
      const r = 15 * o.s;
      const g = c.createRadialGradient(0, 0, 2, 0, 0, r * 2.4);
      g.addColorStop(0, 'rgba(255,120,0,0.4)'); g.addColorStop(1, 'rgba(255,120,0,0)');
      c.fillStyle = g; c.beginPath(); c.arc(0, 0, r * 2.4, 0, TAU); c.fill();
      disc(c, 0, 0, r * 1.12, '#1e1414');
      disc(c, 0, 0, r, '#ff6a00'); disc(c, r * 0.6, -r * 0.3, r * 0.62, '#ff6a00'); disc(c, -r * 0.5, r * 0.35, r * 0.6, '#ff6a00');
      disc(c, -r * 0.1, -r * 0.1, r * 0.5, '#ffb000'); disc(c, r * 0.4, -r * 0.2, r * 0.25, '#ffd60a');
    },
    deadtree(c, o) {
      c.strokeStyle = '#160f0f'; c.lineWidth = 2.5 * o.s; c.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + o.r * 3, len = (10 + ((i * 7) % 9)) * o.s;
        c.beginPath(); c.moveTo(0, 0); c.lineTo(Math.cos(a) * len, Math.sin(a) * len); c.stroke();
      }
      disc(c, 0, 0, 3 * o.s, '#160f0f');
    },
    pine(c, o) {
      const r = 16 * o.s;
      shadow(c, r);
      disc(c, 0, 0, r, '#1d5637'); disc(c, 0, 0, r * 0.7, '#2a7549'); disc(c, -r * 0.1, -r * 0.1, r * 0.4, '#f4f8fb');
    },
    snowman(c, o) {
      shadow(c, 12 * o.s);
      disc(c, 0, 2 * o.s, 11 * o.s, '#ffffff'); disc(c, -1 * o.s, -8 * o.s, 7 * o.s, '#ffffff');
      c.strokeStyle = 'rgba(120,150,180,0.5)'; c.lineWidth = 1;
      c.beginPath(); c.arc(0, 2 * o.s, 11 * o.s, 0, TAU); c.stroke();
      disc(c, 1 * o.s, -8 * o.s, 1.6 * o.s, '#ff8a1f');
    },
    rack(c, o) {
      const rng = mulberry32(Math.floor(o.r * 1e6));
      const w = 30 * o.s, h = 46 * o.s;
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(-w / 2 + 4, -h / 2 + 5, w, h);
      c.fillStyle = '#12161d'; c.fillRect(-w / 2, -h / 2, w, h);
      c.strokeStyle = '#303a49'; c.lineWidth = 1.5; c.strokeRect(-w / 2, -h / 2, w, h);
      for (let iy = 0; iy < 6; iy++) for (let ix = 0; ix < 3; ix++) {
        const v = rng();
        c.fillStyle = v < 0.6 ? '#57cc3f' : v < 0.85 ? '#ffb000' : '#39485c';
        c.fillRect(-w / 2 + 5 + ix * 7 * o.s, -h / 2 + 5 + iy * (h - 9) / 6, 3, 2.5);
      }
    },
    crate(c, o) {
      const s = 22 * o.s;
      c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(-s / 2 + 3, -s / 2 + 4, s, s);
      c.fillStyle = '#34435c'; c.fillRect(-s / 2, -s / 2, s, s);
      c.strokeStyle = '#4f6283'; c.lineWidth = 2; c.strokeRect(-s / 2, -s / 2, s, s);
      c.beginPath(); c.moveTo(-s / 2, -s / 2); c.lineTo(s / 2, s / 2); c.moveTo(s / 2, -s / 2); c.lineTo(-s / 2, s / 2); c.stroke();
    },
    crystal(c, o) {
      const col = o.r > 0.5 ? '177,77,255' : '34,211,238';
      const g = c.createRadialGradient(0, 0, 2, 0, 0, 40 * o.s);
      g.addColorStop(0, `rgba(${col},0.4)`); g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(0, 0, 40 * o.s, 0, TAU); c.fill();
      c.save(); c.rotate(o.r * TAU);
      c.fillStyle = `rgb(${col})`; poly(c, [[0, -17 * o.s], [9 * o.s, 0], [0, 17 * o.s], [-9 * o.s, 0]]); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.5)'; poly(c, [[0, -17 * o.s], [9 * o.s, 0], [0, 0]]); c.fill();
      c.restore();
    },
    star(c, o) {
      disc(c, 0, 0, 5 * o.s, 'rgba(255,255,255,0.12)'); disc(c, 0, 0, 1.8 * o.s, 'rgba(255,255,255,0.9)');
    },
  };

  function sceneryFor(map) {
    let items = sceneryCache.get(map.id);
    if (items) return items;
    items = [];
    const rng = mulberry32(555 + map.id * 31);
    const kinds = THEMES[map.theme].scenery;
    const lg = map.logo, lh = lg.w * 0.262;
    // density is per unit of area, so a bigger world gets proportionally more
    const want = Math.round(120 * UI * UI * 0.8);
    for (let tries = 0; tries < want * 12 && items.length < want; tries++) {
      const x = 26 + rng() * (W - 52), y = 26 + rng() * (H - 52);
      const s = (0.75 + rng() * 0.6) * (0.75 + UI * 0.25);
      const kind = kinds[Math.floor(rng() * kinds.length)];
      const r = rng();
      if (closest(map.path, x, y).dist < map.halfWidth + 48) continue;
      if (Math.abs(x - lg.x) < lg.w / 2 + 46 && Math.abs(y - lg.y) < lh / 2 + 62) continue;
      if (items.some((o) => Math.hypot(o.x - x, o.y - y) < 20 * (o.s + s) + 4)) continue;
      items.push({ x, y, s, kind, r });
    }
    sceneryCache.set(map.id, items);
    return items;
  }

  // ---- static layer --------------------------------------------------------
  function trackPath(map) {
    let p = pathCache.get(map.id);
    if (!p) {
      p = new Path2D();
      map.pts.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
      p.closePath();
      pathCache.set(map.id, p);
    }
    return p;
  }

  function drawGround(c, map, theme) {
    c.fillStyle = theme.ground;
    c.fillRect(0, 0, W, H);
    const rng = mulberry32(77 + map.id);
    if (theme.grid) {
      c.strokeStyle = theme.ground2; c.lineWidth = 2;
      c.beginPath();
      for (let x = 0; x <= W; x += 50) { c.moveTo(x, 0); c.lineTo(x, H); }
      for (let y = 0; y <= H; y += 50) { c.moveTo(0, y); c.lineTo(W, y); }
      c.stroke();
    } else if (theme.dark) {
      c.fillStyle = theme.ground2;
      for (let i = 0; i < 26 * UI * UI; i++) { c.beginPath(); c.arc(rng() * W, rng() * H, 40 + rng() * 90, 0, TAU); c.fill(); }
    } else {
      c.fillStyle = theme.ground2;
      for (let y = 0; y < H; y += 80) c.fillRect(0, y, W, 40);
    }
    c.fillStyle = theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    for (let i = 0; i < 520 * UI * UI; i++) c.fillRect(rng() * W, rng() * H, 2 + rng() * 3, 2 + rng() * 3);
  }

  function drawTrack(c, map, theme) {
    const path = trackPath(map), hw = map.halfWidth;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.lineWidth = hw * 2 + 28; c.strokeStyle = 'rgba(0,0,0,0.2)'; c.stroke(path);
    c.lineWidth = hw * 2 + 16; c.strokeStyle = theme.kerbA; c.stroke(path);
    c.setLineDash([26, 26]); c.strokeStyle = theme.kerbB; c.stroke(path); c.setLineDash([]);
    c.lineWidth = hw * 2; c.strokeStyle = theme.track; c.stroke(path);
    c.lineWidth = hw * 2 - 10; c.strokeStyle = 'rgba(255,255,255,0.5)'; c.stroke(path);
    c.lineWidth = hw * 2 - 16; c.strokeStyle = theme.track; c.stroke(path);
    c.lineWidth = 4; c.strokeStyle = 'rgba(255,255,255,0.28)';
    c.setLineDash([30, 34]); c.stroke(path); c.setLineDash([]);
  }

  function drawFurniture(c, map) {
    const hw = map.halfWidth, path = map.path;
    // black ice
    for (const [a, b] of map.ice) {
      c.beginPath();
      for (let u = a, first = true; u <= b + 0.0001; u += 0.004, first = false) {
        const p = pointAt(path, u);
        if (first) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.lineCap = 'butt'; c.lineJoin = 'round';
      c.lineWidth = hw * 2 - 16; c.strokeStyle = 'rgba(170,222,255,0.6)'; c.stroke();
      const rng = mulberry32(Math.floor(a * 1e5));
      c.strokeStyle = 'rgba(255,255,255,0.75)'; c.lineWidth = 2; c.lineCap = 'round';
      for (let i = 0; i < 26; i++) {
        const p = pointAt(path, a + rng() * (b - a));
        const lat = (rng() * 2 - 1) * (hw - 22);
        const x = p.x - p.ty * lat, y = p.y + p.tx * lat, len = 6 + rng() * 10;
        c.beginPath(); c.moveTo(x - len, y - len * 0.5); c.lineTo(x + len, y + len * 0.5); c.stroke();
      }
    }
    // chevron boost pads
    for (const pad of map.boostPads) {
      c.save();
      c.translate(pad.x, pad.y);
      c.rotate(pad.angle);
      const w = hw * 2 - 30;
      c.fillStyle = 'rgba(255,255,255,0.1)';
      rr(c, -36, -w / 2, 72, w, 8); c.fill();
      chevrons(c, Math.min(w * 0.46, 68), BRAND_RED, [0.4, 0.68, 1]);
      c.restore();
    }
    // oil
    for (const o of map.oil) {
      c.save();
      c.translate(o.x, o.y);
      c.fillStyle = 'rgba(8,8,12,0.84)';
      for (const [x, y, r] of [[0, 0, 1], [0.6, -0.3, 0.62], [-0.5, 0.4, 0.56], [0.2, 0.55, 0.4]]) {
        c.beginPath(); c.arc(x * o.r, y * o.r, r * o.r, 0, TAU); c.fill();
      }
      c.lineWidth = 2.5; c.lineCap = 'round';
      c.strokeStyle = 'rgba(150,100,255,0.55)'; c.beginPath(); c.arc(-o.r * 0.15, -o.r * 0.15, o.r * 0.5, 3.6, 5.2); c.stroke();
      c.strokeStyle = 'rgba(60,220,200,0.45)'; c.beginPath(); c.arc(-o.r * 0.1, -o.r * 0.1, o.r * 0.34, 3.7, 5.0); c.stroke();
      c.restore();
    }
    // start/finish line
    const st = pointAt(path, 0);
    const sq = 15;
    c.save();
    c.translate(st.x, st.y);
    c.rotate(Math.atan2(st.ty, st.tx));
    for (let row = 0; row < Math.ceil((hw * 2) / sq); row++) {
      for (let col = 0; col < 2; col++) {
        c.fillStyle = (row + col) % 2 === 0 ? '#fff' : '#111';
        c.fillRect((col - 2) * sq, -hw + row * sq, sq, Math.min(sq, hw * 2 - row * sq));
      }
    }
    c.restore();
    // grid slots (must match Race._makePlayer)
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 2.5; c.lineCap = 'butt';
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2), col = i % 2;
      const p = pointAt(path, 1 - (60 * (row + 1) + col * 24) / path.total);
      const lat = col === 0 ? -34 : 34;
      c.save();
      c.translate(p.x - p.ty * lat, p.y + p.tx * lat);
      c.rotate(Math.atan2(p.ty, p.tx));
      c.beginPath();
      c.moveTo(14, -15); c.lineTo(27, -15); c.lineTo(27, 15); c.lineTo(14, 15);
      c.stroke();
      c.restore();
    }
  }

  function drawLogo(c, map) {
    const lg = map.logo;
    const lh = lg.w * 0.262;
    if (logoImg.complete && logoImg.naturalWidth) {
      c.save();
      c.fillStyle = 'rgba(0,0,0,0.2)';
      rr(c, lg.x - lg.w / 2 - 14, lg.y - lh / 2 - 9, lg.w + 36, lh + 28, 14); c.fill();
      c.fillStyle = 'rgba(246,247,249,0.94)';
      rr(c, lg.x - lg.w / 2 - 18, lg.y - lh / 2 - 14, lg.w + 36, lh + 28, 14); c.fill();
      c.drawImage(logoImg, lg.x - lg.w / 2, lg.y - lh / 2, lg.w, lh);
      c.restore();
    }
    c.font = `800 ${Math.round(Math.min(26 * UI, lg.w * 0.075))}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 4 * UI;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.strokeText(map.name.toUpperCase(), lg.x, lg.y + lh / 2 + 40 * UI);
    c.fillText(map.name.toUpperCase(), lg.x, lg.y + lh / 2 + 40 * UI);
  }

  function buildStatic() {
    const map = curMap, theme = THEMES[map.theme];
    const c = staticCv.getContext('2d');
    c.setTransform(k, 0, 0, k, 0, 0);
    drawGround(c, map, theme);
    drawTrack(c, map, theme);
    drawFurniture(c, map);
    for (const o of sceneryFor(map)) {
      c.save();
      c.translate(o.x, o.y);
      SCENERY[o.kind](c, o);
      c.restore();
    }
    drawLogo(c, map);
    staticDirty = false;
  }

  // ---- particles & floating text -------------------------------------------
  function spawn(p) {
    if (particles.length < 800) particles.push(p);
  }
  const rnd = (a, b) => a + Math.random() * (b - a);

  function updateParticles(dt) {
    const s = dt / 1000;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }
      p.x += p.vx * s; p.y += p.vy * s;
      if (p.drag) { const d = Math.exp(-p.drag * s); p.vx *= d; p.vy *= d; }
      if (p.grow) p.size = Math.max(0.3, p.size + p.grow * s);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max) * (p.alpha === undefined ? 1 : p.alpha);
      if (p.shape === 'r') {
        ctx.strokeStyle = p.color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.stroke();
      } else if (p.shape === 's') {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else {
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawTexts(dt) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      t.life -= dt;
      if (t.life <= 0) { texts.splice(i, 1); continue; }
      const f = t.life / t.max;
      ctx.globalAlpha = Math.min(1, f * 2.5);
      ctx.font = `800 ${Math.round(t.size * UI)}px ${FONT}`;
      ctx.lineWidth = 4 * UI;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      const y = t.y - (1 - f) * 34 * UI;
      ctx.strokeText(t.str, t.x, y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.str, t.x, y);
    }
    ctx.globalAlpha = 1;
  }

  const fx = {
    shake(n) { shake = Math.max(shake, n); },
    text(x, y, str, color = '#fff', size = 17) {
      texts.push({ x, y, str, color, size, life: 1200, max: 1200 });
    },
    ring(x, y, color = '#fff') {
      spawn({ x, y, vx: 0, vy: 0, life: 380, max: 380, size: 10, grow: 170, color, shape: 'r' });
    },
    sparks(x, y, n = 12, color = '#ffd60a') {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = rnd(60, 260);
        spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(180, 420), max: 420, size: rnd(1.5, 3), color, drag: 4 });
      }
    },
    boom(x, y, big = false) {
      const n = big ? 64 : 34;
      const cols = ['#fff3b0', '#ffd60a', '#ff9a1f', '#ff5a1f', '#ff5a1f'];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = rnd(50, big ? 460 : 340);
        const life = rnd(300, 800);
        spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, size: rnd(3, big ? 10 : 7), grow: -5, color: cols[i % cols.length], drag: 3.2 });
      }
      for (let i = 0; i < (big ? 16 : 8); i++) {
        const a = Math.random() * TAU, sp = rnd(20, 90);
        spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 950, max: 950, size: rnd(7, 12), grow: 26, color: '#4a4a55', alpha: 0.5, drag: 1.5 });
      }
      fx.ring(x, y, '#ffd60a');
      fx.shake(big ? 17 : 9);
    },
    confetti(x, y) {
      const cols = [BRAND_RED, NAVY, '#ffd60a', '#57cc3f', '#22d3ee', '#ffffff'];
      for (let i = 0; i < 90; i++) {
        const a = Math.random() * TAU, sp = rnd(60, 420);
        const life = rnd(700, 1600);
        spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, size: rnd(4, 7), color: cols[i % cols.length], drag: 2.2, shape: 's' });
      }
    },
    puff(x, y, color = '#ffffff', n = 10) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = rnd(20, 110);
        spawn({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 520, max: 520, size: rnd(4, 7), grow: 16, color, alpha: 0.55, drag: 2.5 });
      }
    },
  };

  // per-car continuous effects
  function emitCarParticles(c, sc, dt, theme) {
    const count = (perSec) => {
      const n = (perSec * dt) / 1000;
      return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    };
    const cos = Math.cos(c.a), sin = Math.sin(c.a);
    const bx = c.x - cos * 20 * sc, by = c.y - sin * 20 * sc;
    if (c.f & F.BOOST) {
      const cols = ['#ffd60a', '#ff9a1f', '#ff5a1f'];
      for (let i = count(70); i > 0; i--) {
        spawn({ x: bx + rnd(-4, 4), y: by + rnd(-4, 4), vx: -cos * 130 + rnd(-45, 45), vy: -sin * 130 + rnd(-45, 45),
          life: 260, max: 260, size: 4.5 * sc, grow: -9, color: cols[(Math.random() * 3) | 0] });
      }
    }
    if (c.d >= 1) {
      for (let i = count(34); i > 0; i--) {
        spawn({ x: bx + rnd(-7, 7), y: by + rnd(-7, 7), vx: rnd(-22, 22), vy: rnd(-22, 22),
          life: 430, max: 430, size: 4, grow: 15, color: '#e6e6ea', alpha: 0.45 });
      }
      if (c.d >= 2) {
        const col = c.d >= 3 ? '#ff9a1f' : '#58c7ff';
        for (let i = count(46); i > 0; i--) {
          const a = Math.random() * TAU, sp = rnd(40, 140);
          spawn({ x: bx, y: by, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 230, max: 230, size: 2.3, color: col, drag: 3 });
        }
      }
    }
    if ((c.f & F.OFF) && c.v > 90 && !(c.f & F.FINISHED)) {
      const col = theme.dark ? '#8a8a96' : '#9a7a4a';
      for (let i = count(36); i > 0; i--) {
        spawn({ x: bx + rnd(-8, 8), y: by + rnd(-8, 8), vx: rnd(-30, 30), vy: rnd(-30, 30),
          life: 380, max: 380, size: 3.2, grow: 11, color: col, alpha: 0.5 });
      }
    }
    if (c.f & F.SPIN) {
      for (let i = count(40); i > 0; i--) {
        spawn({ x: c.x + rnd(-10, 10), y: c.y + rnd(-10, 10), vx: rnd(-40, 40), vy: rnd(-40, 40),
          life: 480, max: 480, size: 5, grow: 18, color: '#c9c9d2', alpha: 0.45 });
      }
    }
    if (c.f & F.AUTO) {
      for (let i = count(40); i > 0; i--) {
        spawn({ x: bx + rnd(-6, 6), y: by + rnd(-6, 6), vx: -cos * 60, vy: -sin * 60, life: 300, max: 300, size: 4, color: '#22d3ee', shape: 's' });
      }
    }
    if ((c.f & F.ICY) && c.v > 120) {
      for (let i = count(16); i > 0; i--) {
        spawn({ x: bx + rnd(-9, 9), y: by + rnd(-9, 9), vx: rnd(-25, 25), vy: rnd(-25, 25), life: 340, max: 340, size: 2, color: '#ffffff' });
      }
    }
  }

  function layDownSkids(c, sc) {
    const skidding = c.d >= 1 || (c.f & (F.SPIN | F.OIL)) || ((c.f & F.ICY) && c.v > 160);
    if (!skidding || (c.f & F.FINISHED)) { wheelPrev.delete(c.i); return; }
    const cos = Math.cos(c.a), sin = Math.sin(c.a);
    const pts = [[-13, -9], [-13, 9]].map(([lx, ly]) => [c.x + (lx * cos - ly * sin) * sc, c.y + (lx * sin + ly * cos) * sc]);
    const prev = wheelPrev.get(c.i);
    if (prev && Math.hypot(pts[0][0] - prev[0][0], pts[0][1] - prev[0][1]) < 60) {
      skidCtx.setTransform(k, 0, 0, k, 0, 0);
      skidCtx.strokeStyle = 'rgba(10,10,14,0.2)';
      skidCtx.lineWidth = 3.4 * sc;
      skidCtx.lineCap = 'round';
      for (let w = 0; w < 2; w++) {
        skidCtx.beginPath();
        skidCtx.moveTo(prev[w][0], prev[w][1]);
        skidCtx.lineTo(pts[w][0], pts[w][1]);
        skidCtx.stroke();
      }
    }
    wheelPrev.set(c.i, pts);
  }

  // ---- dynamic drawing -----------------------------------------------------
  function drawBoxes(view, now) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const b of view.map.itemBoxes) {
      ctx.save();
      ctx.translate(b.x, b.y);
      if (view.boxesOff.has(b.id)) {
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
        rr(ctx, -18, -18, 36, 36, 8); ctx.stroke();
      } else {
        const bob = 1 + Math.sin(now * 0.005 + b.id) * 0.07;
        ctx.scale(bob, bob);
        ctx.rotate(Math.sin(now * 0.002 + b.id * 1.3) * 0.13);
        disc(ctx, 0, 0, 31, 'rgba(255,214,10,0.2)');
        ctx.fillStyle = NAVY; ctx.strokeStyle = '#ffd60a'; ctx.lineWidth = 3;
        rr(ctx, -20, -20, 40, 40, 9); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffd60a';
        ctx.font = `900 29px ${FONT}`;
        ctx.fillText('?', 0, 2);
      }
      ctx.restore();
    }
  }

  function drawPadPulse(map, now) {
    const a = 0.1 + 0.1 * Math.sin(now * 0.008);
    for (const pad of map.boostPads) {
      ctx.save();
      ctx.translate(pad.x, pad.y);
      ctx.rotate(pad.angle);
      const w = map.halfWidth * 2 - 30;
      ctx.fillStyle = `rgba(239,77,87,${a})`;
      rr(ctx, -36, -w / 2, 72, w, 8); ctx.fill();
      ctx.restore();
    }
  }

  function drawHazards(view, now) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [id, x, y] of view.hazards) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(now * 0.006 + id) * 0.1);
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(ctx, -21, -13, 48, 34, 6); ctx.fill();
      ctx.fillStyle = '#f4a832'; ctx.strokeStyle = '#7a4e0c'; ctx.lineWidth = 3;
      rr(ctx, -24, -17, 48, 34, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3b2a05';
      ctx.font = `900 16px ${FONT}`;
      ctx.fillText('CAB', 0, 1);
      ctx.restore();
    }
  }

  function drawMissiles(view, dt) {
    for (const [, x, y, a] of view.missiles) {
      const cos = Math.cos(a), sin = Math.sin(a);
      for (let i = 0; i < 2; i++) {
        spawn({ x: x - cos * 14 + rnd(-3, 3), y: y - sin * 14 + rnd(-3, 3), vx: -cos * 80 + rnd(-30, 30), vy: -sin * 80 + rnd(-30, 30),
          life: 300, max: 300, size: 5, grow: 8, color: i ? '#ff9a1f' : '#d8d8de', alpha: 0.7 });
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.fillStyle = '#2b2f3a';
      poly(ctx, [[-14, -8], [-8, -4], [-8, 4], [-14, 8]]); ctx.fill();
      ctx.fillStyle = '#f1f3f5'; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
      rr(ctx, -12, -4.5, 22, 9, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = BRAND_RED;
      poly(ctx, [[8, -4.5], [17, 0], [8, 4.5]]); ctx.fill();
      ctx.restore();
    }
  }

  function drawCar(c, view, now, dt, theme) {
    if (c.f & F.OUT) { wheelPrev.delete(c.i); return; }
    const sc = carScale.get(c.i) || 1;
    const ghost = !!(c.f & F.FINISHED);
    emitCarParticles(c, sc, dt, theme);
    layDownSkids(c, sc);

    ctx.save();
    ctx.translate(c.x, c.y);
    if (ghost) ctx.globalAlpha = 0.5;
    if (c.me && !ghost) {
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -now * 0.03;
      ctx.beginPath(); ctx.arc(0, 0, 31 * sc, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.rotate(c.a);
    ctx.scale(sc, sc);
    if (c.f & F.SLIP) {
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (const y of [-10, 0, 10]) { ctx.beginPath(); ctx.moveTo(-26, y); ctx.lineTo(-26 - rnd(10, 26), y); ctx.stroke(); }
    }
    if (c.f & F.BOOST) {
      const flare = 14 + Math.random() * 16;
      const g = ctx.createLinearGradient(-20, 0, -20 - flare, 0);
      g.addColorStop(0, 'rgba(255,190,50,0.95)'); g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g;
      poly(ctx, [[-19, -8], [-19 - flare, 0], [-19, 8]]); ctx.fill();
    }
    drawCarBody(ctx, c.car);
    if (c.f & F.ICY) { ctx.fillStyle = 'rgba(190,232,255,0.38)'; rr(ctx, -23, -13, 46, 26, 8); ctx.fill(); }
    ctx.restore();

    ctx.save();
    ctx.translate(c.x, c.y);
    if (c.f & F.SHIELD) {
      const r = 30 * sc + Math.sin(now / 90) * 2.5;
      disc(ctx, 0, 0, r, 'rgba(255,214,10,0.14)');
      ctx.strokeStyle = 'rgba(255,214,10,0.95)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
    }
    if (c.f & F.AUTO) {
      ctx.strokeStyle = 'rgba(34,211,238,0.95)'; ctx.lineWidth = 3;
      ctx.setLineDash([10, 7]); ctx.lineDashOffset = now * 0.05;
      ctx.beginPath(); ctx.arc(0, 0, 29 * sc, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    const icon = (c.f & F.LOCKED) ? '🔒' : (c.f & F.SPIN) ? '💫' : (c.f & F.AUTO) ? '🤖' : (c.f & F.BUG) ? '🐛' : (c.f & F.INK) ? '🖋️' : '';
    if (icon) {
      ctx.font = `${Math.round(18 * UI)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon, 0, -24 * sc - 10 * UI);
    }
    ctx.restore();
  }

  function drawTag(c, now) {
    if (c.f & F.OUT) return;
    const sc = carScale.get(c.i) || 1;
    ctx.save();
    ctx.translate(c.x, c.y);
    if (c.f & F.FINISHED) ctx.globalAlpha = 0.55;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${c.me ? '800' : '700'} ${Math.round((c.me ? 15 : 12) * UI)}px ${FONT}`;
    ctx.lineWidth = 3.5 * UI;
    ctx.strokeStyle = 'rgba(0,0,0,0.78)';
    const ty = 22 * sc + 15 * UI;
    ctx.strokeText(c.name, 0, ty);
    ctx.fillStyle = c.me ? '#ffd60a' : c.bot ? 'rgba(255,255,255,0.78)' : '#ffffff';
    ctx.fillText(c.name, 0, ty);
    if (c.me && !(c.f & F.FINISHED)) {
      // "this one is you": sits above the car and any status icon over it
      const by = -24 * sc - 28 * UI + Math.sin(now * 0.008) * 3 * UI;
      const a = 8 * UI;
      ctx.fillStyle = '#ffd60a'; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 2 * UI;
      poly(ctx, [[-a, by - a * 1.4], [a, by - a * 1.4], [0, by]]); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- screen-wide overlays ------------------------------------------------
  function vignette(rgb, a) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, H * 0.98);
    g.addColorStop(0, `rgba(${rgb},0)`);
    g.addColorStop(1, `rgba(${rgb},${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawOutage(view, a) {
    const L = lightCtx;
    L.globalCompositeOperation = 'source-over';
    L.clearRect(0, 0, W / 2, H / 2);
    L.fillStyle = `rgba(3,5,12,${0.95 * a})`;
    L.fillRect(0, 0, W / 2, H / 2);
    L.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r) => {
      const g = L.createRadialGradient(x / 2, y / 2, r * 0.12, x / 2, y / 2, r / 2);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      L.fillStyle = g;
      L.beginPath(); L.arc(x / 2, y / 2, r / 2, 0, TAU); L.fill();
    };
    // lit areas keep their share of the screen as the world grows
    const L2 = 0.6 + UI * 0.4;
    for (const c of view.cars) {
      if (c.f & F.OUT) continue;
      hole(c.x, c.y, (c.me ? 150 : 95) * L2);
      // headlights
      const reach = (c.me ? 120 : 75) * L2;
      hole(c.x + Math.cos(c.a) * reach, c.y + Math.sin(c.a) * reach, (c.me ? 190 : 110) * L2);
    }
    for (const [, x, y] of view.missiles) hole(x, y, 70 * L2);
    ctx.drawImage(lightCv, 0, 0, W, H);
  }

  function drawInk(ink) {
    const rng = mulberry32(ink.seed);
    ctx.fillStyle = `rgba(8,8,12,${0.94 * ink.a})`;
    for (let i = 0; i < 8; i++) {
      const x = 120 + rng() * (W - 240), y = 100 + rng() * (H - 200), r = (65 + rng() * 85) * UI;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      for (let j = 0; j < 5; j++) {
        const a = rng() * TAU, d = r * (0.75 + rng() * 0.6);
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.16 + rng() * 0.24), 0, TAU); ctx.fill();
      }
    }
  }

  function drawOverlays(view) {
    const ch = view.chaos;
    if (ch && ch.a > 0) {
      if (ch.k === 'outage') drawOutage(view, ch.a);
      else if (ch.k === 'freeze') vignette('170,222,255', 0.5 * ch.a);
      else if (ch.k === 'turbo') vignette('255,150,40', 0.38 * ch.a);
      else if (ch.k === 'regression') vignette('190,80,255', 0.42 * ch.a);
    }
    const me = view.me;
    if (me) {
      if ((me.f & F.ICY) && !(ch && ch.k === 'freeze')) vignette('170,222,255', 0.42);
      if ((me.f & F.BUG) && !(ch && ch.k === 'regression')) vignette('190,80,255', 0.4);
    }
    if (view.ink && view.ink.a > 0) drawInk(view.ink);
  }

  // ---- public --------------------------------------------------------------
  function resize() {
    if (!canvas) return;
    // fill the stage element (the area left over by the HUD bar and sidebar)
    const inner = canvas.parentElement;          // wraps canvas + on-track overlays
    const box = inner && inner.parentElement;    // the stage
    const availW = (box && box.clientWidth) || window.innerWidth;
    const availH = (box && box.clientHeight) || window.innerHeight;
    const fit = Math.min(availW / W, availH / H) || 0.5;
    const cssW = Math.floor(W * fit), cssH = Math.floor(H * fit);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(800, Math.min(2400, Math.round(cssW * dpr)));
    const ph = Math.round((pw * H) / W);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw; canvas.height = ph;
      staticCv.width = pw; staticCv.height = ph;
      skidCv.width = pw; skidCv.height = ph;
      k = pw / W;
      staticDirty = true;
    }
    if (inner) {
      inner.style.width = cssW + 'px';
      inner.style.height = cssH + 'px';
    }
  }

  function init(cv) {
    canvas = cv;
    ctx = cv.getContext('2d');
    resize();
  }

  function resetRace() {
    skidCtx.setTransform(1, 0, 0, 1, 0, 0);
    skidCtx.clearRect(0, 0, skidCv.width, skidCv.height);
    particles.length = 0;
    texts.length = 0;
    wheelPrev.clear();
    carScale.clear();
    shake = 0;
  }

  function frame(view, dt, now) {
    if (!canvas) return;
    if (curMap !== view.map) { curMap = view.map; staticDirty = true; resetRace(); }
    if (staticDirty) buildStatic();
    const theme = THEMES[curMap.theme];

    let sx = 0, sy = 0;
    if (shake > 0.4) {
      sx = (Math.random() - 0.5) * shake * k;
      sy = (Math.random() - 0.5) * shake * k;
      shake *= Math.exp(-dt / 110);
    } else {
      shake = 0;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (sx || sy) { ctx.fillStyle = theme.ground; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(staticCv, sx, sy);
    ctx.drawImage(skidCv, sx, sy);
    ctx.setTransform(k, 0, 0, k, sx, sy);

    for (const c of view.cars) {
      const target = (c.f & F.GIANT) ? 1.85 : 1;
      const cur = carScale.get(c.i) || 1;
      carScale.set(c.i, cur + (target - cur) * Math.min(1, dt / 130));
    }

    drawPadPulse(curMap, now);
    drawBoxes(view, now);
    drawHazards(view, now);
    // shadows first so cars never sit under another car's shadow
    for (const c of view.cars) {
      if (c.f & (F.OUT | F.FINISHED)) continue;
      const sc = carScale.get(c.i) || 1;
      ctx.save();
      ctx.translate(c.x + 3 * sc, c.y + 5 * sc);
      ctx.rotate(c.a);
      ctx.scale(sc, sc);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      rr(ctx, -21, -12, 42, 24, 8); ctx.fill();
      ctx.restore();
    }
    for (const c of view.cars) if (c.f & F.FINISHED) drawCar(c, view, now, dt, theme);
    for (const c of view.cars) if (!(c.f & F.FINISHED) && !c.me) drawCar(c, view, now, dt, theme);
    for (const c of view.cars) if (!(c.f & F.FINISHED) && c.me) drawCar(c, view, now, dt, theme);
    drawMissiles(view, dt);
    updateParticles(dt);
    drawParticles();
    for (const c of view.cars) drawTag(c, now);
    drawTexts(dt);
    drawOverlays(view);
  }

  function drawMapPreview(cv, map) {
    const c = cv.getContext('2d');
    const theme = THEMES[map.theme];
    const s = cv.width / W;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = theme.ground;
    c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(s, 0, 0, s, 0, (cv.height - H * s) / 2);
    const path = trackPath(map), hw = map.halfWidth;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.lineWidth = hw * 2 + 26; c.strokeStyle = theme.kerbA; c.stroke(path);
    c.setLineDash([44, 44]); c.strokeStyle = theme.kerbB; c.stroke(path); c.setLineDash([]);
    c.lineWidth = hw * 2; c.strokeStyle = theme.track; c.stroke(path);
    for (const [a, b] of map.ice) {
      c.beginPath();
      for (let u = a, first = true; u <= b; u += 0.01, first = false) {
        const p = pointAt(map.path, u);
        if (first) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.lineCap = 'butt'; c.lineWidth = hw * 2 - 10; c.strokeStyle = 'rgba(170,222,255,0.75)'; c.stroke();
    }
    for (const pad of map.boostPads) {
      c.save(); c.translate(pad.x, pad.y); c.rotate(pad.angle);
      chevrons(c, hw * 1.25, BRAND_RED, [0.6, 0.8, 1]);
      c.restore();
    }
    const st = pointAt(map.path, 0);
    c.save(); c.translate(st.x, st.y); c.rotate(Math.atan2(st.ty, st.tx));
    c.fillStyle = '#ffffff'; c.fillRect(-14, -hw, 28, hw * 2);
    c.fillStyle = '#111';
    for (let i = 0; i < 6; i++) c.fillRect(i % 2 ? 0 : -14, -hw + (i * hw) / 3, 14, hw / 3);
    c.restore();
  }

  RT.Render = { init, resize, frame, resetRace, drawCarBody, drawMapPreview, fx };
})();
