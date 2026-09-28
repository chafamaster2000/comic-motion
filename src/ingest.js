// Ingesta de material: copia al proyecto, mide, genera proxies de video, hojas de contacto,
// detección de viñetas (opencv.js) y recorte de personajes (transformers.js + BiRefNet).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import sharp from 'sharp';

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
  // out es RGBA con el alfa del sujeto; lo guardamos al tamaño original
  const buf = Buffer.from(out.data);
  await sharp(buf, { raw: { width: out.width, height: out.height, channels: out.channels } })
    .resize(a.w, a.h, { fit: 'fill' })
    .png()
    .toFile(outFile);
  a.cutout = path.relative(project.dir, outFile);
  return { file: a.cutout, model };
}
