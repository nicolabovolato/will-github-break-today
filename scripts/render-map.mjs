// Renders the continent's terrain to public/map/terrain.png (then convert to webp).
// Usage: node scripts/render-map.mjs && cwebp -q 88 -alpha_q 100 public/map/terrain.png -o public/map/terrain.webp
//
// Map space is 1000 x 520 (the same space app.js places labels and radar echoes in).
// Land is opaque with relief shading, province borders and coastline baked in;
// the open sea is transparent so the page's graticule shows through.

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1000, H = 520, SCALE = 2;
const PW = W * SCALE, PH = H * SCALE;

// ---------- noise ----------
function hash(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise(x * f, y * f); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}

// ---------- signed distances (negative = inside) ----------
const ellipse = (x, y, cx, cy, rx, ry) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
  return { d: Math.hypot(x - ax - dx * t, y - ay - dy * t), t };
}
function chain(x, y, pts, r0, r1) {
  let best = Infinity;
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const { d, t } = segDist(x, y, ...pts[i], ...pts[i + 1]);
    best = Math.min(best, d - (r0 + (r1 - r0) * ((i + t) / n)));
  }
  return best;
}
function polygon(x, y, pts) {
  let d = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    d = Math.min(d, segDist(x, y, ...pts[j], ...pts[i]).d);
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? -d : d;
}
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
function curve(p0, p1, p2, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}
const curl = (a, b, c, d, e) => [...curve(a, b, c, 8), ...curve(c, d, e, 5).slice(1)];

// ---------- the continent ----------
// Legs sprawl sideways so the continent fills a landscape frame.
const LEGS = [
  curl([430, 318], [300, 400], [160, 372], [80, 352], [96, 296]),
  curl([458, 352], [392, 448], [272, 468], [214, 472], [206, 434]),
  curve([500, 360], [492, 430], [518, 500], 8),
  curl([542, 352], [608, 448], [728, 468], [786, 472], [794, 434]),
  curl([570, 318], [700, 400], [840, 372], [920, 352], [904, 296]),
];
const EAR_L = [[300, 132], [292, 8], [414, 62]];
const EAR_R = [[700, 132], [708, 8], [586, 62]];
const head = (x, y) => smin(ellipse(x, y, 500, 172, 222, 128), ellipse(x, y, 500, 112, 182, 80), 40);
const body = (x, y) => ellipse(x, y, 500, 305, 102, 64);
const island = (x, y) => Math.min(ellipse(x, y, 118, 150, 54, 30), ellipse(x, y, 176, 182, 20, 12));
// Unnamed islets scattered offshore; they carry no province.
const ISLETS = [[880, 215, 30, 16], [918, 248, 14, 9], [92, 452, 32, 17], [146, 486, 15, 9], [884, 470, 26, 14], [930, 432, 12, 8]];
const islets = (x, y) => Math.min(...ISLETS.map(([cx, cy, rx, ry]) => ellipse(x, y, cx, cy, rx, ry)));
function land(x, y) {
  return Math.min(mainland(x, y), island(x, y), islets(x, y));
}
function mainland(x, y) {
  let d = head(x, y);
  d = smin(d, polygon(x, y, EAR_L), 46);
  d = smin(d, polygon(x, y, EAR_R), 46);
  d = smin(d, body(x, y), 60);
  for (const leg of LEGS) d = smin(d, chain(x, y, leg, 31, 12), 34);
  return d;
}
const face = (x, y) => ellipse(x, y, 500, 198, 166, 92);
const NOSE = [500, 234];
function water(x, y) {
  // Eye lakes and whisker fjords; the nose is a volcano, not water.
  let d = Math.min(ellipse(x, y, 437, 185, 26, 37), ellipse(x, y, 563, 185, 26, 37));
  for (const [ax, ay, bx, by] of [[338, 214, 266, 204], [338, 234, 266, 242], [662, 214, 734, 204], [662, 234, 734, 242]]) {
    d = Math.min(d, segDist(x, y, ax, ay, bx, by).d - 2.5);
  }
  return d;
}
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
function ridged(x, y) {
  // Ridged multifractal: sharp crests, eroded-looking valleys.
  let s = 0, a = 0.55, f = 1, w = 1;
  for (let i = 0; i < 6; i++) {
    let r = 1 - Math.abs(noise(x * f, y * f) * 2 - 1);
    r *= r * w;
    w = Math.min(1, r * 2);
    s += r * a; a *= 0.5; f *= 2.1;
  }
  return s;
}
function relief(x, y, depth) {
  // Domain warp so ranges bend like real ones.
  const wx = x + (fbm(x * 0.007 + 11, y * 0.007) - 0.5) * 70;
  const wy = y + (fbm(x * 0.007, y * 0.007 + 23) - 0.5) * 70;
  const rise = smooth(0, 55, depth);
  const fd = faceEdge(x, y);
  // Face: a low desert basin with long dunes.
  const dunes = Math.sin((wx * 0.9 + wy * 0.35) * 0.16 + fbm(x * 0.02, y * 0.02) * 6) * 0.5 + 0.5;
  const desert = 0.06 + dunes * 0.035 + fbm(x * 0.05, y * 0.05) * 0.03;
  // Mountains: tall in the ears and around the rim of the face, foothills on the legs.
  const ears = smooth(150, 30, y) * smooth(130, 0, Math.min(Math.abs(x - 320), Math.abs(x - 680)) - 40);
  const rim = smooth(80, 10, Math.abs(fd - 20)) * (0.2 + 0.8 * smooth(350, 270, y));
  const range = Math.min(1, ears * 1.1 + rim * 0.75 + 0.18);
  const r = ridged(wx * 0.011, wy * 0.011);
  const highland = 0.1 + rise * 0.18 + range * r * 0.78 * rise + (fbm(wx * 0.02, wy * 0.02) - 0.5) * 0.08;
  const t = faceBlend(x, y);
  return desert + (highland - desert) * t + volcano(x, y);
}
// Mt. Incident: a cone with a summit crater on the nose.
function volcano(x, y) {
  const r = Math.hypot(x - NOSE[0], (y - NOSE[1]) * 1.15) + (fbm(x * 0.08, y * 0.08) - 0.5) * 6;
  const cone = Math.pow(smooth(30, 4, r), 1.4) * 0.38;
  const crater = smooth(5, 2, r) * 0.08;
  return cone - crater;
}
const noseR = (x, y) => Math.hypot(x - NOSE[0], (y - NOSE[1]) * 1.15);
const volcanoMix = (x, y) => smooth(26, 10, noseR(x, y)) * 0.45;
// Face edge wobbles like a real desert margin; 0 deep in the face, 1 outside it.
const faceEdge = (x, y) => face(x, y) + (fbm(x * 0.03, y * 0.03) - 0.5) * 22 + (fbm(x * 0.1, y * 0.1) - 0.5) * 6;
const faceBlend = (x, y) => smooth(-18, 14, faceEdge(x, y));

// Provinces follow the anatomy. Order must match REGIONS in public/app.js.
// 0 Copilot (left ear) · 1 Models (right ear) · 2 Git (brow) · 3 API (left cheek) · 4 Webhooks (right cheek)
// 5 Pull Requests (face) · 6 Actions (body + centre leg) · 7 Issues · 8 Codespaces · 9 Pages · 10 Packages (legs, left→right)
// 11 Unlisted Territory (offshore island)
const LEG_PROVINCE = [7, 8, 6, 9, 10];
// Head provinces meet along meandering lines, like real regional borders.
const HEAD_SEEDS = [[0, 330, 62], [1, 670, 62], [2, 500, 70], [3, 300, 220], [4, 700, 220]];
function province(x, y) {
  if (mainland(x, y) > 12) return island(x, y) < islets(x, y) ? 11 : 12;
  if (faceEdge(x, y) < -4) return 5;
  // Multi-scale warp: broad bends, mid-scale wiggles, fine jitter.
  const wx = x + (fbm(x * 0.01 + 70, y * 0.01) - 0.5) * 70 + (fbm(x * 0.045 + 3, y * 0.045) - 0.5) * 18 + (noise(x * 0.2, y * 0.2) - 0.5) * 4;
  const wy = y + (fbm(x * 0.01, y * 0.01 + 90) - 0.5) * 70 + (fbm(x * 0.045, y * 0.045 + 7) - 0.5) * 18 + (noise(x * 0.2 + 9, y * 0.2) - 0.5) * 4;
  const upper = Math.min(head(wx, wy), polygon(wx, wy, EAR_L), polygon(wx, wy, EAR_R));
  let lower = body(wx, wy), part = 6;
  LEGS.forEach((leg, k) => {
    const d = chain(wx, wy, leg, 31, 12);
    if (d < lower) { lower = d; part = LEG_PROVINCE[k]; }
  });
  if (upper < lower - 6) {
    let best = Infinity, id = 2;
    for (const [k, sx, sy] of HEAD_SEEDS) {
      const d = Math.hypot(wx - sx, wy - sy);
      if (d < best) { best = d; id = k; }
    }
    return id;
  }
  return part;
}
// ---------- colour ----------
function ramp(stops, v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a);
      return ca.map((c, k) => c + (cb[k] - c) * t);
    }
  }
  return stops.at(-1)[1];
}
const HYPSO = [
  [0, [96, 128, 70]], [0.16, [72, 108, 58]], [0.3, [58, 92, 50]], [0.42, [92, 104, 62]],
  [0.52, [124, 114, 80]], [0.62, [116, 104, 86]], [0.72, [134, 128, 120]], [0.8, [176, 172, 168]],
  [0.86, [232, 236, 240]], [1, [248, 250, 252]],
];
const SAND = [[0, [176, 150, 104]], [0.08, [204, 178, 128]], [0.14, [226, 206, 160]]];
const BEACH = [206, 192, 146];
const BASALT = [[0, [150, 128, 100]], [0.4, [128, 112, 98]], [0.7, [112, 104, 100]], [1, [140, 134, 130]]];
const DEEP = [10, 37, 82]; // --sea
const SHELF = [24, 67, 132];

// ---------- render ----------
const dist = new Float32Array(PW * PH);
const hgt = new Float32Array(PW * PH);
const kind = new Uint8Array(PW * PH); // 0 sea, 1 land, 2 inland water
for (let py = 0; py < PH; py++) {
  for (let px = 0; px < PW; px++) {
    const x = (px + 0.5) / SCALE, y = (py + 0.5) / SCALE;
    // Coast detail at three scales; the mid scale throws off small islets near the shore.
    const n = (fbm(x * 0.011, y * 0.011) - 0.5) * 14 + (fbm(x * 0.045 + 5, y * 0.045) - 0.5) * 12 + (noise(x * 0.16, y * 0.16) - 0.5) * 2.5;
    const dl = land(x, y) + n;
    const dw = water(x, y) + n * 0.2;
    const i = py * PW + px;
    if (dl < 0 && dw > 0) {
      kind[i] = 1;
      const depth = Math.min(-dl, dw);
      hgt[i] = Math.max(0, Math.min(1, relief(x, y, depth) + (fbm(x * 0.03 + 9, y * 0.03 + 4) - 0.5) * 0.35));
      dist[i] = -depth;
    } else {
      kind[i] = dl < 0 ? 2 : 0;
      dist[i] = dl < 0 ? dw : dl;
    }
  }
}

const prov = new Uint8Array(PW * PH);
const sums = Array.from({ length: 13 }, () => [0, 0, 0]);
for (let py = 0; py < PH; py++) {
  for (let px = 0; px < PW; px++) {
    const i = py * PW + px;
    if (kind[i] !== 1) continue;
    const x = (px + 0.5) / SCALE, y = (py + 0.5) / SCALE;
    const k = (prov[i] = province(x, y));
    sums[k][0] += x; sums[k][1] += y; sums[k][2]++;
  }
}
console.log("province centroids:", JSON.stringify(sums.map(([sx, sy, n]) => [Math.round(sx / n), Math.round(sy / n)])));

const out = Buffer.alloc(PW * PH * 4);
for (let py = 0; py < PH; py++) {
  for (let px = 0; px < PW; px++) {
    const i = py * PW + px, o = i * 4;
    const x = (px + 0.5) / SCALE, y = (py + 0.5) / SCALE;
    let c, a = 255;
    if (kind[i] === 1) {
      const at = (qx, qy) => hgt[Math.min(PH - 1, Math.max(0, qy)) * PW + Math.min(PW - 1, Math.max(0, qx))];
      // Hillshade from the north-west, exaggerated relief.
      const gx = (at(px + 1, py) - at(px - 1, py)) * 60, gy = (at(px, py + 1) - at(px, py - 1)) * 60;
      const nl = Math.hypot(gx, gy, 1);
      const lit = (gx * 0.6 + gy * 0.6 + 0.75) / nl / 1.2;
      const shade = Math.max(0.5, Math.min(1.3, 0.35 + lit * 0.85));
      const fb = faceBlend(x, y);
      const sand = ramp(SAND, hgt[i]);
      const green = ramp(HYPSO, hgt[i] + (fbm(x * 0.06, y * 0.06) - 0.5) * 0.05);
      let base = sand.map((v, k) => v + (green[k] - v) * fb);
      // Beaches on the outer coast, fading inland.
      const beach = smooth(3.5, 0.5, -dist[i]) * fb;
      base = base.map((v, k) => v + (BEACH[k] - v) * beach * 0.7);
      const vm = volcanoMix(x, y);
      if (vm > 0) {
        // Ash-brown flanks, grey summit, a dark crater floor.
        const rock = ramp(BASALT, hgt[i]);
        base = base.map((v, k) => v + (rock[k] - v) * vm);
      }
      c = base.map((v) => v * shade);

      // Province borders: dashed where the anatomical province changes.
      const pr = prov[i];
      // Regional borders: a solid pale line where the province changes.
      let edge = false;
      for (const j of [i + 1, i + PW]) if (j < PW * PH && kind[j] === 1 && prov[j] !== pr) edge = true;
      if (edge) c = c.map((v, k) => v + ([238, 236, 226][k] - v) * 0.75);
      // Coastline.
      if (dist[i] > -0.6) c = c.map((v) => v * 0.7 + 60);
    } else {
      const shelf = Math.max(0, 1 - dist[i] / 30);
      c = DEEP.map((v, k) => v + (SHELF[k] - v) * shelf);
      // Open sea is transparent except for the shelf glow; lakes stay opaque.
      if (kind[i] === 0) a = Math.round(255 * shelf * 0.9);
    }
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = a;
  }
}

// ---------- PNG ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((PW * 4 + 1) * PH);
for (let y = 0; y < PH; y++) out.copy(raw, y * (PW * 4 + 1) + 1, y * PW * 4, (y + 1) * PW * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(PW, 0); ihdr.writeUInt32BE(PH, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../public/map/terrain.png", import.meta.url), png);
console.log(`wrote public/map/terrain.png (${PW}x${PH})`);
