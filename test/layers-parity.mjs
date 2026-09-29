#!/usr/bin/env node
// Paridad de las viñetas por capas contra las previews del PSD: con la cámara en reposo, el render GPU
// (planos 3D en perspectiva) de cada escena tiene que dar los mismos píxeles que previews/SCENE_XX.png,
// a la resolución del lienzo (1:1).
//   node test/layers-parity.mjs <ruta/al/scene_layout.json> [--keep] [--webgl] [--out dir]
// Casos por escena:
//   psd       : todas las capas del draw_order (incluida la guía de márgenes) vs la preview → objetivo 0,
//               aceptable ≤ 1/255 por canal en bordes (redondeo del alfa premultiplicado)
//   autoTiming: tiempos automáticos (textos escalonados) al final de la escena, también vs la preview
//   sinGuia   : sin la capa guía vs la composición de referencia sin guía (sharp)
// Umbral: max ≤ 1 en `psd` y `autoTiming`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startServer } from '../src/server.js';
import { snapshots } from '../src/render.js';
import { openProject, newScene } from '../src/project.js';
import { ingestLayers } from '../src/ingest.js';
import { layoutScenes } from '../src/shared/scene.js';

const argv = process.argv.slice(2);
const layout = argv.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!layout || !fs.existsSync(layout)) {
  console.error('uso: node test/layers-parity.mjs <scene_layout.json> [--keep] [--webgl] [--out dir]');
  process.exit(2);
}
const keep = argv.includes('--keep');
if (argv.includes('--webgl')) process.env.COMIC_FORCE_WEBGL = '1';
const outIdx = argv.indexOf('--out');
// diagnóstico: --depthScale 0 aplana los planos (descarta errores de la proyección en perspectiva)
const dsIdx = argv.indexOf('--depthScale');
const depthScale = dsIdx >= 0 ? +argv[dsIdx + 1] : undefined;
const dir = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'cm-layers-'));
fs.mkdirSync(dir, { recursive: true });
const doc = JSON.parse(fs.readFileSync(layout, 'utf8'));
const W = doc.canvas.width;
const H = doc.canvas.height;
const srcDir = path.dirname(path.resolve(layout));

// proyecto al tamaño del lienzo: una escena por SCENE, viñeta de capas ocupando la página sin borde
const base = newScene({ title: 'layers-parity', width: W, height: H, fps: 24 });
fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(base, null, 2));
const project = openProject(dir);
const { scene } = project.read();
const res = await ingestLayers(project, scene, layout, { makeScenes: true, log: () => {} });
project.write(scene);

async function shoot(tag, sc, pick) {
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(sc, null, 2));
  const lay = layoutScenes(sc);
  const times = lay.map(pick);
  const srv = await startServer({ projectDir: dir, withQueue: false, log: () => {} });
  try {
    const t0 = Date.now();
    const r = await snapshots({ serverUrl: srv.url, meta: sc.meta, times, outDir: path.join(dir, 'shots', tag), scale: 1 });
    r.ms = Date.now() - t0;
    return r;
  } finally {
    await srv.close();
  }
}

// variante de la escena: params extra en la viñeta
function variant(extra) {
  const sc = structuredClone(scene);
  for (const s of sc.scenes) {
    const p = s.variants[0].clips[0].variants[0].params;
    Object.assign(p, extra(p));
    if (depthScale !== undefined) p.depthScale = depthScale;
  }
  return sc;
}

async function rgb(file) {
  return sharp(file).flatten({ background: '#000' }).removeAlpha().raw().toBuffer();
}

async function diff(a, b) {
  const A = await rgb(a);
  const B = typeof b === 'string' ? await rgb(b) : b;
  if (A.length !== B.length) throw new Error(`tamaños distintos ${a}`);
  const hist = new Uint32Array(256);
  let sum = 0;
  let px = 0;
  let pxOver1 = 0;
  for (let i = 0; i < A.length; i += 3) {
    let m = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A[i + c] - B[i + c]);
      sum += d;
      hist[d]++;
      if (d > m) m = d;
    }
    if (m > 0) px++;
    if (m > 1) pxOver1++;
  }
  const pct = (q) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= q * A.length) return v;
    return 255;
  };
  let max = 0;
  for (let v = 255; v >= 0; v--)
    if (hist[v]) {
      max = v;
      break;
    }
  return { mean: +(sum / A.length).toFixed(5), p99: pct(0.99), p9999: pct(0.9999), max, pxDiff: px, pxOver1 };
}

// referencia sin guía: composición source-over en 8 bits por capa (como el ejemplo de Pillow del paquete)
async function composeRef(r) {
  const out = new Float64Array(W * H * 3);
  for (const l of r.asset.layers) {
    if (l.role === 'guide') continue;
    const { data, info } = await sharp(path.join(dir, l.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = Math.max(0, l.y); y < Math.min(H, l.y + info.height); y++)
      for (let x = Math.max(0, l.x); x < Math.min(W, l.x + info.width); x++) {
        const s = ((y - l.y) * info.width + (x - l.x)) * 4;
        const a = data[s + 3] / 255;
        if (!a) continue;
        const d = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) out[d + c] = Math.round(data[s + c] * a + out[d + c] * (1 - a));
      }
  }
  return Buffer.from(Uint8Array.from(out));
}

const rows = [];
let fail = false;
const cases = [
  { tag: 'psd', extra: () => ({ autoTiming: false, layers: { margins: { role: 'text' } } }), pick: (e) => e.start + 1, vs: 'preview', strict: true },
  { tag: 'autoTiming', extra: () => ({ layers: { margins: { role: 'text' } } }), pick: (e) => e.end - 0.45, vs: 'preview', strict: true },
  { tag: 'sinGuia', extra: () => ({ autoTiming: false }), pick: (e) => e.start + 1, vs: 'ref', strict: false },
];
const refs = {};
for (const c of cases) {
  const shot = await shoot(c.tag, variant(c.extra), c.pick);
  if (!shot.gpuBackend) throw new Error('la GPU no inicializó: ' + shot.warnings.join('; '));
  if (shot.warnings.length) console.log('⚠', c.tag, shot.warnings.join(' | '));
  for (const [i, r] of res.entries()) {
    const prev = r.asset.source.preview;
    let target;
    if (c.vs === 'preview') {
      if (!prev || !fs.existsSync(prev)) continue;
      target = prev;
    } else target = refs[r.assetId] ||= await composeRef(r);
    const d = await diff(shot.files[i].file, target);
    const ok = !c.strict || d.max <= 1;
    if (!ok) fail = true;
    rows.push({ caso: c.tag, escena: r.assetId, backend: shot.gpuBackend, ...d, ok });
  }
  rows.at(-1).msTotal = shot.ms;
}
console.table(rows);
if (!keep && !fail && outIdx < 0) fs.rmSync(dir, { recursive: true, force: true });
else console.log(`capturas en ${path.join(dir, 'shots')}`);
if (fail) {
  console.error('✗ paridad de capas fuera de umbral (max > 1/255)');
  process.exit(1);
}
console.log('✓ paridad de capas: en reposo el render coincide con las previews del PSD (max ≤ 1/255)');
