// Ingesta de material: copia al proyecto, mide, genera proxies de video, hojas de contacto,
// detección de viñetas (opencv.js) y recorte de personajes (transformers.js + BiRefNet).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import sharp from 'sharp';
import { annotateAssetBounds } from './pixel-bounds.js';
import { roleFromName, ROLE_DEPTH, GLOBAL_BG_DEPTH, CHARACTER_DEPTH_RANGE, resolveLayers, wordsOf, readingOrder } from './player/layers.js';

const IMG = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.tif', '.tiff'];
const VID = ['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi'];

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .slice(0, 40) || 'asset';

function uniqueId(scene, base) {
  let id = base;
  let n = 2;
  while (scene.assets[id]) id = `${base}_${n++}`;
  return id;
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const s = j.streams[0];
  const [a, b] = s.r_frame_rate.split('/').map(Number);
  return { w: s.width, h: s.height, fps: b ? a / b : a, duration: parseFloat(j.format.duration) };
}

export async function ingest(project, scene, files, { log = console.log } = {}) {
  const assetsDir = path.join(project.dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const added = [];
  for (const src of files) {
    const ext = path.extname(src).toLowerCase();
    const isImg = IMG.includes(ext);
    const isVid = VID.includes(ext);
    if (!isImg && !isVid) {
      log(`salteo ${src}: formato no soportado`);
      continue;
    }
    const id = uniqueId(scene, slug(path.basename(src, ext)));
    let dest = path.join(assetsDir, id + ext);
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
    const asset = { file: path.relative(project.dir, dest), type: isImg ? 'image' : 'video', source: path.resolve(src) };
    if (isImg) {
      if (['.gif', '.tif', '.tiff', '.avif'].includes(ext)) {
        const png = path.join(assetsDir, id + '.png');
        await sharp(dest).png().toFile(png);
        asset.file = path.relative(project.dir, png);
        dest = png;
      }
      const m = await sharp(dest).metadata();
      asset.w = m.width;
      asset.h = m.height;
      await annotateAssetBounds(project.dir, asset); // canaleta/marco de la imagen (límites de cámara)
    } else {
      const info = probe(dest);
      Object.assign(asset, { w: info.w, h: info.h, duration: +info.duration.toFixed(3) });
      // proxy WebM: códec libre (el Chromium de Playwright no trae H.264) y keyframes densos para buscar rápido
      const proxy = path.join(assetsDir, id + '.proxy.webm');
      log(`transcodificando ${path.basename(src)} → proxy webm…`);
      const fps = Math.min(60, Math.round(info.fps) || 30);
      asset.fps = fps;
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', dest, '-an', '-vf', `fps=${fps},scale='min(1920,iw)':-2`, '-fps_mode', 'cfr', '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-g', '6', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', proxy]);
      asset.proxy = path.relative(project.dir, proxy);
      const sheet = await contactSheet(project, id, dest, info.duration);
      asset.contactSheet = sheet.file;
      asset.contactTimes = sheet.times;
    }
    scene.assets[id] = asset;
    added.push({ id, ...asset });
  }
  return added;
}

// Hoja de contacto: N cuadros en grilla, para que el VLM entienda el video y elija puntos de entrada.
export async function contactSheet(project, id, file, duration) {
  const n = Math.min(16, Math.max(4, Math.ceil(duration)));
  const times = Array.from({ length: n }, (_, i) => +((duration * (i + 0.5)) / n).toFixed(2));
  const tmp = path.join(project.internal, 'frames', id);
  fs.mkdirSync(tmp, { recursive: true });
  const tiles = [];
  for (const [i, t] of times.entries()) {
    const f = path.join(tmp, `${String(i).padStart(2, '0')}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', f]);
    const label = Buffer.from(`<svg width="480" height="44"><rect width="140" height="44" fill="black" opacity=".7"/><text x="10" y="31" font-size="26" font-family="Helvetica" fill="#ffd400">${t.toFixed(2)}s</text></svg>`);
    tiles.push(await sharp(f).composite([{ input: label, top: 0, left: 0 }]).toBuffer());
  }
  const meta = await sharp(tiles[0]).metadata();
  const cols = 4;
  const rows = Math.ceil(tiles.length / cols);
  const out = path.join(project.internal, 'frames', `${id}_sheet.jpg`);
  await sharp({ create: { width: cols * meta.width, height: rows * meta.height, channels: 3, background: '#222' } })
    .composite(tiles.map((b, i) => ({ input: b, left: (i % cols) * meta.width, top: Math.floor(i / cols) * meta.height })))
    .jpeg({ quality: 85 })
    .toFile(out);
  return { file: path.relative(project.dir, out), times };
}

// ---------- detección de viñetas ----------
let cvReady;
async function getCV() {
  if (!cvReady) {
    cvReady = import('@techstark/opencv-js').then(async (mod) => {
      const cv = mod.default || mod;
      if (cv.Mat) return cv;
      if (typeof cv.then === 'function') return await cv; // build de Emscripten: el módulo es thenable
      return new Promise((resolve) => (cv.onRuntimeInitialized = () => resolve(cv)));
    });
  }
  return cvReady;
}

export async function detectPanels(project, scene, assetId, { minArea = 0.02, threshold } = {}) {
  const a = scene.assets[assetId];
  if (!a || a.type !== 'image') throw new Error(`asset de imagen no encontrado: ${assetId}`);
  const file = path.join(project.dir, a.file);
  const { data, info } = await sharp(file).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const cv = await getCV();
  const src = cv.matFromArray(info.height, info.width, cv.CV_8UC1, data);
  // color de canaleta = mediana de la luminancia del borde de la página (blanca, negra o de color)
  const border = [];
  const W = info.width;
  const Hh = info.height;
  for (let x = 0; x < W; x += 2) border.push(data[x], data[(Hh - 1) * W + x]);
  for (let y = 0; y < Hh; y += 2) border.push(data[y * W], data[y * W + W - 1]);
  border.sort((a, b) => a - b);
  const gutter = border[border.length >> 1];
  // lo que se aleja del color de canaleta es contenido de viñeta
  const tol = threshold ?? 20;
  const diff = new cv.Mat();
  const g = new cv.Mat(src.rows, src.cols, cv.CV_8UC1, new cv.Scalar(gutter));
  cv.absdiff(src, g, diff);
  g.delete();
  const bin = new cv.Mat();
  cv.threshold(diff, bin, tol, 255, cv.THRESH_BINARY);
  diff.delete();
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const total = info.width * info.height;
  let boxes = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const r = cv.boundingRect(c);
    const area = r.width * r.height;
    const fill = cv.contourArea(c) / area;
    if (area / total >= minArea && area / total < 0.97) boxes.push({ x: r.x, y: r.y, w: r.width, h: r.height, fill: +fill.toFixed(2) });
    c.delete();
  }
  src.delete();
  bin.delete();
  k.delete();
  contours.delete();
  hier.delete();
  // quitar cajas contenidas en otras
  boxes = boxes.filter((b) => !boxes.some((o) => o !== b && b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h));
  // orden de lectura: filas (por solapamiento vertical), luego izquierda→derecha
  boxes.sort((p, q) => p.y - q.y);
  const rows = [];
  for (const b of boxes) {
    const row = rows.find((r) => b.y < r.y + r.h * 0.6 && b.y + b.h * 0.4 > r.y);
    if (row) {
      row.items.push(b);
      row.h = Math.max(row.h, b.y + b.h - row.y);
    } else rows.push({ y: b.y, h: b.h, items: [b] });
  }
  const ordered = rows.flatMap((r) => r.items.sort((p, q) => p.x - q.x)).map((b, i) => ({ n: i + 1, crop: [b.x, b.y, b.w, b.h], fill: b.fill }));
  const outDir = path.join(project.internal, 'panels');
  fs.mkdirSync(outDir, { recursive: true });
  const overlay = Buffer.from(
    `<svg width="${info.width}" height="${info.height}" xmlns="http://www.w3.org/2000/svg">${ordered
      .map(
        (b) =>
          `<rect x="${b.crop[0]}" y="${b.crop[1]}" width="${b.crop[2]}" height="${b.crop[3]}" fill="none" stroke="#ff2d55" stroke-width="${Math.max(4, info.width / 250)}"/>` +
          `<rect x="${b.crop[0]}" y="${b.crop[1]}" width="${info.width / 14}" height="${info.width / 16}" fill="#ff2d55"/>` +
          `<text x="${b.crop[0] + info.width / 90}" y="${b.crop[1] + info.width / 20}" font-size="${info.width / 22}" font-family="Helvetica" font-weight="bold" fill="#fff">${b.n}</text>`,
      )
      .join('')}</svg>`,
  );
  const overlayFile = path.join(outDir, `${assetId}_panels.jpg`);
  const composed = await sharp(file).composite([{ input: overlay }]).png().toBuffer();
  await sharp(composed).resize({ width: Math.min(1600, info.width) }).jpeg({ quality: 85 }).toFile(overlayFile);
  const result = { asset: assetId, size: [info.width, info.height], gutterLuma: gutter, panels: ordered, overlay: path.relative(project.dir, overlayFile) };
  fs.writeFileSync(path.join(outDir, `${assetId}.json`), JSON.stringify(result, null, 2));
  return result;
}

// ---------- recorte de personaje ----------
export async function cutout(project, scene, assetId, { model = 'onnx-community/BiRefNet_lite-ONNX' } = {}) {
  const a = scene.assets[assetId];
  if (!a || a.type !== 'image') throw new Error(`asset de imagen no encontrado: ${assetId}`);
  const { pipeline, env, RawImage } = await import('@huggingface/transformers');
  env.cacheDir = path.join(os.homedir(), '.cache', 'comic-motion', 'models');
  const seg = await pipeline('background-removal', model, { dtype: 'fp32' });
  const file = path.join(project.dir, a.file);
  const img = await RawImage.read(file);
  const res = await seg(img);
  const out = Array.isArray(res) ? res[0] : res;
  const outFile = path.join(project.dir, 'assets', `${assetId}.cutout.png`);
  // alfa del sujeto al tamaño original, con los colores del original
  const W = a.w;
  const H = a.h;
  const rgb = await sharp(file).removeAlpha().toColourspace('srgb').resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const alpha = await sharp(Buffer.from(out.data), { raw: { width: out.width, height: out.height, channels: out.channels } })
    .extractChannel(out.channels === 1 ? 0 : out.channels - 1)
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer();
  cleanCutoutAlpha(rgb, alpha, W, H);
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outFile);
  a.cutout = path.relative(project.dir, outFile);
  const fill = path.join(project.dir, 'assets', `${assetId}.bgfill.png`);
  await fillBackground(file, outFile, fill);
  a.bgfill = path.relative(project.dir, fill);
  return { file: a.cutout, bgfill: a.bgfill, model };
}

// Limpia el alfa del segmentador (in place): saca motas sueltas (un pedazo de un objeto fino del fondo
// tomado como sujeto se movería solo) y suma el contorno de tinta que quedó afuera, para que viaje con
// el personaje en vez de quedar pegado al fondo.
function cleanCutoutAlpha(rgb, alpha, W, H) {
  const n = W * H;
  const lab = new Int32Array(n);
  const q = new Int32Array(n);
  const comps = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (alpha[s0] <= 12 || lab[s0]) continue;
    const id = comps.length + 1;
    let qh = 0;
    let qt = 0;
    q[qt++] = s0;
    lab[s0] = id;
    while (qh < qt) {
      const i = q[qh++];
      const x = i % W;
      if (x > 0 && !lab[i - 1] && alpha[i - 1] > 12) { lab[i - 1] = id; q[qt++] = i - 1; }
      if (x < W - 1 && !lab[i + 1] && alpha[i + 1] > 12) { lab[i + 1] = id; q[qt++] = i + 1; }
      if (i >= W && !lab[i - W] && alpha[i - W] > 12) { lab[i - W] = id; q[qt++] = i - W; }
      if (i + W < n && !lab[i + W] && alpha[i + W] > 12) { lab[i + W] = id; q[qt++] = i + W; }
    }
    comps.push(qt);
  }
  const biggest = Math.max(0, ...comps);
  const drop = comps.map((area) => area < 0.002 * n && area < 0.02 * biggest);
  if (drop.some(Boolean)) for (let i = 0; i < n; i++) if (lab[i] && drop[lab[i] - 1]) alpha[i] = 0;
  const rim = inkRim(rgb, alpha, W, H);
  for (let i = 0; i < n; i++) if (rim[i]) alpha[i] = 255;
}

// Fondo sin personajes para la profundidad 2.5D: rellena el hueco del recorte con el entorno, sin que la
// tinta ni el negro de los bordes se difundan (manchas oscuras) y conservando textura (nieve, grano), para
// que lo que asoma cuando la capa del frente se mueve no sea ni un fantasma del personaje ni un borrón liso.
// Todo en JS: pull-push ponderado + textura trasplantada por baldosas. ~1-2 s a 1920×1080.
export async function fillBackground(file, cutoutFile, outFile) {
  const { data: rgb, info } = await sharp(file).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const alpha = await sharp(cutoutFile).ensureAlpha().extractChannel(3).resize(W, H, { fit: 'fill' }).raw().toBuffer();
  const out = fillHolePixels(rgb, alpha, W, H);
  await sharp(Buffer.from(out.buffer, out.byteOffset, out.length), { raw: { width: W, height: H, channels: 3 } }).png().toFile(outFile);
}

const luma = (p, i) => 0.299 * p[i * 3] + 0.587 * p[i * 3 + 1] + 0.114 * p[i * 3 + 2];

// distancia (chamfer 1/√2) de cada píxel al más cercano con seed[i]=1
function distanceTo(seed, W, H) {
  const D = new Float32Array(W * H);
  const INF = 1e9;
  for (let i = 0; i < W * H; i++) D[i] = seed[i] ? 0 : INF;
  const S = Math.SQRT2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let d = D[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, D[i - 1] + 1);
      if (y > 0) {
        d = Math.min(d, D[i - W] + 1);
        if (x > 0) d = Math.min(d, D[i - W - 1] + S);
        if (x < W - 1) d = Math.min(d, D[i - W + 1] + S);
      }
      D[i] = d;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let d = D[i];
      if (d === 0) continue;
      if (x < W - 1) d = Math.min(d, D[i + 1] + 1);
      if (y < H - 1) {
        d = Math.min(d, D[i + W] + 1);
        if (x < W - 1) d = Math.min(d, D[i + W + 1] + S);
        if (x > 0) d = Math.min(d, D[i + W - 1] + S);
      }
      D[i] = d;
    }
  return D;
}

// Máscara del hueco: alfa (con el halo semitransparente) + margen fijo + la tinta oscura pegada al borde.
function holeMask(rgb, alpha, W, H) {
  const alphaThr = 12;
  const n = W * H;
  const diag = Math.hypot(W, H);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = alpha[i] > alphaThr ? 1 : 0;
  const d = distanceTo(core, W, H);
  const d0 = Math.max(2, 0.0025 * diag);
  const dInk = Math.max(3, 0.009 * diag);
  // umbral de "tinta": relativo al fondo que rodea al personaje
  const ring = [];
  for (let i = 0; i < n; i += 3) if (d[i] > d0 && d[i] <= d0 + 0.025 * diag) ring.push(luma(rgb, i));
  ring.sort((a, b) => a - b);
  const med = ring.length ? ring[ring.length >> 1] : 128;
  const inkT = Math.min(80, Math.max(18, 0.45 * med));
  const hole = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) if (d[i] <= d0) { hole[i] = 1; queue[qt++] = i; }
  // crece por píxeles oscuros conectados (contorno de tinta, sombra dura pegada), hasta d0+dInk
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W;
    const y = (i / W) | 0;
    for (let k = 0; k < 4; k++) {
      const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < W - 1 ? i + 1 : -1) : k === 2 ? (y > 0 ? i - W : -1) : y < H - 1 ? i + W : -1;
      if (j < 0 || hole[j] || d[j] > d0 + dInk) continue;
      if (luma(rgb, j) < inkT * 1.4) { hole[j] = 1; queue[qt++] = j; }
    }
  }
  // 2 px más para el antialias de la tinta
  const d2 = distanceTo(hole, W, H);
  for (let i = 0; i < n; i++) hole[i] = d2[i] <= 2 ? 1 : 0;
  return { hole, inkT };
}

// Contorno de tinta que el segmentador dejó afuera: trazos oscuros FINOS pegados al sujeto (no zonas
// oscuras grandes como el borde de la viñeta). Se suman al alfa del recorte para que se muevan con él.
function inkRim(rgb, alpha, W, H) {
  const n = W * H;
  const diag = Math.hypot(W, H);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i++) core[i] = alpha[i] > 128 ? 1 : 0;
  const d = distanceTo(core, W, H);
  const ring = [];
  for (let i = 0; i < n; i += 3) if (d[i] > 0.004 * diag && d[i] <= 0.03 * diag) ring.push(luma(rgb, i));
  ring.sort((a, b) => a - b);
  const med = ring.length ? ring[ring.length >> 1] : 128;
  const inkT = Math.min(80, Math.max(18, 0.45 * med));
  const dark = new Float32Array(n);
  const known = new Float32Array(n);
  for (let i = 0; i < n; i++) if (!core[i]) { known[i] = 1; dark[i] = luma(rgb, i) < inkT * 1.4 ? 1 : 0; }
  const rf = Math.max(3, Math.round(0.008 * diag));
  const db = boxBlur(dark, W, H, rf, 2);
  const kb = boxBlur(known, W, H, rf, 2);
  const lim = Math.max(3, 0.006 * diag);
  const rim = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) if (core[i]) queue[qt++] = i;
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W;
    const y = (i / W) | 0;
    for (let k = 0; k < 4; k++) {
      const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < W - 1 ? i + 1 : -1) : k === 2 ? (y > 0 ? i - W : -1) : y < H - 1 ? i + W : -1;
      if (j < 0 || core[j] || rim[j] || d[j] > lim || !dark[j]) continue;
      if (db[j] / Math.max(1e-6, kb[j]) > 0.5) continue; // zona oscura grande: es fondo
      rim[j] = 1;
      queue[qt++] = j;
    }
  }
  return rim;
}

// pull-push (Gortler): interpola el hueco con el entorno ponderado; devuelve RGB float del tamaño W×H
function pullPush(rgb, wt, W, H) {
  const levels = [];
  let w = W;
  let h = H;
  let P = new Float32Array(w * h * 3);
  let A = Float32Array.from(wt);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) P[i * 3 + c] = rgb[i * 3 + c] * wt[i];
  levels.push({ w, h, P, A });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, (w + 1) >> 1);
    const nh = Math.max(1, (h + 1) >> 1);
    const P2 = new Float32Array(nw * nh * 3);
    const A2 = new Float32Array(nw * nh);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const j = (y >> 1) * nw + (x >> 1);
        A2[j] += A[i];
        P2[j * 3] += P[i * 3];
        P2[j * 3 + 1] += P[i * 3 + 1];
        P2[j * 3 + 2] += P[i * 3 + 2];
      }
    for (let j = 0; j < nw * nh; j++)
      if (A2[j] > 1) {
        const s = 1 / A2[j];
        P2[j * 3] *= s;
        P2[j * 3 + 1] *= s;
        P2[j * 3 + 2] *= s;
        A2[j] = 1;
      }
    w = nw;
    h = nh;
    P = P2;
    A = A2;
    levels.push({ w, h, P, A });
  }
  // push: de lo grueso a lo fino, completando con la interpolación bilineal del nivel de arriba
  let C = new Float32Array(3);
  {
    const top = levels[levels.length - 1];
    for (let c = 0; c < 3; c++) C[c] = top.A[0] > 0 ? top.P[c] / top.A[0] : 128;
  }
  for (let L = levels.length - 2; L >= 0; L--) {
    const { w, h, P, A } = levels[L];
    const cw = levels[L + 1].w;
    const ch = levels[L + 1].h;
    const N = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(fy);
      const y1 = Math.min(ch - 1, y0 + 1);
      const ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx);
        const x1 = Math.min(cw - 1, x0 + 1);
        const tx = fx - x0;
        const i = y * w + x;
        const a = A[i];
        for (let c = 0; c < 3; c++) {
          const up = (C[(y0 * cw + x0) * 3 + c] * (1 - tx) + C[(y0 * cw + x1) * 3 + c] * tx) * (1 - ty) + (C[(y1 * cw + x0) * 3 + c] * (1 - tx) + C[(y1 * cw + x1) * 3 + c] * tx) * ty;
          N[i * 3 + c] = P[i * 3 + c] + (1 - a) * up;
        }
      }
    }
    C = N;
  }
  return { C };
}

function boxBlur(src, w, h, r, passes) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * r + 1);
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// dentro del hueco, base ← mezcla hacia `other` según la cercanía a las fuentes `src` (gaussiana de radio R)
function blendByDistance(base, other, src, hole, W, H, R) {
  const d = distanceTo(src, W, H);
  for (let i = 0; i < W * H; i++) {
    if (!hole[i]) continue;
    const m = Math.exp(-((d[i] / R) ** 2));
    if (m < 1e-3) continue;
    for (let c = 0; c < 3; c++) base[i * 3 + c] += (other[i * 3 + c] - base[i * 3 + c]) * m;
  }
}

function fillHolePixels(rgb, alpha, W, H, { detail = 1, grain = 1.2, seed = 7 } = {}) {
  const n = W * H;
  const diag = Math.hypot(W, H);
  const { hole, inkT } = holeMask(rgb, alpha, W, H);
  // Cada muestra del entorno tiene un "alcance": la nieve o el cielo limpio pueden extenderse por todo el
  // hueco, pero lo oscuro (tinta, borde negro de viñeta, líneas cinéticas) y las islas chicas de fondo
  // encerradas por el personaje (huecos entre brazos y piernas) solo tiñen lo que tienen cerca. Por eso se
  // calculan tres rellenos (limpio, con islas, con oscuros) y se mezclan según la distancia a cada fuente.
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = luma(rgb, i);
  const darkT = inkT * 1.3;
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!hole[i] && Y[i] < darkT) dark[i] = 1;
  const island = new Uint8Array(n);
  {
    const lab = new Uint8Array(n);
    const q = new Int32Array(n);
    const minArea = 0.01 * n;
    for (let s0 = 0; s0 < n; s0++) {
      if (hole[s0] || lab[s0]) continue;
      let qh = 0;
      let qt = 0;
      q[qt++] = s0;
      lab[s0] = 1;
      while (qh < qt) {
        const i = q[qh++];
        const x = i % W;
        if (x > 0 && !hole[i - 1] && !lab[i - 1]) { lab[i - 1] = 1; q[qt++] = i - 1; }
        if (x < W - 1 && !hole[i + 1] && !lab[i + 1]) { lab[i + 1] = 1; q[qt++] = i + 1; }
        if (i >= W && !hole[i - W] && !lab[i - W]) { lab[i - W] = 1; q[qt++] = i - W; }
        if (i + W < n && !hole[i + W] && !lab[i + W]) { lab[i + W] = 1; q[qt++] = i + W; }
      }
      if (qt < minArea) for (let k = 0; k < qt; k++) island[q[k]] = 1;
    }
  }
  // peso base: transición suave entre oscuro (0) y claro (1)
  const wt = new Float32Array(n);
  for (let i = 0; i < n; i++) if (!hole[i]) wt[i] = Math.min(1, Math.max(0, (Y[i] - inkT) / (0.6 * inkT)));
  // las muestras pegadas al hueco suelen traer restos del personaje (brillos, halo): pesan según cuánto se
  // parecen a la estimación hecha sin ellas (un peso chico igual "gana" donde no hay otra muestra: mejor cero)
  const dHole = distanceTo(hole, W, H);
  const band = Math.max(4, 0.012 * diag);
  const wClean = new Float32Array(n);
  let tot = 0;
  for (let i = 0; i < n; i++) if (!island[i] && dHole[i] > band) tot += wClean[i] = wt[i];
  let base;
  if (tot > 0) {
    const far = pullPush(rgb, wClean, W, H).C;
    const s2 = 1 / (3 * 35 * 35);
    for (let i = 0; i < n; i++) {
      if (hole[i] || island[i] || dHole[i] > band) continue;
      const dr = rgb[i * 3] - far[i * 3];
      const dg = rgb[i * 3 + 1] - far[i * 3 + 1];
      const db = rgb[i * 3 + 2] - far[i * 3 + 2];
      const sim = Math.exp(-(dr * dr + dg * dg + db * db) * s2);
      wClean[i] = sim < 0.15 ? 0 : wt[i] * sim;
    }
    base = pullPush(rgb, wClean, W, H).C;
    // islas: alcance ~2.5 % de la diagonal
    if (island.some((v, i) => v && wt[i] > 0)) {
      const wI = Float32Array.from(wClean);
      for (let i = 0; i < n; i++) if (island[i]) wI[i] = wt[i];
      const withI = pullPush(rgb, wI, W, H).C;
      blendByDistance(base, withI, island, hole, W, H, 0.025 * diag);
      for (let i = 0; i < n; i++) if (island[i]) wClean[i] = wt[i];
    }
  }
  let solidMix = null;
  // oscuros. Los trazos finos (tinta, líneas cinéticas) tienen alcance ~2 % de la diagonal. Las zonas
  // oscuras grandes (borde negro de viñeta, noche) son fondo de verdad: se decide qué parte del hueco les
  // toca extendiendo su silueta (no su color) hacia adentro, así el borde de la viñeta sigue siendo un borde.
  if (!base || dark.some((v) => v)) {
    const known = new Float32Array(n);
    const dk = new Float32Array(n);
    for (let i = 0; i < n; i++) if (!hole[i]) { known[i] = 1; dk[i] = dark[i]; }
    const rf = Math.max(3, Math.round(0.008 * diag));
    const kb = boxBlur(known, W, H, rf, 2);
    const db = boxBlur(dk, W, H, rf, 2);
    const solid = new Uint8Array(n);
    const thin = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (dark[i]) (db[i] / Math.max(1e-6, kb[i]) > 0.5 ? solid : thin)[i] = 1;
    const wD = Float32Array.from(wClean);
    for (let i = 0; i < n; i++) if (thin[i]) wD[i] = 0.03;
    const withD = pullPush(rgb, wD, W, H).C;
    if (!base) base = withD;
    else blendByDistance(base, withD, thin, hole, W, H, 0.02 * diag);
    if (solid.some((v) => v)) {
      // la silueta se extiende con las muestras lejanas: el halo claro pegado al personaje no cuenta
      const ind = new Uint8Array(n * 3);
      const wS = new Float32Array(n);
      const wK = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (solid[i]) ind[i * 3] = ind[i * 3 + 1] = ind[i * 3 + 2] = 255;
        wS[i] = solid[i] ? 1 : 0;
        wK[i] = known[i] && (solid[i] || dHole[i] > 0.005 * diag) ? 1 : 0;
      }
      const side = pullPush(ind, wK, W, H).C; // 255 = lado oscuro
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (!hole[i]) continue;
        const t = Math.min(1, Math.max(0, (side[i * 3] / 255 - 0.45) / 0.1));
        m[i] = t * t * (3 - 2 * t);
      }
      solidMix = { m, col: pullPush(rgb, wS, W, H).C };
    }
  }
  {
    // suaviza solo la parte rellenada (la estructura del pull-push se nota en bloques)
    const r = Math.max(2, Math.round(0.004 * diag));
    for (let c = 0; c < 3; c++) {
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) ch[i] = base[i * 3 + c];
      const b = boxBlur(ch, W, H, r, 3);
      for (let i = 0; i < n; i++) if (hole[i]) base[i * 3 + c] = b[i];
    }
  }
  // el lado oscuro va después del suavizado, para que el borde con la viñeta no se lave
  if (solidMix) {
    const { m, col } = solidMix;
    for (let i = 0; i < n; i++) if (m[i] > 0) for (let c = 0; c < 3; c++) base[i * 3 + c] += (col[i * 3 + c] - base[i * 3 + c]) * m[i];
  }
  const fill = base;
  // textura: el alto-paso del fondo, trasplantado por baldosas desde zonas limpias y cercanas
  if (detail > 0) {
    const T = Math.max(16, Math.round(0.03 * diag) & ~1); // ≈64 px a 1080p
    const half = T >> 1;
    const r = Math.max(2, Math.round(0.0025 * diag));
    const low = [0, 1, 2].map((c) => {
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) ch[i] = rgb[i * 3 + c];
      return boxBlur(ch, W, H, r, 3);
    });
    // integrales para validar baldosas fuente: píxeles del hueco/cerca, oscuros, energía de detalle
    const bad = new Float32Array(n);
    const en = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bad[i] = dHole[i] < 4 || Y[i] < darkT ? 1 : 0;
      const dl = Y[i] - (0.299 * low[0][i] + 0.587 * low[1][i] + 0.114 * low[2][i]);
      en[i] = dl * dl;
    }
    const integ = (src) => {
      const I = new Float64Array((W + 1) * (H + 1));
      for (let y = 0; y < H; y++) {
        let s = 0;
        for (let x = 0; x < W; x++) {
          s += src[y * W + x];
          I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s;
        }
      }
      return I;
    };
    const Ib = integ(bad);
    const Ie = integ(en);
    const Iy = integ(Y);
    const box = (I, x, y, w, h) => I[(y + h) * (W + 1) + x + w] - I[y * (W + 1) + x + w] - I[(y + h) * (W + 1) + x] + I[y * (W + 1) + x];
    const stride = Math.max(4, T >> 2);
    const cands = [];
    for (let y = 0; y + T <= H; y += stride)
      for (let x = 0; x + T <= W; x += stride) {
        if (box(Ib, x, y, T, T) > 0) continue;
        cands.push({ x, y, e: box(Ie, x, y, T, T) / (T * T), l: box(Iy, x, y, T, T) / (T * T) });
      }
    if (cands.length) {
      const es = cands.map((c) => c.e).sort((a, b) => a - b);
      const eMed = es[es.length >> 1];
      const pool = cands.filter((c) => c.e <= 2.5 * eMed + 1);
      const rand = rng(seed);
      const acc = new Float32Array(n * 3);
      const accW = new Float32Array(n);
      const win = new Float32Array(T);
      for (let k = 0; k < T; k++) win[k] = Math.sin((Math.PI * (k + 0.5)) / T) ** 2;
      for (let ty = -half; ty < H; ty += half)
        for (let tx = -half; tx < W; tx += half) {
          // ¿la baldosa toca el hueco?
          const x0 = Math.max(0, tx);
          const y0 = Math.max(0, ty);
          const x1 = Math.min(W, tx + T);
          const y1 = Math.min(H, ty + T);
          if (x1 <= x0 || y1 <= y0) continue;
          let touches = false;
          for (let y = y0; y < y1 && !touches; y += 2) for (let x = x0; x < x1; x += 2) if (hole[y * W + x]) { touches = true; break; }
          if (!touches) continue;
          // luminancia objetivo (del relleno base) en el centro de la baldosa
          const cx = Math.min(W - 1, Math.max(0, tx + half));
          const cy = Math.min(H - 1, Math.max(0, ty + half));
          const ci = cy * W + cx;
          const tl = 0.299 * fill[ci * 3] + 0.587 * fill[ci * 3 + 1] + 0.114 * fill[ci * 3 + 2];
          // las K mejores fuentes (cerca y de brillo parecido); se elige una al azar para no repetir
          const K = 6;
          const topS = new Float64Array(K).fill(Infinity);
          const topC = new Array(K).fill(null);
          for (const c of pool) {
            const dx = c.x + half - cx;
            const dy = c.y + half - cy;
            const s = (Math.sqrt(dx * dx + dy * dy) / diag) * 4 + Math.abs(c.l - tl) / 40;
            if (s >= topS[K - 1]) continue;
            let k = K - 1;
            while (k > 0 && topS[k - 1] > s) {
              topS[k] = topS[k - 1];
              topC[k] = topC[k - 1];
              k--;
            }
            topS[k] = s;
            topC[k] = c;
          }
          const got = topC.filter(Boolean);
          const best = got[Math.floor(rand() * got.length)];
          // contraste del detalle según el brillo (el ruido escala con la luz)
          const gain = detail * Math.min(1.5, Math.max(0.3, (tl + 8) / (best.l + 8))) * Math.min(1, Math.max(0, (tl - darkT) / (0.5 * darkT)));
          for (let y = y0; y < y1; y++) {
            const wy = win[y - ty];
            const sy = best.y + (y - ty);
            for (let x = x0; x < x1; x++) {
              const i = y * W + x;
              if (!hole[i]) continue;
              const w = wy * win[x - tx];
              const si = sy * W + best.x + (x - tx);
              for (let c = 0; c < 3; c++) acc[i * 3 + c] += w * gain * (rgb[si * 3 + c] - low[c][si]);
              accW[i] += w;
            }
          }
        }
      for (let i = 0; i < n; i++) if (hole[i] && accW[i] > 0) for (let c = 0; c < 3; c++) fill[i * 3 + c] += acc[i * 3 + c] / accW[i];
    }
  }
  // grano fino para que no quede plástico
  if (grain > 0) {
    const rand = rng(seed + 1);
    for (let i = 0; i < n; i++) if (hole[i]) {
      const yl = 0.299 * fill[i * 3] + 0.587 * fill[i * 3 + 1] + 0.114 * fill[i * 3 + 2];
      const g = (rand() + rand() + rand() - 1.5) * 2 * grain * Math.min(1, Math.max(0, yl / darkT - 0.5));
      for (let c = 0; c < 3; c++) fill[i * 3 + c] += g;
    }
  }
  // borde del hueco fundido unos px con el original
  const dIn = distanceTo(Uint8Array.from(hole, (v) => 1 - v), W, H);
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = hole[i] ? Math.min(1, dIn[i] / 3) : 0;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(rgb[i * 3 + c] * (1 - f) + fill[i * 3 + c] * f)));
  }
  return out;
}

// ---------- viñetas por capas (PNGs + scene_layout.json exportados de un PSD) ----------
// Una escena del layout → un asset { type: 'layers', w, h, file (preview compuesta), layers: [...] } con roles,
// profundidad, clipTo (personajes cortados por el borde de su viñeta) y orden automáticos.
// Devuelve las decisiones para imprimir la tabla. Ver references/scene-format.md, "Viñetas por capas".

// alfa de una capa volcado a un buffer del tamaño del lienzo (lo que cae fuera del lienzo se descarta)
// px de alfa (>= 16) dentro del lienzo y su centroide en px del lienzo
function alphaStats(A, W, H) {
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0, i = y * W; x < W; x++, i++)
      if (A[i] >= 16) {
        area++;
        sx += x;
        sy += y;
      }
  return { area, cx: area ? sx / area : W / 2, cy: area ? sy / area : H / 2 };
}

// ---------- alias semánticos de capas (tags) ----------
// Heurística (ver references/scene-format.md, "Tags"):
//   hero      personaje principal: max(área de alfa · (0.75 + 0.5·cercanía) · (1 − 0.6·distancia al centro)),
//             cercanía 0 = el de más atrás … 1 = el de más adelante; distancia del centroide al centro del
//             lienzo normalizada a la media diagonal. Así gana el más grande/cercano y, a igual tamaño, el centrado.
//   char-1..n personajes de atrás hacia adelante (depth, luego z)
//   bg-main   el fondo no global con más área; bg-far el global/lejano (depth mínima) si es otro
//   fx-front  el fx de más adelante · text-1..n textos en orden de lectura (sin adornos) · divider los divisores
// `layers`: capas del asset con role/depth/z/x/y/w/h y `stats` { area, cx, cy } por id.
export function computeLayerTags(layers, W, H, stats) {
  const tags = Object.fromEntries(layers.map((l) => [l.id, []]));
  const st = (l) => stats[l.id] || { area: 0, cx: l.x + l.w / 2, cy: l.y + l.h / 2 };
  const chars = layers.filter((l) => l.role === 'character').sort((a, b) => (a.depth ?? 1) - (b.depth ?? 1) || a.z - b.z);
  chars.forEach((l, i) => tags[l.id].push(`char-${i + 1}`));
  if (chars.length) {
    const half = Math.hypot(W, H) / 2;
    const score = (l, i) => {
      const s = st(l);
      const near = chars.length > 1 ? i / (chars.length - 1) : 1;
      const dist = Math.min(1, Math.hypot(s.cx - W / 2, s.cy - H / 2) / half);
      return (s.area / (W * H)) * (0.75 + 0.5 * near) * (1 - 0.6 * dist);
    };
    let best = 0;
    chars.forEach((l, i) => {
      if (score(l, i) > score(chars[best], best)) best = i;
    });
    tags[chars[best].id].unshift('hero');
  }
  const bgs = layers.filter((l) => l.role === 'background');
  const main = [...bgs.filter((l) => !l.global)].sort((a, b) => st(b).area - st(a).area)[0] || bgs.find((l) => l.global);
  if (main) tags[main.id].push('bg-main');
  const far = bgs.filter((l) => l !== main).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || !!b.global - !!a.global || st(b).area - st(a).area)[0];
  if (far && (!main || (far.depth ?? 0) <= (main.depth ?? 0))) tags[far.id].push('bg-far');
  const fx = layers.filter((l) => l.role === 'fx').sort((a, b) => (b.depth ?? 1) - (a.depth ?? 1) || b.z - a.z)[0];
  if (fx) tags[fx.id].push('fx-front');
  const texts = layers.filter((l) => l.role === 'text' && !l.attachedTo);
  readingOrder(texts).forEach((l, i) => tags[l.id].push(`text-${i + 1}`));
  for (const l of layers) if (l.role === 'divider') tags[l.id].push('divider');
  return tags;
}

// Escribe tags en las capas del asset sin pisar lo editado a mano: `tagsAuto` guarda la última propuesta
// automática; si `tags` difiere de ella, alguien lo editó y se conserva (salvo `reset`).
// Devuelve [{ id, tags, auto, kept }].
export function applyLayerTags(asset, auto, { prev = null, reset = false } = {}) {
  const prevById = new Map((prev?.layers || []).map((l) => [l.id, l]));
  const out = [];
  const isEdited = (old) => !reset && Array.isArray(old.tags) && JSON.stringify(old.tags) !== JSON.stringify(old.tagsAuto || []);
  // un tag puesto a mano en una capa se saca de las propuestas automáticas de las demás (ej. @hero a mano)
  const manual = new Set(asset.layers.flatMap((l) => (isEdited(prevById.get(l.id) || l) ? (prevById.get(l.id) || l).tags : [])));
  for (const l of asset.layers) {
    const old = prevById.get(l.id) || l;
    const a = auto[l.id] || [];
    const edited = isEdited(old);
    // tagsAuto = lo que se propuso automáticamente para ESTA capa (ya sin los tags tomados a mano por otra)
    l.tagsAuto = edited ? a : a.filter((t) => !manual.has(t));
    l.tags = edited ? old.tags : l.tagsAuto;
    if (!l.tags.length) delete l.tags;
    if (!l.tagsAuto.length) delete l.tagsAuto;
    out.push({ id: l.id, tags: l.tags || [], auto: a, kept: edited });
  }
  return out;
}

// `comic tags`: recalcula los tags de un asset de capas ya ingestado (lee el alfa de los PNG).
export async function retagLayersAsset(project, asset, { reset = false } = {}) {
  const W = asset.w;
  const H = asset.h;
  const stats = {};
  for (const l of asset.layers) {
    if (!['character', 'background'].includes(l.role)) continue;
    stats[l.id] = alphaStats(await canvasAlpha(path.join(project.dir, l.file), l.x, l.y, W, H), W, H);
  }
  await annotateAssetBounds(project.dir, asset); // de paso: datos de límites de cámara (alfa, capas sólidas)
  return applyLayerTags(asset, computeLayerTags(asset.layers, W, H, stats), { reset });
}

async function canvasAlpha(file, x, y, W, H) {
  const { data, info } = await sharp(file).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(W * H);
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(W, x + info.width);
  const y1 = Math.min(H, y + info.height);
  for (let yy = y0; yy < y1; yy++) {
    const src = (yy - y) * info.width + (x0 - x);
    out.set(data.subarray(src, src + (x1 - x0)), yy * W + x0);
  }
  return out;
}

// borde: píxeles >= thr con algún vecino (4) < thr; el borde del lienzo no cuenta como borde
function edgeMap(A, W, H, thr = 128) {
  const E = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (A[i] < thr) continue;
      if ((x > 0 && A[i - 1] < thr) || (x < W - 1 && A[i + 1] < thr) || (y > 0 && A[i - W] < thr) || (y < H - 1 && A[i + W] < thr)) E[i] = 1;
    }
  return E;
}

// dilatación binaria con un cuadrado de lado 2r+1 (dos pasadas con conteo corrido)
function dilate(B, W, H, r) {
  if (r <= 0) return B;
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    const row = y * W;
    for (let x = 0; x < Math.min(W, r); x++) c += B[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) c += B[row + x + r];
      if (x - r - 1 >= 0) c -= B[row + x - r - 1];
      tmp[row + x] = c > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < Math.min(H, r); y++) c += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) c += tmp[(y + r) * W + x];
      if (y - r - 1 >= 0) c -= tmp[(y - r - 1) * W + x];
      out[y * W + x] = c > 0 ? 1 : 0;
    }
  }
  return out;
}
const erode = (B, W, H, r) => {
  const inv = new Uint8Array(B.length);
  for (let i = 0; i < B.length; i++) inv[i] = B[i] ? 0 : 1;
  const d = dilate(inv, W, H, r);
  for (let i = 0; i < d.length; i++) d[i] = d[i] ? 0 : 1;
  return d;
};

// Título para un proyecto nuevo creado desde un scene_layout.json (comic layers sin init): el title/name del
// layout si lo trae; si no, el nombre del PSD de origen (source) sin extensión ni guiones bajos.
export function layoutTitle(layoutFile) {
  try {
    const doc = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    const t = doc.title || doc.name || (doc.source ? path.basename(String(doc.source)).replace(/\.[a-z0-9]+$/i, '') : '');
    const clean = String(t || '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean) return clean;
  } catch {}
  return path.basename(path.dirname(path.resolve(layoutFile)));
}

export async function ingestLayers(project, scene, layoutFile, { exclude = [], makeScenes = false, log = console.log } = {}) {
  const srcDir = path.dirname(path.resolve(layoutFile));
  const doc = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const byFile = {};
  const walk = (nodes, group) => {
    for (const n of nodes) {
      if (n.children) walk(n.children, n.id || n.name);
      else if (n.file) byFile[n.file] = { ...n, group };
    }
  };
  walk(doc.layers || [], null);
  const excluded = (n) => exclude.some((e) => e && (n.id.toLowerCase().includes(e.toLowerCase()) || String(n.name).toLowerCase().includes(e.toLowerCase())));
  const results = [];
  for (const sc of doc.scenes || []) {
    const assetId = slug(sc.scene);
    const outDir = path.join(project.dir, 'assets', 'layers', assetId);
    const globDir = path.join(project.dir, 'assets', 'layers', '_global');
    fs.mkdirSync(outDir, { recursive: true });
    const L = [];
    for (const f of sc.draw_order) {
      const n = byFile[f];
      if (!n) throw new Error(`draw_order menciona ${f}, que no está en el árbol de capas`);
      if (excluded(n)) continue;
      const src = path.join(srcDir, f);
      if (!fs.existsSync(src)) throw new Error(`no existe ${src}`);
      const dest = path.join(n.group ? outDir : globDir, path.basename(f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      if (n.opacity != null && n.opacity !== 1) log(`⚠ ${n.id}: opacidad ${n.opacity} (se ignora: el motor dibuja normal, opacidad 1)`);
      if (n.blend_mode && n.blend_mode !== 'normal') log(`⚠ ${n.id}: modo ${n.blend_mode} (se dibuja normal)`);
      L.push({ id: n.id, name: n.name, file: path.relative(project.dir, dest), src, x: n.position.x, y: n.position.y, w: n.size.w, h: n.size.h, z: n.z_index, global: !n.group });
    }
    // alfas en coords del lienzo
    for (const l of L) {
      l.A = await canvasAlpha(l.src, l.x, l.y, W, H);
      Object.assign(l, alphaStats(l.A, W, H));
      const area = l.area;
      const bx = Math.max(0, Math.min(W, l.x + l.w) - Math.max(0, l.x));
      const by = Math.max(0, Math.min(H, l.y + l.h) - Math.max(0, l.y));
      l.coverage = (bx * by) / (W * H);
      l.fill = bx * by ? area / (bx * by) : 0;
    }
    // roles: nombre → tamaño/cobertura
    for (const l of L) {
      l.role = roleFromName(l.id) || roleFromName(l.name);
      l.why = l.role ? 'nombre' : '';
      if (!l.role && l.coverage > 0.35 && l.fill > 0.8) {
        l.role = 'background';
        l.why = `cubre ${(l.coverage * 100).toFixed(0)}% del lienzo`;
      }
    }
    // adornos pegados a un texto (ej. ornament sobre el cartel): ≥70 % de su alfa dentro del texto (±40 px)
    const texts0 = L.filter((l) => l.role === 'text');
    for (const l of L) {
      if (l.role || l.area > 0.03 * W * H) continue;
      for (const t of texts0) {
        const [x0, y0, x1, y1] = [t.x - 40, t.y - 40, t.x + t.w + 40, t.y + t.h + 40];
        let inside = 0;
        for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) if (l.A[y * W + x] >= 16) inside++;
        if (inside >= 0.7 * l.area) {
          l.role = 'text';
          l.attachedTo = t.id;
          l.why = `pegado a ${t.id}`;
          break;
        }
      }
    }
    for (const l of L) if (!l.role) (l.role = 'character'), (l.why = 'resto');
    // profundidad
    const bgs = L.filter((l) => l.role === 'background' && !l.global);
    for (const l of L) {
      if (l.role === 'background') l.depth = l.global ? GLOBAL_BG_DEPTH : ROLE_DEPTH.background;
      else if (l.role === 'text' || l.role === 'fx' || l.role === 'guide') l.depth = ROLE_DEPTH[l.role];
    }
    const chars = L.filter((l) => l.role === 'character').sort((a, b) => a.z - b.z);
    const [c0, c1] = CHARACTER_DEPTH_RANGE;
    chars.forEach((l, i) => (l.depth = +(chars.length > 1 ? c0 + ((c1 - c0) * i) / (chars.length - 1) : c1).toFixed(3)));
    const overlap = (a, b) => {
      let n = 0;
      for (let i = 0; i < a.A.length; i++) if (a.A[i] >= 16 && b.A[i] >= 16) n++;
      return n;
    };
    for (const l of L.filter((x) => x.role === 'divider')) {
      // pegado a la viñeta que más toca (con su alfa engordado 12 px)
      const D = dilate(Uint8Array.from(l.A, (v) => (v >= 16 ? 1 : 0)), W, H, 12);
      let best = null;
      let bestN = 0;
      for (const b of bgs) {
        let n = 0;
        for (let i = 0; i < D.length; i++) if (D[i] && b.A[i] >= 16) n++;
        if (n > bestN) (bestN = n), (best = b);
      }
      l.depth = best ? best.depth : ROLE_DEPTH.divider;
      l.dividerOf = best?.id || null;
    }
    // clipTo: el personaje está cortado contra su viñeta. Dos formas de corte:
    //  (a) contorno que coincide con el borde alfa del fondo (±2 px, recorte con la misma máscara);
    //  (b) contorno pegado por dentro al borde del fondo (≤14 px) o escondido bajo un divisor (corte a mano).
    // La ventana de recorte vive en el plano del fondo: alfa del fondo ∪ divisores ∪ lo que ya asomaba afuera
    // a propósito (engordado 40 px), así el parallax no deja ver el corte pero no se come los break-outs.
    const divA = new Uint8Array(W * H);
    for (const d of L.filter((x) => x.role === 'divider')) for (let i = 0; i < divA.length; i++) if (d.A[i] > divA[i]) divA[i] = d.A[i];
    const bgInfo = new Map();
    for (const b of bgs) {
      const E = edgeMap(b.A, W, H);
      bgInfo.set(b.id, { band: dilate(E, W, H, 2), wide: dilate(E, W, H, 14), near: dilate(Uint8Array.from(b.A, (v) => (v >= 32 ? 1 : 0)), W, H, 60) });
    }
    for (const c of chars) {
      const E = edgeMap(c.A, W, H);
      let edgeN = 0;
      for (let i = 0; i < E.length; i++) edgeN += E[i];
      c.clip = { edge: edgeN, best: null };
      for (const b of bgs) {
        const { band, wide, near } = bgInfo.get(b.id);
        let cutA = 0;
        let cutB = 0;
        let solid = 0;
        let out = 0;
        for (let i = 0; i < E.length; i++) {
          if (E[i]) {
            if (band[i] && b.A[i] >= 32) cutA++;
            else if ((wide[i] && b.A[i] >= 32) || (divA[i] >= 128 && near[i])) cutB++;
          }
          if (c.A[i] >= 128) {
            solid++;
            if (b.A[i] < 128) out++;
          }
        }
        const cut = cutA + cutB;
        const m = { bg: b.id, cut, cutMask: cutA, cutRect: cutB, f: +(edgeN ? cut / edgeN : 0).toFixed(3), outside: +(solid ? out / solid : 0).toFixed(3) };
        if (!c.clip.best || cut > c.clip.best.cut) c.clip.best = m;
      }
      const m = c.clip.best;
      if (m && (m.cut >= 500 || (m.cutMask >= 120 && m.f >= 0.05))) {
        c.clipTo = m.bg;
        const b = bgs.find((x) => x.id === m.bg);
        let brk = new Uint8Array(W * H);
        for (let i = 0; i < brk.length; i++) brk[i] = c.A[i] >= 128 && b.A[i] < 32 && divA[i] < 32 ? 1 : 0;
        brk = dilate(erode(brk, W, H, 3), W, H, 43);
        let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
        let brkN = 0;
        const win = new Uint8Array(W * H);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const base = Math.max(b.A[i], divA[i]);
            const v = brk[i] ? 255 : base;
            if (brk[i] && base < 32 && c.A[i] >= 128) brkN++;
            win[i] = v;
            if (v) {
              if (x < bx0) bx0 = x;
              if (x > bx1) bx1 = x;
              if (y < by0) by0 = y;
              if (y > by1) by1 = y;
            }
          }
        const mw = bx1 - bx0 + 1;
        const mh = by1 - by0 + 1;
        const crop = new Uint8Array(mw * mh);
        for (let y = 0; y < mh; y++) crop.set(win.subarray((by0 + y) * W + bx0, (by0 + y) * W + bx0 + mw), y * mw);
        const mf = path.join(outDir, `${c.id}.clip.png`);
        await sharp(Buffer.from(crop), { raw: { width: mw, height: mh, channels: 1 } }).png({ compressionLevel: 9 }).toFile(mf);
        c.clipMask = { for: m.bg, file: path.relative(project.dir, mf), x: bx0, y: by0, w: mw, h: mh };
        c.breakout = brkN;
      }
    }
    // textos: suben arriba de todo salvo que se solapen con algo que en el PSD va encima
    const byZdesc = [...L].sort((a, b) => b.z - a.z);
    const lifted = new Set();
    for (const t of byZdesc) {
      if (t.role !== 'text') continue;
      const blockers = L.filter((o) => o.z > t.z && o.role !== 'guide' && !lifted.has(o.id) && overlap(t, o) > 30);
      if (blockers.length) {
        t.keepOrder = true;
        t.blockedBy = blockers.map((o) => o.id);
      } else lifted.add(t.id);
    }
    // preview compuesta (sin guías) para miniaturas, hoja de contacto y respaldo DOM sin GPU
    const comp = [];
    for (const l of L) {
      if (l.role === 'guide') continue;
      const ex = { left: Math.max(0, -l.x), top: Math.max(0, -l.y) };
      ex.width = Math.min(l.w - ex.left, W - Math.max(0, l.x));
      ex.height = Math.min(l.h - ex.top, H - Math.max(0, l.y));
      if (ex.width <= 0 || ex.height <= 0) continue;
      comp.push({ input: await sharp(l.src).ensureAlpha().extract(ex).toBuffer(), left: Math.max(0, l.x), top: Math.max(0, l.y) });
    }
    const previewFile = path.join(outDir, '_preview.png');
    await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comp).png().toFile(previewFile);
    const prev = scene.assets[assetId];
    const asset = {
      ...(prev && prev.type === 'layers' ? { description: prev.description, focus: prev.focus } : {}),
      type: 'layers',
      file: path.relative(project.dir, previewFile),
      w: W,
      h: H,
      layers: L.map((l) => {
        const o = { id: l.id, name: l.name, file: l.file, x: l.x, y: l.y, w: l.w, h: l.h, z: l.z, role: l.role, depth: l.depth };
        if (l.global) o.global = true;
        if (l.clipTo) o.clipTo = l.clipTo;
        if (l.clipMask) o.clipMask = l.clipMask;
        if (l.attachedTo) o.attachedTo = l.attachedTo;
        if (l.keepOrder) o.keepOrder = true;
        if (l.role === 'text') o.area = l.area;
        return o;
      }),
      source: { layout: path.resolve(layoutFile), scene: sc.scene, psd: doc.source || null, preview: sc.preview ? path.join(srcDir, sc.preview) : null },
    };
    for (const k of Object.keys(asset)) if (asset[k] === undefined) delete asset[k];
    await annotateAssetBounds(project.dir, asset); // bbox del alfa y capas de un solo color (límites de cámara)
    // alias semánticos (@hero, @bg-main, …); conserva los tags editados a mano de una ingesta anterior
    const tagInfo = applyLayerTags(asset, computeLayerTags(asset.layers, W, H, Object.fromEntries(L.map((l) => [l.id, { area: l.area, cx: l.cx, cy: l.cy }]))), { prev: prev?.type === 'layers' ? prev : null });
    const tagsOf = Object.fromEntries(tagInfo.map((t) => [t.id, t]));
    scene.assets[assetId] = asset;
    let sceneId = null;
    if (makeScenes) sceneId = addLayersScene(scene, assetId, asset);
    results.push({ assetId, sceneId, asset, decisions: L.map((l) => ({ id: l.id, role: l.role, why: l.why, depth: l.depth, clipTo: l.clipTo || null, clip: l.clip?.best || null, breakout: l.breakout || 0, keepOrder: !!l.keepOrder, blockedBy: l.blockedBy, attachedTo: l.attachedTo, dividerOf: l.dividerOf, global: l.global, tags: tagsOf[l.id]?.tags || [], tagsKept: !!tagsOf[l.id]?.kept })) });
    for (const l of L) delete l.A;
  }
  return results;
}

// Escena nueva con la viñeta de capas ocupando la página (sin borde ni sombra) y la duración de los textos.
function addLayersScene(scene, assetId, asset) {
  const W = scene.meta.width;
  const H = scene.meta.height;
  const res = resolveLayers(asset, {}, 60);
  let end = 3;
  for (const r of res) if (r.role === 'text' && !r.hidden) end = Math.max(end, r.at + 0.4 + 0.25 * (wordsOf(r) || 2));
  const duration = Math.max(4, Math.ceil((end + 1.5) * 2) / 2);
  let id = assetId;
  let n = 2;
  while ((scene.scenes || []).some((s) => s.id === id)) id = `${assetId}_${n++}`;
  scene.scenes.push({
    id,
    title: asset.source?.scene || assetId,
    active: 'v1',
    variants: [
      {
        id: 'v1',
        status: 'draft',
        summary: `Viñeta por capas ${assetId}`,
        duration,
        stage: { w: W, h: H, background: '#000000' },
        transition: { preset: 'fade', duration: 0.4, ease: 'easeInOut', params: {} },
        clips: [{ id: 'p1', track: 'panel', label: assetId, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset: 'panel', start: 0, duration, params: { asset: assetId, rect: [0, 0, W, H], border: 0, shadow: false } }] }],
      },
    ],
  });
  return id;
}
