// Datos de píxeles para los límites de cámara (bounds.js): se miden una vez en node (sharp) y quedan en el asset,
// así el player, move3d y `comic check --gaps` usan los mismos números sin leer imágenes.
//   capa de un asset `layers`: alpha [x, y, w, h] (bbox del alfa ≥ 16 en px del lienzo, solo si es más chico que el
//                              bbox de la capa), solid '#rrggbb' (capa de un solo color, p. ej. el negro de la página)
//                              grid { cell, cols, rows, rle (base64) }: celdas del bbox del alfa con dibujo, y
//                              hull { n, rows, cols }: contorno por franjas (min/max del dibujo en cada franja)
//   asset `image`:             edges { color, band: [izq, arriba, der, abajo], n, bands } (px del asset de la franja
//                              pareja de ese color en cada borde —mínimo por lado y por tramos, base64 Int16—: la
//                              canaleta/marco dibujado de la propia imagen)
//   asset (los dos tipos):     bounds { v, measured (ISO), files: { <file>: 'size:mtimeMs:sha1[@x,y]' } }: marca de
//                              "medido" y huella de cada archivo. Con ella el player sabe que hay datos aunque no
//                              haya marco liso, `comic check` avisa si un PNG cambió a mano y `comic tags` recalcula
//                              solo lo que cambió.
// Ver "Cámara 3D (move3d) y límites" en references/scene-format.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

// versión de los datos de píxeles: subirla hace que `comic tags` recalcule todo y `comic check` avise.
// 2: grilla del alfa hasta 128 celdas por lado (RLE) y marca `bounds` con huellas.
export const BOUNDS_V = 2;
// grilla del alfa: hasta GRID_MAX celdas en el lado largo, celdas de GRID_MIN_CELL px como mínimo
export const GRID_MAX = 128;
const GRID_MIN_CELL = 4;

const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const close = (d, i, c, tol) => Math.abs(d[i] - c[0]) <= tol && Math.abs(d[i + 1] - c[1]) <= tol && Math.abs(d[i + 2] - c[2]) <= tol;

// color más frecuente (cuantizado a 4 bits por canal) entre los píxeles que pasan `use(i)`; devuelve el promedio real de ese balde
function dominant(data, n, use) {
  const hist = new Map();
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (!use(i)) continue;
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let best = -1;
  let bn = 0;
  let tot = 0;
  for (const [k, c] of hist) {
    tot += c;
    if (c > bn) (bn = c), (best = k);
  }
  if (best < 0) return null;
  let s = [0, 0, 0];
  let m = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (!use(i)) continue;
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    if (k !== best) continue;
    s[0] += data[i];
    s[1] += data[i + 1];
    s[2] += data[i + 2];
    m++;
  }
  return { rgb: s.map((v) => v / m), share: bn / tot, count: tot };
}

// Grilla en RLE: largos de corridas alternadas (empieza con celdas vacías), varint LEB128, en base64. Las
// grillas son manchas grandes: a 128 celdas ocupa menos que los bits crudos a 64. Decodifica bounds.js (gridHas).
function encodeRuns(bits, n) {
  const out = [];
  const put = (v) => {
    while (v > 127) {
      out.push((v & 127) | 128);
      v >>>= 7;
    }
    out.push(v);
  };
  let cur = 0;
  let run = 0;
  for (let c = 0; c < n; c++) {
    const b = (bits[c >> 3] >> (c & 7)) & 1;
    if (b === cur) run++;
    else {
      put(run);
      cur = b;
      run = 1;
    }
  }
  put(run);
  return Buffer.from(out).toString('base64');
}

// Capa (PNG): bbox del alfa y color sólido.
export async function layerPixelInfo(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0, i = y * w * 4 + 3; x < w; x++, i += 4)
      if (data[i] >= 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { alpha: [0, 0, 0, 0], solid: null, empty: true };
  const alpha = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  // grilla del alfa (≤ GRID_MAX celdas en el lado largo, celdas de ≥ 4 px) sobre el bbox del alfa: celda con dibujo
  // = ≥ 2 % de sus píxeles con α ≥ 128. Sin grilla si todas tienen dibujo (un rect lleno). Sirve para no tomar como
  // "dibujo" los triángulos transparentes de una viñeta inclinada ni el aire de un PNG con mucho margen.
  const cell = Math.max(GRID_MIN_CELL, Math.ceil(Math.max(alpha[2], alpha[3]) / GRID_MAX));
  const cols = Math.ceil(alpha[2] / cell);
  const rows = Math.ceil(alpha[3] / cell);
  const cnt = new Uint32Array(cols * rows);
  for (let y = y0; y <= y1; y++)
    for (let x = x0, i = (y * w + x0) * 4 + 3; x <= x1; x++, i += 4) if (data[i] >= 128) cnt[(((y - y0) / cell) | 0) * cols + (((x - x0) / cell) | 0)]++;
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8));
  let full = true;
  for (let c = 0; c < cols * rows; c++) {
    const cx = c % cols;
    const cy = (c - cx) / cols;
    const area = Math.min(cell, alpha[2] - cx * cell) * Math.min(cell, alpha[3] - cy * cell);
    if (cnt[c] >= Math.max(1, 0.02 * area)) bits[c >> 3] |= 1 << (c & 7);
    else full = false;
  }
  const grid = full ? null : { cell, cols, rows, rle: encodeRuns(bits, cols * rows) };
  // contorno por franjas (48 filas y 48 columnas sobre el bbox del alfa): [min, max] de x con dibujo en cada franja
  // de filas y de y en cada franja de columnas, relativos al bbox. Da el borde real (inclinado, curvo) de la capa
  // con ~2 % del lado de error: con eso se sabe si el borde de la caja corta el dibujo o solo el aire de al lado.
  const NB = 48;
  const rx = new Int32Array(NB * 2).fill(-1);
  const cy = new Int32Array(NB * 2).fill(-1);
  for (let y = y0; y <= y1; y++) {
    const rb = Math.min(NB - 1, (((y - y0) * NB) / alpha[3]) | 0);
    for (let x = x0, i = (y * w + x0) * 4 + 3; x <= x1; x++, i += 4) {
      if (data[i] < 128) continue;
      const cb = Math.min(NB - 1, (((x - x0) * NB) / alpha[2]) | 0);
      const u = x - x0;
      const v = y - y0;
      if (rx[rb * 2] < 0 || u < rx[rb * 2]) rx[rb * 2] = u;
      if (u + 1 > rx[rb * 2 + 1]) rx[rb * 2 + 1] = u + 1; // fin exclusivo
      if (cy[cb * 2] < 0 || v < cy[cb * 2]) cy[cb * 2] = v;
      if (v + 1 > cy[cb * 2 + 1]) cy[cb * 2 + 1] = v + 1;
    }
  }
  // en base64 (Int16 little endian): en scene.json con sangría una lista de 192 números ocuparía 192 líneas
  const b64 = (a) => Buffer.from(Int16Array.from(a).buffer).toString('base64');
  const hull = full ? null : { n: NB, rows: b64(rx), cols: b64(cy) };
  // sólida: ≥ 99.5 % de los píxeles opacos (α ≥ 128) a ±12 del color dominante
  const d = dominant(data, w * h, (i) => data[i + 3] >= 128);
  let solid = null;
  if (d && d.count > 0) {
    let okN = 0;
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (data[i + 3] >= 128 && close(data, i, d.rgb, 12)) okN++;
    }
    if (okN >= 0.995 * d.count) solid = hex(...d.rgb);
  }
  return { alpha, solid, grid, hull, size: [w, h] };
}

// Imagen plana: franja pareja de un color en cada borde (canaleta, marco negro de la página), por tramos: cada lado
// en 48 tramos y, en cada uno, cuántas columnas/filas desde el borde tienen ≥ 98 % de píxeles de ese color (±16,
// opacos). Así una página con un personaje que rompe el marco en un lado sigue teniendo marco en el resto.
export const EDGE_SEGS = 48;
export async function imageEdgeInfo(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const ring = (i) => {
    const p = i / 4;
    const x = p % w;
    const y = (p - x) / w;
    return data[i + 3] >= 250 && (x < 2 || y < 2 || x >= w - 2 || y >= h - 2);
  };
  const d = dominant(data, w * h, ring);
  if (!d || d.share < 0.5) return null;
  const c = d.rgb;
  const good = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i + 3] >= 250 && close(data, i, c, 16);
  };
  const N = EDGE_SEGS;
  const bands = new Int16Array(4 * N);
  // lado: 0 izq (columnas x, a lo largo de y), 1 arriba, 2 der, 3 abajo
  for (let side = 0; side < 4; side++) {
    const vert = side === 0 || side === 2;
    const len = vert ? h : w;
    const depthMax = Math.floor((vert ? w : h) / 3);
    for (let sg = 0; sg < N; sg++) {
      const a0 = Math.floor((sg * len) / N);
      const a1 = Math.floor(((sg + 1) * len) / N);
      let dd = 0;
      for (; dd < depthMax; dd++) {
        let ok = 0;
        for (let a = a0; a < a1; a++) {
          const x = side === 0 ? dd : side === 2 ? w - 1 - dd : a;
          const y = side === 1 ? dd : side === 3 ? h - 1 - dd : a;
          if (good(x, y)) ok++;
        }
        if (ok < 0.98 * (a1 - a0)) break;
      }
      bands[side * N + sg] = dd;
    }
  }
  if (!bands.some((v) => v > 0)) return null;
  const band = [0, 1, 2, 3].map((sd) => Math.min(...bands.subarray(sd * N, sd * N + N)));
  return { color: hex(...c), band, n: N, bands: Buffer.from(bands.buffer).toString('base64') };
}

// ---------- huellas (marca de "medido" y datos desactualizados) ----------
// Huella de un archivo: tamaño, mtime y sha1 (12 hex). Para saber si cambió alcanza con tamaño + mtime; si el mtime
// difiere (copia del proyecto, git checkout) se compara el sha1, así una copia no cuenta como cambio.
export function fileFingerprint(abs) {
  const st = fs.statSync(abs);
  const h = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex').slice(0, 12);
  return `${st.size}:${Math.round(st.mtimeMs)}:${h}`;
}
// rec: 'size:mtime:hash' (+ '@x,y' en capas: la posición en el lienzo, porque `alpha` va en px del lienzo).
// Devuelve null si cambió, o la huella vigente (con el mtime actual si solo cambió el mtime).
function freshRecord(abs, rec, place = '') {
  if (typeof rec !== 'string') return null;
  const [fp, at = ''] = rec.split('@');
  if (at !== place) return null;
  const [size, mtime, hash] = fp.split(':');
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (String(st.size) !== size) return null;
  if (String(Math.round(st.mtimeMs)) === mtime) return rec;
  const now = fileFingerprint(abs);
  return now.split(':')[2] === hash ? now + (place ? '@' + place : '') : null;
}
const placeOf = (l) => `${l.x},${l.y}`;
// archivos que mide annotateAssetBounds: [{ key (archivo), abs, place, layer? }]
function measuredFiles(projectDir, asset) {
  if (asset?.type === 'layers') return (asset.layers || []).filter((l) => l.role !== 'guide' && l.file).map((l) => ({ key: l.file, abs: path.join(projectDir, l.file), place: placeOf(l), layer: l }));
  if (asset?.type === 'image' && asset.file) return [{ key: asset.file, abs: path.join(projectDir, asset.file), place: '' }];
  return [];
}
// ¿El asset tiene datos de píxeles de una versión sin huellas (antes de `bounds`)?
const legacyData = (a) => !!(a?.edges || (a?.layers || []).some((l) => l.alpha || l.solid || l.grid));

// Estado de los datos de límites de un asset (para `comic check`):
//   { state: 'ok' | 'none' (nunca se midió) | 'legacy' (medido sin huellas o con otra versión) | 'stale', files: [] }
export function boundsStatus(projectDir, asset) {
  const list = measuredFiles(projectDir, asset);
  if (!list.length) return { state: 'ok', files: [] };
  const b = asset.bounds;
  if (!b || typeof b !== 'object' || !b.files) return { state: legacyData(asset) ? 'legacy' : 'none', files: [] };
  if (b.v !== BOUNDS_V) return { state: 'legacy', files: [] };
  const stale = list.filter((f) => !freshRecord(f.abs, b.files[f.key], f.place)).map((f) => f.key);
  return { state: stale.length ? 'stale' : 'ok', files: stale };
}

// Avisos de `comic check` por datos de bordes desactualizados (un PNG reemplazado a mano, datos de otra versión).
export function boundsWarnings(projectDir, assets) {
  const out = [];
  for (const [id, a] of Object.entries(assets || {})) {
    if (a?.type !== 'layers' && a?.type !== 'image') continue;
    const s = boundsStatus(projectDir, a);
    if (s.state === 'stale') out.push(`datos de bordes desactualizados para ${id} (${s.files.join(', ')} cambió desde la última medición): corré comic tags`);
    else if (s.state === 'legacy') out.push(`datos de bordes desactualizados para ${id} (medidos con una versión anterior): corré comic tags`);
  }
  return out;
}

// Completa (o recalcula) los datos de límites de un asset. Muta el asset. Solo mide los archivos que cambiaron desde
// la última medición (huella en asset.bounds); force: todos. report (opcional): { measured: [], kept: [] }.
// Devuelve: capas → [{ id, alpha, solid, grid, kept }]; imagen → edges (o null).
export async function annotateAssetBounds(projectDir, asset, { force = false, report = null } = {}) {
  const prev = asset?.bounds && asset.bounds.v === BOUNDS_V && asset.bounds.files ? asset.bounds.files : null;
  const files = {};
  let changed = false;
  const reuse = (f) => {
    if (force || !prev) return null;
    return freshRecord(f.abs, prev[f.key], f.place);
  };
  if (asset?.type === 'layers') {
    const out = [];
    for (const f of measuredFiles(projectDir, asset)) {
      const l = f.layer;
      const kept = reuse(f);
      if (kept) {
        files[f.key] = kept;
        if (kept !== prev[f.key]) changed = true;
        report?.kept.push(l.id);
        out.push({ id: l.id, alpha: l.alpha || null, solid: l.solid || null, grid: !!l.grid, kept: true });
        continue;
      }
      let info;
      try {
        info = await layerPixelInfo(f.abs);
        files[f.key] = fileFingerprint(f.abs) + '@' + f.place;
      } catch {
        continue;
      }
      changed = true;
      report?.measured.push(l.id);
      const [ax, ay, aw, ah] = info.alpha;
      if (!info.empty && (ax > 0 || ay > 0 || aw < l.w || ah < l.h)) l.alpha = [l.x + ax, l.y + ay, aw, ah];
      else delete l.alpha;
      if (info.solid) l.solid = info.solid;
      else delete l.solid;
      // grilla del alfa solo donde decide algo: fondos, personajes, fx y divisores (no textos ni sólidas)
      if (info.grid && !info.solid && l.role !== 'text') {
        l.grid = info.grid;
        l.hull = info.hull;
      } else {
        delete l.grid;
        delete l.hull;
      }
      out.push({ id: l.id, alpha: l.alpha || null, solid: l.solid || null, grid: !!l.grid, kept: false });
    }
    setBounds(asset, files, changed || !prev || Object.keys(prev).length !== Object.keys(files).length);
    return out;
  }
  if (asset?.type === 'image') {
    const [f] = measuredFiles(projectDir, asset);
    const kept = f && reuse(f);
    if (kept) {
      report?.kept.push(asset.file);
      setBounds(asset, { [f.key]: kept }, kept !== prev[f.key]);
      return asset.edges || null;
    }
    try {
      const e = await imageEdgeInfo(f.abs);
      if (e) asset.edges = e;
      else delete asset.edges;
      report?.measured.push(asset.file);
      setBounds(asset, { [f.key]: fileFingerprint(f.abs) }, true);
    } catch {
      /* sin datos: los límites se evalúan como 'panel' */
    }
    return asset.edges || null;
  }
  return null;
}

// marca de "medido": la fecha solo cambia si se midió algo (así `comic tags` sin cambios no ensucia scene.json)
function setBounds(asset, files, changed) {
  if (!Object.keys(files).length) return;
  const measured = changed || !asset.bounds?.measured ? new Date().toISOString() : asset.bounds.measured;
  asset.bounds = { v: BOUNDS_V, measured, files };
}
