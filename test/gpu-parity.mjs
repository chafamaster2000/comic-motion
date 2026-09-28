#!/usr/bin/env node
// Test de paridad de antialiasing: la misma viñeta dibujada por el DOM y por la GPU (three) tiene que dar
// los mismos píxeles a 1080p y 4K, con ken burns, zoom de cámara, profundidad 2.5D y depthLock.
//   node test/gpu-parity.mjs [--keep] [--webgl]
// Umbrales: media abs < 1.5/255 y p99 <= 12 por canal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startServer } from '../src/server.js';
import { snapshots } from '../src/render.js';

const keep = process.argv.includes('--keep');
if (process.argv.includes('--webgl')) process.env.COMIC_FORCE_WEBGL = '1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-parity-'));
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });

// ---- imagen de prueba: líneas de 1 px, texto chico, damero, círculos, degradé ----
const W = 1600;
const H = 1000;
let shapes = '';
for (let i = 0; i < 40; i++) shapes += `<line x1="${20 + i * 12}" y1="20" x2="${20 + i * 12 + 60}" y2="300" stroke="#111" stroke-width="${i % 3 === 0 ? 1 : 2}"/>`;
for (let i = 0; i < 12; i++) shapes += `<text x="560" y="${60 + i * 26}" font-family="Helvetica, Arial" font-size="${10 + i * 2}" fill="#${i % 2 ? '123' : 'c21'}">Comic Studio parity ${10 + i * 2}px — ¡PAF! WHAM</text>`;
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x + y) % 2) shapes += `<rect x="${60 + x * 8}" y="${380 + y * 8}" width="8" height="8" fill="#000"/>`;
for (let i = 0; i < 10; i++) shapes += `<circle cx="${320 + i * 110}" cy="${520}" r="${10 + i * 4}" fill="none" stroke="#${['e33', '3a3', '33e'][i % 3]}" stroke-width="${1 + (i % 3)}"/>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#fbeec2"/><stop offset="1" stop-color="#7fb5e8"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>${shapes}
<rect x="900" y="600" width="600" height="300" fill="#fff" stroke="#000" stroke-width="3"/>
<text x="930" y="700" font-family="Helvetica, Arial" font-size="44" font-weight="bold">TEXTO FIJO 44px</text>
<text x="930" y="760" font-family="Helvetica, Arial" font-size="16">letras chicas de un globo dibujado 16px</text></svg>`;
await sharp(Buffer.from(svg)).png().toFile(path.join(dir, 'assets/test.png'));
// fondo rellenado: la misma imagen más fría; recorte: un "personaje" con alfa suave
await sharp(Buffer.from(svg)).modulate({ hue: 40 }).png().toFile(path.join(dir, 'assets/test.bgfill.png'));
const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="r"><stop offset="0.85" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>
<ellipse cx="560" cy="560" rx="260" ry="330" fill="url(#r)"/><rect x="200" y="120" width="120" height="700" fill="#fff"/></svg>`;
await sharp(path.join(dir, 'assets/test.png'))
  .composite([{ input: await sharp(Buffer.from(mask)).png().toBuffer(), blend: 'dest-in' }])
  .png()
  .toFile(path.join(dir, 'assets/test.cutout.png'));

const scene = (gpu, extra = {}, camRot = 0) => ({
  meta: { title: 'parity', width: 1920, height: 1080, fps: 24, background: '#222222' },
  assets: { test: { file: 'assets/test.png', type: 'image', w: W, h: H, cutout: 'assets/test.cutout.png', bgfill: 'assets/test.bgfill.png' } },
  scenes: [
    {
      id: 's1',
      active: 'v1',
      variants: [
        {
          id: 'v1',
          status: 'draft',
          duration: 4,
          clips: [
            {
              id: 'p1',
              track: 'panel',
              active: 'v1',
              variants: [
                {
                  id: 'v1',
                  status: 'draft',
                  preset: 'panel',
                  start: 0,
                  duration: 4,
                  params: {
                    asset: 'test',
                    rect: [120, 60, 1680, 960],
                    border: 8,
                    kenBurns: { from: { zoom: 1, fx: 0.4, fy: 0.45 }, to: { zoom: 1.35, fx: 0.6, fy: 0.55 }, ease: 'easeInOut' },
                    depth: 0.12,
                    depthLock: [[900, 600, 600, 300]],
                    gpu,
                    ...extra,
                  },
                },
              ],
            },
            {
              id: 'cam',
              track: 'camera',
              active: 'v1',
              variants: [
                {
                  id: 'v1',
                  status: 'draft',
                  preset: 'camera',
                  start: 0,
                  duration: 4,
                  params: { keys: [{ at: 0, cx: 960, cy: 540, w: 1920 }, { at: 2, cx: 1200, cy: 700, w: 700, rotate: camRot }, { at: 4, cx: 700, cy: 400, w: 1300, rotate: -camRot }] },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

async function shoot(tag, sc, scale, times) {
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(sc));
  const srv = await startServer({ projectDir: dir, withQueue: false, log: () => {} });
  try {
    const out = path.join(dir, 'shots', `${tag}_${scale}`);
    const r = await snapshots({ serverUrl: srv.url, meta: sc.meta, times, outDir: out, scale });
    return r;
  } finally {
    await srv.close();
  }
}

async function diff(a, b) {
  const A = await sharp(a).removeAlpha().raw().toBuffer();
  const B = await sharp(b).removeAlpha().raw().toBuffer();
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < A.length; i++) {
    const d = Math.abs(A[i] - B[i]);
    sum += d;
    hist[d]++;
  }
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * A.length) return v;
    return 255;
  };
  let max = 0;
  for (let v = 255; v >= 0; v--) if (hist[v]) {
    max = v;
    break;
  }
  return { mean: sum / A.length, p99: pct(0.99), p999: pct(0.999), max };
}

const times = [0, 0.9, 2, 3.3];
const cases = [
  { name: 'kenburns+depth', extra: {} },
  { name: 'tilt+enter', extra: { tilt: 3, enter: { preset: 'scale', duration: 1.2 } } },
  { name: 'cam-rotate+fade', extra: { enter: { preset: 'fade', duration: 1.5 }, radius: 40 }, camRot: 5 },
];
let fail = false;
const rows = [];
for (const c of cases) {
  for (const scale of [1, 2]) {
    const dom = await shoot(c.name + '-dom', scene(false, c.extra, c.camRot), scale, times);
    const gpu = await shoot(c.name + '-gpu', scene(true, c.extra, c.camRot), scale, times);
    if (!gpu.gpuBackend) throw new Error('la viñeta GPU no inicializó: ' + gpu.warnings.join('; '));
    for (let i = 0; i < times.length; i++) {
      const d = await diff(dom.files[i].file, gpu.files[i].file);
      const ok = d.mean < 1.5 && d.p99 <= 12;
      if (!ok) fail = true;
      rows.push({ case: c.name, res: scale === 1 ? '1080p' : '4K', t: times[i], backend: gpu.gpuBackend, mean: +d.mean.toFixed(3), p99: d.p99, p999: d.p999, max: d.max, ok });
    }
  }
}
console.table(rows);
console.log(keep || fail ? `capturas en ${dir}/shots` : '');
if (!keep && !fail) fs.rmSync(dir, { recursive: true, force: true });
if (fail) {
  console.error('✗ paridad DOM/GPU fuera de umbral');
  process.exit(1);
}
console.log('✓ paridad DOM/GPU dentro de umbral');
