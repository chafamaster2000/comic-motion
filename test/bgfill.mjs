#!/usr/bin/env node
// Test del relleno de fondo 2.5D (fillBackground): imagen sintética con fondo texturado (ruido + copos),
// borde negro de viñeta y líneas cinéticas, más una figura con contorno negro de tinta que el recorte
// no cubre del todo (como pasa con el segmentador). El hueco rellenado no debe tener manchas oscuras
// (la tinta y el negro no se difunden), debe conservar textura y no debe tocar el resto de la imagen.
//   node test/bgfill.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fillBackground } from '../src/ingest.js';

let fails = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) passes++;
  else fails++;
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
};

const W = 1920;
const H = 1080;
const n = W * H;
let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

// ruido de valor suave (una octava sobre una grilla de `cell` px)
function valueNoise(cell) {
  const gw = Math.ceil(W / cell) + 2;
  const gh = Math.ceil(H / cell) + 2;
  const g = Float32Array.from({ length: gw * gh }, rand);
  const out = new Float32Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const fx = x / cell;
      const fy = y / cell;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = (fx - x0) ** 2 * (3 - 2 * (fx - x0));
      const ty = (fy - y0) ** 2 * (3 - 2 * (fy - y0));
      const a = g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x0 + 1] * tx;
      const b = g[(y0 + 1) * gw + x0] * (1 - tx) + g[(y0 + 1) * gw + x0 + 1] * tx;
      out[y * W + x] = a * (1 - ty) + b * ty;
    }
  return out;
}

// fondo: azul nieve con ruido a dos escalas y grano, copos claros
const n1 = valueNoise(90);
const n2 = valueNoise(14);
const img = Buffer.alloc(n * 3);
for (let i = 0; i < n; i++) {
  const y = (i / W) | 0;
  const v = 120 + 50 * (n1[i] - 0.5) + 26 * (n2[i] - 0.5) + 10 * (rand() - 0.5) + 30 * (y / H);
  img[i * 3] = Math.max(0, Math.min(255, v * 0.8));
  img[i * 3 + 1] = Math.max(0, Math.min(255, v * 0.92));
  img[i * 3 + 2] = Math.max(0, Math.min(255, v * 1.1));
}
const paint = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = r;
  img[i + 1] = g;
  img[i + 2] = b;
};
for (let k = 0; k < 900; k++) {
  const cx = Math.floor(rand() * W);
  const cy = Math.floor(rand() * H);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 4) paint(cx + dx, cy + dy, 235, 240, 250);
}
// líneas cinéticas negras finas en la esquina derecha
for (let k = 0; k < 9; k++) {
  const y0 = 140 + k * 90;
  for (let x = 1500; x < W; x++) {
    const yy = Math.round(y0 + (x - 1500) * 0.15 * (k - 4) / 4);
    for (let t = -2; t <= 2; t++) paint(x, yy + t, 0, 0, 0);
  }
}
// borde negro de viñeta (40 px) — la figura lo pisa arriba
const FR = 40;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < FR || y < FR || x >= W - FR || y >= H - FR) paint(x, y, 0, 0, 0);

// figura: cuerpo elíptico + pierna, relleno rojo, contorno negro de 6 px; la cabeza pisa el borde de arriba
const body = (x, y) => ((x - 900) / 260) ** 2 + ((y - 470) / 330) ** 2 <= 1 || (x > 840 && x < 960 && y > 600 && y < 1000);
const inside = new Uint8Array(n);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (body(x, y)) inside[y * W + x] = 1;
const dist = new Float32Array(n).fill(1e9);
// distancia exacta al cuerpo (fuerza bruta acotada a un margen de 12 px)
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (inside[i]) {
      dist[i] = 0;
      continue;
    }
    let best = 1e9;
    for (let dy = -12; dy <= 12; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -12; dx <= 12; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W || !inside[yy * W + xx]) continue;
        best = Math.min(best, dx * dx + dy * dy);
      }
    }
    dist[i] = Math.sqrt(best);
  }
for (let i = 0; i < n; i++) {
  const x = i % W;
  const y = (i / W) | 0;
  if (inside[i]) {
    const s = 0.75 + 0.25 * n2[i];
    paint(x, y, 200 * s, 40 * s, 50 * s);
  }
  if (dist[i] <= 6 && (inside[i] ? false : true)) paint(x, y, 10, 8, 12); // tinta por fuera del cuerpo
  if (inside[i] && dist[i] === 0) {
    // contorno también hacia adentro: tinta en los 3 px interiores
    let edge = false;
    for (let d = 1; d <= 3 && !edge; d++) for (const [ax, ay] of [[d, 0], [-d, 0], [0, d], [0, -d]]) if (!body(x + ax, y + ay)) edge = true;
    if (edge) paint(x, y, 10, 8, 12);
  }
}
// recorte como el de un segmentador: cubre el cuerpo y solo 2 px de los 6 de tinta, con un halo suave de 3 px
const alpha = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) {
  const d = dist[i];
  const a = d <= 2 ? 255 : d <= 5 ? Math.round(255 * (1 - (d - 2) / 3) * 0.5) : 0;
  alpha[i * 4] = img[i * 3];
  alpha[i * 4 + 1] = img[i * 3 + 1];
  alpha[i * 4 + 2] = img[i * 3 + 2];
  alpha[i * 4 + 3] = a;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgfill-test-'));
const src = path.join(dir, 'src.png');
const cut = path.join(dir, 'cut.png');
const out = path.join(dir, 'fill.png');
await sharp(img, { raw: { width: W, height: H, channels: 3 } }).png().toFile(src);
await sharp(alpha, { raw: { width: W, height: H, channels: 4 } }).png().toFile(cut);
const t0 = performance.now();
await fillBackground(src, cut, out);
const secs = (performance.now() - t0) / 1000;
const res = await sharp(out).removeAlpha().raw().toBuffer();
if (process.env.BGFILL_KEEP) console.log('salida en', out);
else fs.rmSync(dir, { recursive: true, force: true });

const Y = (b, i) => 0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2];
// promedio local (caja de 13×13) con imagen integral
function localMean(b) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < W; x++) {
      s += Y(b, y * W + x);
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s;
    }
  }
  const r = 6;
  const M = new Float32Array(n);
  for (let y = r; y < H - r; y++)
    for (let x = r; x < W - r; x++) {
      const a = (y - r) * (W + 1) + x - r;
      const b2 = (y + r + 1) * (W + 1) + x - r;
      M[y * W + x] = (I[b2 + 2 * r + 1] - I[b2] - I[a + 2 * r + 1] + I[a]) / (2 * r + 1) ** 2;
    }
  return M;
}
const inFrame = (i) => {
  const x = i % W;
  const y = (i / W) | 0;
  return x >= FR + 20 && y >= FR + 20 && x < W - FR - 20 && y < H - FR - 20;
};
const Mo = localMean(res);
const Mi = localMean(img);
// zona rellenada (dentro del panel, lejos del borde negro): la figura con su tinta
const holeIdx = [];
const bgIdx = [];
for (let i = 0; i < n; i++) {
  if (!inFrame(i)) continue;
  const x = i % W;
  if (dist[i] <= 6) holeIdx.push(i);
  else if (dist[i] > 60 && x < 1450) bgIdx.push(i);
}
const bgLocal = bgIdx.map((i) => Mi[i]).sort((a, b) => a - b);
const bgP1 = bgLocal[Math.floor(bgLocal.length * 0.01)];
const holeMin = holeIdx.reduce((m, i) => Math.min(m, Mo[i]), 255);
ok(holeMin >= 0.85 * bgP1, `sin manchas oscuras: luminancia local mínima del relleno ${holeMin.toFixed(1)} ≥ 0.85 × p1 del fondo (${bgP1.toFixed(1)})`);
let darkPx = 0;
for (const i of holeIdx) if (Y(res, i) < 0.5 * bgP1) darkPx++;
ok(darkPx < holeIdx.length * 0.001, `sin restos de tinta en el hueco: ${darkPx} px oscuros de ${holeIdx.length}`);

// textura: desvío del alto-paso (pixel − promedio local) en el interior del hueco vs. el fondo
const hp = (b, M, idx) => {
  let s = 0;
  let s2 = 0;
  for (const i of idx) {
    const v = Y(b, i) - M[i];
    s += v;
    s2 += v * v;
  }
  return Math.sqrt(Math.max(0, s2 / idx.length - (s / idx.length) ** 2));
};
const deep = holeIdx.filter((i) => inside[i] && Math.abs((i % W) - 900) < 200 && Math.abs(((i / W) | 0) - 470) < 250);
const texHole = hp(res, Mo, deep);
const texBg = hp(img, Mi, bgIdx);
ok(texHole >= 0.4 * texBg && texHole <= 2 * texBg, `textura conservada: alto-paso del relleno ${texHole.toFixed(2)} vs fondo ${texBg.toFixed(2)} (0.4×–2×)`);
// el brillo medio del relleno sigue al del fondo de alrededor
const meanOf = (b, idx) => idx.reduce((s, i) => s + Y(b, i), 0) / idx.length;
const ring = bgIdx.filter((i) => Math.abs((i % W) - 900) < 420 && Math.abs(((i / W) | 0) - 470) < 450);
const mh = meanOf(res, deep);
const mr = meanOf(img, ring);
ok(Math.abs(mh - mr) < 0.15 * mr, `brillo del relleno ${mh.toFixed(1)} cerca del entorno ${mr.toFixed(1)}`);
// fuera del hueco (y su margen) la imagen queda intacta
let changed = 0;
for (let i = 0; i < n; i++) if (dist[i] > 40 && (res[i * 3] !== img[i * 3] || res[i * 3 + 1] !== img[i * 3 + 1] || res[i * 3 + 2] !== img[i * 3 + 2])) changed++;
ok(changed === 0, `fuera del hueco no cambia nada (${changed} px distintos)`);
ok(secs < 10, `tiempo ${secs.toFixed(2)} s a ${W}×${H} (< 10 s)`);

console.log(`\n${passes} ok, ${fails} fallas`);
process.exit(fails ? 1 : 0);
