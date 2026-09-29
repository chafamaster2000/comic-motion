// Ingesta de material: copia al proyecto, mide, genera proxies de video, hojas de contacto,
// detección de viñetas (opencv.js) y recorte de personajes (transformers.js + BiRefNet).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import sharp from 'sharp';
import { roleFromName, ROLE_DEPTH, GLOBAL_BG_DEPTH, CHARACTER_DEPTH_RANGE, resolveLayers, wordsOf } from './player/layers.js';

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
  const fill = path.join(project.dir, 'assets', `${assetId}.bgfill.png`);
  await fillBackground(file, outFile, fill);
  a.bgfill = path.relative(project.dir, fill);
  return { file: a.cutout, bgfill: a.bgfill, model };
}

// Fondo sin personajes para la profundidad 2.5D: rellena el hueco del recorte con los colores
// del entorno (convolución normalizada a varias escalas). Así, cuando la capa del frente se mueve,
// lo que asoma es fondo difuso y no una copia nítida del personaje.
export async function fillBackground(file, cutoutFile, outFile) {
  const { width: W, height: H } = await sharp(file).metadata();
  const sw = Math.max(64, Math.round(W / 4));
  const sh = Math.max(64, Math.round(H / 4));
  const img = await sharp(file).removeAlpha().resize(sw, sh).raw().toBuffer();
  const alpha = await sharp(cutoutFile).ensureAlpha().extractChannel(3).resize(sw, sh).raw().toBuffer();
  const n = sw * sh;
  // máscara dilatada (~24px a escala completa) para tapar también el borde del personaje
  let m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = alpha[i] > 25 ? 1 : 0;
  m = boxBlur(m, sw, sh, 6, 1);
  const K = new Float32Array(n);
  for (let i = 0; i < n; i++) K[i] = m[i] > 0.02 ? 0 : 1;
  const fill = new Float32Array(n * 3);
  const done = new Uint8Array(n);
  for (const r of [6, 16, 40, 100]) {
    const B = boxBlur(K, sw, sh, r, 3);
    const A = [0, 1, 2].map((c) => {
      const ch = new Float32Array(n);
      for (let i = 0; i < n; i++) ch[i] = img[i * 3 + c] * K[i];
      return boxBlur(ch, sw, sh, r, 3);
    });
    for (let i = 0; i < n; i++) {
      if (done[i] || B[i] < 0.05) continue;
      for (let c = 0; c < 3; c++) fill[i * 3 + c] = A[c][i] / B[i];
      done[i] = 1;
    }
  }
  let mean = [0, 0, 0];
  let cnt = 0;
  for (let i = 0; i < n; i++) if (K[i]) { for (let c = 0; c < 3; c++) mean[c] += img[i * 3 + c]; cnt++; }
  mean = mean.map((v) => v / Math.max(1, cnt));
  const small = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) small[i * 4 + c] = Math.max(0, Math.min(255, Math.round(done[i] ? fill[i * 3 + c] : mean[c])));
    small[i * 4 + 3] = Math.round((1 - K[i]) * 255); // solo donde había personaje
  }
  // relleno escalado y suavizado, pegado sobre el original solo en la zona del personaje
  const patch = await sharp(small, { raw: { width: sw, height: sh, channels: 4 } }).resize(W, H).blur(6).png().toBuffer();
  await sharp(file).removeAlpha().composite([{ input: patch }]).png().toFile(outFile);
}

// Blur de caja separable repetido (≈ gaussiano), O(n) por pasada.
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

// ---------- viñetas por capas (PNGs + scene_layout.json exportados de un PSD) ----------
// Una escena del layout → un asset { type: 'layers', w, h, file (preview compuesta), layers: [...] } con roles,
// profundidad, clipTo (personajes cortados por el borde de su viñeta) y orden automáticos.
// Devuelve las decisiones para imprimir la tabla. Ver references/scene-format.md, "Viñetas por capas".

// alfa de una capa volcado a un buffer del tamaño del lienzo (lo que cae fuera del lienzo se descarta)
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
      let area = 0;
      for (let i = 0; i < l.A.length; i++) if (l.A[i] >= 16) area++;
      l.area = area;
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
    scene.assets[assetId] = asset;
    let sceneId = null;
    if (makeScenes) sceneId = addLayersScene(scene, assetId, asset);
    results.push({ assetId, sceneId, asset, decisions: L.map((l) => ({ id: l.id, role: l.role, why: l.why, depth: l.depth, clipTo: l.clipTo || null, clip: l.clip?.best || null, breakout: l.breakout || 0, keepOrder: !!l.keepOrder, blockedBy: l.blockedBy, attachedTo: l.attachedTo, dividerOf: l.dividerOf, global: l.global })) });
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
