// Límites de cámara: lógica pura (sin three ni DOM). Dice si el cuadro queda cubierto en cada instante.
// La usan el preset move3d (para no pasarse nunca), `comic check --gaps` y el rig de capas (gpu/layers.js),
// que toma de acá la matemática de la cámara 3D: una sola fuente de números.
//
// Afines 2D como arrays [a, b, c, d, e, f] (convención DOMMatrix: x' = a x + c y + e, y' = b x + d y + f).
//
// Cámara 3D de una viñeta por capas (ver "Cámara 2D → cámara 3D" en references/scene-format.md):
//   G = cam · [L.k, 0, 0, L.k, ox + L.left, oy + L.top]     lienzo (plano focal) → cuadro, sin la caja
//   s = √|det G| · C = G⁻¹(W/2, H/2) · D = max(D0·s0/s · dist, D0·(0.15 − zmin))
//   ojo E = (C.x + D·tan yaw, C.y + D·tan pitch, −D)
// Un punto X del mundo a profundidad Zw (px del lienzo) se ve en el plano focal en P = E + (X − E)·D/(D + Zw),
// y una capa a Z (unidades de D0) pone su punto p del lienzo en X = c0 + (p − c0)·(1 + Z).
// Todo el mapa cuadro → capa es afín (Zw constante por plano): la cobertura se chequea analíticamente.
import { mediaLayout, panelView, layerLayout } from './media.js';
import { resolveLayers, layerState, orbitAt } from './layers.js';

// ---------- afines ----------
export const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
export const T = (x, y) => [1, 0, 0, 1, x, y];
export const S = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const R = (deg) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
export const det = (m) => m[0] * m[3] - m[1] * m[2];
export function inv(m) {
  const d = det(m);
  if (!(Math.abs(d) > 1e-300)) return null;
  const [a, b, c, dd, e, f] = m;
  return [dd / d, -b / d, -c / d, a / d, (c * f - dd * e) / d, (b * e - a * f) / d];
}
export const ap = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
// DOMMatrix (o cualquier {a..f}) → array
export const affOf = (M) => (Array.isArray(M) ? M : [M.a, M.b, M.c, M.d, M.e, M.f]);

// ---------- cámara 2D ----------
// Vista por defecto de una escena (la del player sin clips de cámara).
export function defaultView(stage, W, H) {
  return { cx: stage.w / 2, cy: stage.h / 2, w: Math.max(stage.w, stage.h * (W / H)), rotate: 0 };
}

// Cámara compuesta { view, dx, dy, drot, dzoom } → afín página → cuadro (= sref.cam del player).
export function cameraAffine(c, W, H) {
  const v = c.view;
  const sc = (W / v.w) * (c.dzoom ?? 1);
  const rot = (v.rotate || 0) + (c.drot || 0);
  return mul(mul(mul(T(W / 2 + (c.dx || 0), H / 2 + (c.dy || 0)), R(rot)), S(sc)), T(-v.cx, -v.cy));
}

// ---------- cámara 3D (compartida con gpu/layers.js) ----------
// campo visual vertical de la cámara en reposo (solo importa para la órbita: el parallax por paneo y
// dolly depende de Z/D0, que ya es adimensional)
export const FOV_DEG = 30;
export const FOCAL_K = 1 / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
export const NEAR_K = 0.15; // la cámara nunca se acerca más que (NEAR_K − zmin)·D0

// Reposo: la cámara que encuadra la viñeta entera (sin ken burns).
// rect: rect de la viñeta en la página; layout0: mediaLayout sin zoom; origin: esquina de la caja interior.
export function restEye({ W, H, rect, layout0, origin }) {
  const [rx, ry, rw, rh] = rect;
  const vw = Math.max(rw, rh * (W / H));
  const sc = W / vw;
  const cam0 = mul(mul(T(W / 2, H / 2), S(sc)), T(-(rx + rw / 2), -(ry + rh / 2)));
  const L0 = layout0;
  const [ox, oy] = origin;
  const G0 = mul(cam0, [L0.k, 0, 0, L0.k, ox + L0.left, oy + L0.top]);
  const s0 = Math.sqrt(Math.abs(det(G0)));
  const c0 = ap(inv(G0), W / 2, H / 2);
  const D0 = (FOCAL_K * H) / s0; // px del lienzo
  return { cam0, G0, s0, c0, D0 };
}

// Ojo 3D a partir de la cámara 2D: centro C (eje óptico, px del lienzo), escala s, distancia D, ojo (Cx, Cy).
// dist: factor extra de distancia (dolly zoom de move3d; 1 = la distancia sale del zoom); orbit [yaw, pitch] °.
export function eyeFor({ W, H, cam, layout, origin, rest, zmin = 0, orbit = [0, 0], dist = 1 }) {
  const L = layout;
  const [ox, oy] = origin;
  const G = mul(affOf(cam), [L.k, 0, 0, L.k, ox + L.left, oy + L.top]);
  const dG = det(G);
  const s = Math.sqrt(Math.abs(dG)) || rest.s0;
  const C = Math.abs(dG) > 1e-12 ? ap(inv(G), W / 2, H / 2) : rest.c0;
  let D = ((rest.D0 * rest.s0) / s) * (dist || 1);
  const Dmin = rest.D0 * (-zmin + NEAR_K);
  const clamped = D < Dmin;
  D = Math.max(D, Dmin);
  const [yaw, pitch] = orbit || [0, 0];
  const Cx = C[0] + D * Math.tan((yaw * Math.PI) / 180);
  const Cy = C[1] + D * Math.tan((pitch * Math.PI) / 180);
  return { C, s, D, Cx, Cy, clamped };
}

// Afín lienzo-de-la-capa (px del asset, antes de su motion) → plano focal, para una capa a Z (unidades de D0).
// Inversa del recorrido del rayo: X = c0 + g(p − c0), P = E + (X − E)·D/(D + Zw).
export function planeToFocal(eye, rest, Z) {
  const g = 1 + Z;
  const Zw = Z * rest.D0;
  const q = eye.D / (eye.D + Zw);
  const [c0x, c0y] = rest.c0;
  // P = E(1−q) + q·(c0(1−g) + g p)
  return [q * g, 0, 0, q * g, eye.Cx * (1 - q) + q * c0x * (1 - g), eye.Cy * (1 - q) + q * c0y * (1 - g)];
}

// ---------- geometría de viñetas ----------
// p: params de la viñeta (con o sin defaults), asset, stage. Devuelve lo que no depende del tiempo.
export function panelModel({ id, params = {}, asset = null, start = 0, duration = 4, stage, W, H }) {
  const p = params || {};
  const rect = p.rect || [0, 0, stage.w, stage.h];
  const b = p.border ?? 8;
  const inner = [rect[2] - 2 * b, rect[3] - 2 * b];
  const origin = [rect[0] + b, rect[1] + b];
  const m = { id, p, asset, rect, border: b, inner, origin, start, duration, layers: null };
  if (asset && asset.w && asset.h) {
    const focus = p.focus || asset.focus || [0.5, 0.5];
    m.layout0 = mediaLayout(asset, p.crop, inner[0], inner[1], 1, focus[0], focus[1]);
  }
  if (asset?.type === 'layers' && m.layout0) {
    m.layers = resolveLayers(asset, p, duration);
    m.rest = restEye({ W, H, rect, layout0: m.layout0, origin });
  }
  return m;
}

// Transformación de la caja (padding box) → página: tilt alrededor del centro de la caja.
export function boxToPage(m) {
  const [x, y, w, h] = m.rect;
  const b = m.border;
  return mul(mul(T(x + w / 2, y + h / 2), R(m.p.tilt || 0)), T(-w / 2 + b, -h / 2 + b));
}

// Layout del plano focal en el tiempo local de la viñeta (ken burns incluido).
export function panelLayoutAt(m, t) {
  const view = panelView(m.p, m.asset, m.duration, t);
  return layerLayout(m.asset, m.p.crop, m.inner[0], m.inner[1], { ...view, dp: 0 }, 0);
}

// ¿La caja está entrando/saliendo (enter/exit de la viñeta)? En esos tramos los bordes son a propósito.
export function panelSettled(m, t) {
  if (t < 0 || t >= m.duration) return false;
  const spec = (s, d) => (!s ? 0 : typeof s === 'string' ? (s === 'none' ? 0 : d) : s.preset && s.preset !== 'none' ? s.duration ?? d : 0);
  const din = spec(m.p.enter, 0.4);
  const dout = spec(m.p.exit, 0.3);
  return t >= din && t <= m.duration - dout;
}

// ---------- polígonos ----------
// recorte de un polígono convexo contra el rect [x0,y0,x1,y1] (Sutherland–Hodgman)
export function clipPoly(poly, [x0, y0, x1, y1]) {
  let out = poly;
  const edges = [
    [(p) => p[0] >= x0, (a, b) => lerpAt(a, b, (x0 - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= x1, (a, b) => lerpAt(a, b, (x1 - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= y0, (a, b) => lerpAt(a, b, (y0 - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= y1, (a, b) => lerpAt(a, b, (y1 - a[1]) / (b[1] - a[1]))],
  ];
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}
const lerpAt = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function insideConvex(poly, p) {
  const sg = Math.sign(polyArea(poly)) || 1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (sg * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) < -1e-9) return false;
  }
  return true;
}

// puntos de muestra de un polígono convexo: vértices, bordes subdivididos y una grilla interior
export function samplePoly(poly, edgeN = 12, grid = [7, 5]) {
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    for (let k = 0; k < edgeN; k++) pts.push(lerpAt(a, b, k / edgeN));
  }
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (let i = 1; i < grid[0]; i++)
    for (let j = 1; j < grid[1]; j++) {
      const p = [x0 + ((x1 - x0) * i) / grid[0], y0 + ((y1 - y0) * j) / grid[1]];
      if (insideConvex(poly, p)) pts.push(p);
    }
  return pts;
}

const SIDES = ['left', 'right', 'top', 'bottom'];
export const SIDE_ES = { left: 'izquierdo', right: 'derecho', top: 'superior', bottom: 'inferior' };

// Holgura con signo (px del cuadro) de un punto local dentro de rect: >0 adentro, <0 afuera; y el lado peor.
function slack(pl, [x, y, w, h], k) {
  const d = [pl[0] - x, x + w - pl[0], pl[1] - y, y + h - pl[1]];
  let i = 0;
  for (let j = 1; j < 4; j++) if (d[j] < d[i]) i = j;
  return { px: d[i] * k, side: SIDES[i] };
}

// Cobertura de una región (polígono en px del cuadro) por la unión de formas. Cada forma:
//   { id, toLocal: afín cuadro → local, rect: [x,y,w,h] local, k: px del cuadro por px local }
// Devuelve { margin (px del cuadro; <0 = se ve un hueco de ese tamaño), worst: { id, side, px, at } }.
export function coverage(region, shapes, samples = null) {
  const pts = samples || samplePoly(region);
  let margin = Infinity;
  let worst = null;
  for (const P of pts) {
    let best = null;
    for (const sh of shapes) {
      const pl = ap(sh.toLocal, P[0], P[1]);
      let s = slack(pl, sh.rect, sh.k);
      // dentro del bbox pero en una celda sin dibujo (grid): no cubre (hueco de ~media celda)
      if (s.px > 0 && sh.layer && !gridHas(sh.layer, pl[0], pl[1])) s = { px: -0.5 * sh.layer.grid.cell * sh.k, side: s.side };
      if (!best || s.px > best.px) best = { ...s, id: sh.id };
    }
    if (!best) best = { px: -Infinity, side: null, id: null };
    if (best.px < margin) {
      margin = best.px;
      worst = { ...best, at: P };
    }
  }
  return { margin: pts.length ? margin : Infinity, worst };
}

// Margen por lado de una forma (px del cuadro, negativo = ese borde entra en cuadro).
export function sideMargins(region, sh) {
  const out = { left: Infinity, right: Infinity, top: Infinity, bottom: Infinity };
  const [x, y, w, h] = sh.rect;
  for (const P of region) {
    const [u, v] = ap(sh.toLocal, P[0], P[1]);
    out.left = Math.min(out.left, (u - x) * sh.k);
    out.right = Math.min(out.right, (x + w - u) * sh.k);
    out.top = Math.min(out.top, (v - y) * sh.k);
    out.bottom = Math.min(out.bottom, (y + h - v) * sh.k);
  }
  return out;
}

// ---------- vista segura de una viñeta ----------
// Rect de una capa para los límites: el bbox del alfa real si se midió (`alpha`, lo escriben `comic layers` y
// `comic tags`), si no el bbox de la capa (un PNG con mucho margen transparente puede dar un falso "cubierto").
export const layerRect = (r) => (Array.isArray(r.alpha) && r.alpha.length === 4 ? r.alpha : [r.x, r.y, r.w, r.h]);

// Grilla gruesa del alfa (`grid`, sobre layerRect): ¿hay dibujo en el punto local (u, v)? Sin grilla: sí.
function decodeBits(b64) {
  if (typeof atob === 'function') return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
export function gridHas(r, u, v) {
  const g = r.grid;
  if (!g || !g.bits) return true;
  const hl = r.hull;
  if (hl && hl.n && !r._hull) {
    const i16 = (b) => {
      const u8 = decodeBits(b);
      return new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
    };
    Object.defineProperty(r, '_hull', { value: { n: hl.n, rows: typeof hl.rows === 'string' ? i16(hl.rows) : hl.rows, cols: typeof hl.cols === 'string' ? i16(hl.cols) : hl.cols }, enumerable: false });
  }
  if (r._hull) {
    const hl = r._hull;
    const [hx, hy, hw, hh] = layerRect(r);
    const rb = Math.floor(((v - hy) * hl.n) / hh);
    const cb = Math.floor(((u - hx) * hl.n) / hw);
    if (rb >= 0 && rb < hl.n) {
      const a = hl.rows[rb * 2];
      if (a < 0 || u - hx < a || u - hx > hl.rows[rb * 2 + 1]) return false;
    }
    if (cb >= 0 && cb < hl.n) {
      const a = hl.cols[cb * 2];
      if (a < 0 || v - hy < a || v - hy > hl.cols[cb * 2 + 1]) return false;
    }
  }
  if (!r._bits) Object.defineProperty(r, '_bits', { value: decodeBits(g.bits), enumerable: false });
  const [x, y] = layerRect(r);
  const cx = Math.floor((u - x) / g.cell);
  const cy = Math.floor((v - y) / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return false;
  const c = cy * g.cols + cx;
  return !!(r._bits[c >> 3] & (1 << (c & 7)));
}

// Planos de una viñeta por capas en el tiempo local t, como formas del cuadro:
//   shapes: fondos que cubren (rol background, opacidad ≥ 0.5); texts: textos visibles; all: toda capa visible
//   (orden de dibujo, para ver qué corta el borde de la caja). Cada texto trae `rest`: sus esquinas en el cuadro
//   sin la animación de entrada/salida (keepText mide el texto ya asentado, no el pop).
// cam: afín página → cuadro. eye3d: { dist, orbit, dof } extra de la cámara (move3d).
export function layerShapes({ W, H, m, cam, t, eye3d = {} }) {
  const L = panelLayoutAt(m, t);
  const Mbox = mul(affOf(cam), boxToPage(m));
  const A = mul(Mbox, [L.k, 0, 0, L.k, L.left, L.top]); // lienzo (plano focal) → cuadro
  const vis = m.layers.filter((r) => !r.hidden);
  const zmin = Math.min(0, ...vis.map((r) => r.Z));
  const po = orbitAt(m.p.orbit, t, m.duration);
  const eo = eye3d.orbit || [0, 0];
  const eye = eyeFor({ W, H, cam, layout: L, origin: m.origin, rest: m.rest, zmin, orbit: [po[0] + eo[0], po[1] + eo[1]], dist: eye3d.dist ?? 1 });
  const sA = Math.sqrt(Math.abs(det(A)));
  const shapes = [];
  const texts = [];
  const all = [];
  for (const r of vis) {
    const st = layerState(r, t, m.duration);
    if (!st.visible) continue;
    const plane = planeToFocal(eye, m.rest, r.Z);
    const toFocal = mul(plane, st.m); // local de la capa → plano focal
    const toFrame = mul(A, toFocal);
    const k = sA * Math.sqrt(Math.abs(det(toFocal)));
    const rect = layerRect(r);
    const sh = { id: r.id, role: r.role, Z: r.Z, rect, toFrame, toLocal: inv(toFrame), k, opacity: st.opacity, solid: r.solid || null, layer: r.grid ? r : null, settled: layerSettled(r, t, m.duration), at: r.at || 0, since: t - (r.at || 0) };
    if (r.role === 'background' && st.opacity >= 0.5) shapes.push(sh);
    if (r.role === 'text') {
      const still = layerState({ ...r, enter: null, exit: null }, t, m.duration);
      const Mr = mul(A, mul(plane, still.m));
      sh.rest = rectCorners(rect).map(([x, y]) => ap(Mr, x, y));
      texts.push(sh);
    }
    if (st.opacity > 0.02) all.push(sh);
  }
  return { shapes, texts, all, A, Mbox, eye, L };
}
const rectCorners = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// la capa ya terminó de entrar (y no está saliendo): recién ahí un texto cortado es un error
function layerSettled(r, t, dur) {
  const lt = t - (r.at || 0);
  const d = r.dur > 0 ? r.dur : Math.max(0, dur - (r.at || 0));
  const din = r.enter ? r.enter.duration ?? 0.4 : 0;
  const dout = r.exit ? r.exit.duration ?? 0.3 : 0;
  return lt >= din && lt <= d - dout;
}

// Región visible de la caja de una viñeta: su interior en px del cuadro, recortado al cuadro.
export function boxRegion({ W, H, m, cam }) {
  const Mbox = mul(affOf(cam), boxToPage(m));
  const [iw, ih] = m.inner;
  const poly = [[0, 0], [iw, 0], [iw, ih], [0, ih]].map(([x, y]) => ap(Mbox, x, y));
  return clipPoly(poly, [0, 0, W, H]);
}

// ---------- qué cuenta como hueco (bounds) ----------
// 'art'   (default) solo es hueco lo que se ve roto: vacío/transparencia dentro de la caja (los fondos no cubren)
//         o, fuera de la caja, el corte recto de algo dibujado. Mirar fuera de la viñeta NO es hueco si lo que
//         toca ese borde de la caja es el marco de la propia página: una capa sólida (`solid`) o la franja pareja
//         de una imagen plana (`edges`) del MISMO color que el fondo del escenario (stage.background /
//         meta.background). Los lados de la caja que se ven en reposo son diseño (página con varias viñetas) y no
//         cuentan. Sin datos de color (`comic tags` los mide) cae a 'panel' en esos lados.
// 'panel' la vista no sale del rect de las viñetas en pantalla (su unión).
// 'page'  la vista no sale de la página (stage).
// En los tres, en una viñeta por capas los fondos tienen que cubrir la parte visible de la caja.
export const BOUNDS = ['art', 'panel', 'page'];

// color CSS simple → [r,g,b] (#rgb, #rrggbb, black/white); null si no se entiende
export function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  if (s === 'black') return [0, 0, 0];
  if (s === 'white') return [255, 255, 255];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return null;
}
export function sameColor(a, b, tol = 24) {
  const x = parseColor(a);
  const y = parseColor(b);
  return !!(x && y) && Math.abs(x[0] - y[0]) <= tol && Math.abs(x[1] - y[1]) <= tol && Math.abs(x[2] - y[2]) <= tol;
}

// distancia de P hacia adentro del cuadro (negativa = afuera)
const inFrame = (P, W, H) => Math.min(P[0], W - P[0], P[1], H - P[1]);
// cuánto se ve desde P hacia afuera (dirección n unitaria) hasta el borde del cuadro
function rayToFrame(P, n, W, H) {
  let s = Infinity;
  if (n[0] > 1e-9) s = Math.min(s, (W - P[0]) / n[0]);
  if (n[0] < -1e-9) s = Math.min(s, -P[0] / n[0]);
  if (n[1] > 1e-9) s = Math.min(s, (H - P[1]) / n[1]);
  if (n[1] < -1e-9) s = Math.min(s, -P[1] / n[1]);
  return Number.isFinite(s) ? Math.max(0, s) : 0;
}
const BOX_SIDES = [
  ['top', 0, 1, [0, -1]],
  ['right', 1, 2, [1, 0]],
  ['bottom', 2, 3, [0, 1]],
  ['left', 3, 0, [-1, 0]],
];

// Lados de la caja de una viñeta que NO se ven con la vista por defecto (se tapan con el borde del cuadro): solo
// esos pueden ser un "corte" al mirar fuera. Los que se ven en reposo son el diseño de la página.
function hiddenSides(m, { W, H, stage }) {
  if (m._hidden) return m._hidden;
  const cam = cameraAffine({ view: defaultView(stage, W, H) }, W, H);
  const M = mul(cam, boxToPage(m));
  const [iw, ih] = m.inner;
  const c = [[0, 0], [iw, 0], [iw, ih], [0, ih]].map(([x, y]) => ap(M, x, y));
  m._hidden = BOX_SIDES.filter(([, i, j]) => {
    const pts = [c[i], c[j], [(c[i][0] + c[j][0]) / 2, (c[i][1] + c[j][1]) / 2]];
    return pts.every((P) => inFrame(P, W, H) <= 1);
  }).map((s) => s[0]);
  return m._hidden;
}

// ¿El punto (px de la imagen) cae en la franja pareja (marco) del borde más cercano de una imagen plana?
export function inEdgeBand(a, u, v) {
  const e = a.edges;
  if (!e) return false;
  // distancia a cada borde y posición a lo largo de ese borde (0..1)
  const sides = [[u, v / a.h], [v, u / a.w], [a.w - u, v / a.h], [a.h - v, u / a.w]];
  let best = 0;
  for (let i = 1; i < 4; i++) if (sides[i][0] < sides[best][0]) best = i;
  const [dist, along] = sides[best];
  if (dist < 0) return true; // fuera de la imagen: no hay dibujo que cortar
  let depth = e.band?.[best] ?? 0;
  if (e.bands && e.n) {
    if (!a._bands) Object.defineProperty(a, '_bands', { value: (() => {
      const u8 = decodeBits(e.bands);
      return new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
    })(), enumerable: false });
    depth = a._bands[best * e.n + Math.min(e.n - 1, Math.max(0, Math.floor(along * e.n)))];
  }
  return dist <= depth;
}

// ¿Tiene la viñeta datos para decidir si su marco es "página"? (capas: alguna capa sólida; plana: edges)
export function hasFrameData(m) {
  if (m.layers) return m.layers.some((r) => r.solid);
  return !!m.asset?.edges;
}

// Corte en el borde de la caja (modo 'art'): muestrea los lados ocultos en reposo que entran en cuadro y mira qué
// hay justo adentro. Limpio = capa sólida del color del escenario (o nada: eso lo ve la cobertura) / franja pareja
// de la imagen del mismo color. Devuelve { px (≤ 0: ancho de lo que se ve afuera en la parte sucia), side, id }.
function boxEdgeCut({ W, H, stage, m, cam, lt, ls, stageColor }) {
  const hidden = hiddenSides(m, { W, H, stage });
  if (!hidden.length) return null;
  const Mbox = mul(affOf(cam), boxToPage(m));
  const [iw, ih] = m.inner;
  const corners = [[0, 0], [iw, 0], [iw, ih], [0, ih]].map(([x, y]) => ap(Mbox, x, y));
  let toImg = null;
  if (!m.layers && m.asset?.w) {
    const L = panelLayoutAt(m, lt);
    toImg = inv(mul(Mbox, [L.k, 0, 0, L.k, L.left, L.top]));
  }
  const edges = !m.layers && m.asset?.edges && sameColor(m.asset.edges.color, stageColor) ? m.asset.edges : null;
  const topFirst = ls ? [...ls.all].reverse() : null;
  const hasData = hasFrameData(m);
  let worst = null;
  const N = 24;
  for (const [side, i, j, nl] of BOX_SIDES) {
    if (!hidden.includes(side)) continue;
    const A = corners[i];
    const B = corners[j];
    // normal hacia afuera en el cuadro (parte lineal de Mbox)
    let n = [Mbox[0] * nl[0] + Mbox[2] * nl[1], Mbox[1] * nl[0] + Mbox[3] * nl[1]];
    const nn = Math.hypot(n[0], n[1]) || 1;
    n = [n[0] / nn, n[1] / nn];
    for (let q = 0; q <= N; q++) {
      const P = [A[0] + ((B[0] - A[0]) * q) / N, A[1] + ((B[1] - A[1]) * q) / N];
      if (inFrame(P, W, H) <= 0.5) continue;
      const Pin = [P[0] - 1.5 * n[0], P[1] - 1.5 * n[1]];
      let dirty = null;
      let depth = Infinity;
      if (topFirst) {
        for (const sh of topFirst) {
          const pl = ap(sh.toLocal, Pin[0], Pin[1]);
          const s = slack(pl, sh.rect, sh.k);
          if (s.px <= 0 || (sh.layer && !gridHas(sh.layer, pl[0], pl[1]))) continue;
          if (!(sh.solid && sameColor(sh.solid, stageColor))) {
            dirty = hasData ? sh.id : m.id;
            // cuánto dibujo queda cortado (px del cuadro): se avanza hacia afuera en el plano de la capa
            if (hasData) depth = cutDepth(sh, pl, n);
          }
          break;
        }
      } else if (toImg) {
        const [u, v] = ap(toImg, Pin[0], Pin[1]);
        if (!(edges && inEdgeBand(m.asset, u, v))) dirty = m.id;
      } else dirty = m.id;
      if (!dirty) continue;
      // lo que se ve: el corte recto mide lo que se ve afuera o lo que falta del dibujo, lo menor
      const px = -Math.min(rayToFrame(P, n, W, H), depth);
      if (px > -0.5) continue;
      if (!worst || px < worst.px) worst = { px, side, id: dirty };
    }
  }
  return worst;
}

// Profundidad (px del cuadro) del dibujo de una capa más allá de un punto del borde de la caja, hacia afuera (n,
// dirección en el cuadro): lo que la caja le corta. Pasos de ~2 px de la capa, hasta 600 px del cuadro.
function cutDepth(sh, pl, n) {
  const L = sh.toLocal;
  let d = [L[0] * n[0] + L[2] * n[1], L[1] * n[0] + L[3] * n[1]];
  const dn = Math.hypot(d[0], d[1]) || 1;
  d = [d[0] / dn, d[1] / dn];
  const k = sh.k || 1;
  const step = Math.max(1, 2 / Math.max(1e-6, k));
  const [x, y, w, h] = sh.rect;
  let s = 0;
  for (; s * k < 600; s += step) {
    const u = pl[0] + d[0] * s;
    const v = pl[1] + d[1] * s;
    if (u < x || v < y || u > x + w || v > y + h) break;
    if (sh.layer && !gridHas(sh.layer, u, v)) break;
  }
  return s * k;
}

// Margen de los textos visibles (keepText): cuánto les sobra a sus esquinas (ya asentadas) hasta el borde del
// cuadro, menos `want` px. <0 = el texto no entra entero con ese margen. want puede ser un número o id → número.
export function textMargins(texts, W, H, want = 24) {
  let margin = Infinity;
  let worst = null;
  for (const tx of texts) {
    const w = typeof want === 'function' ? want(tx.id) : want;
    if (w == null) continue;
    for (const [x, y] of tx.rest || []) {
      for (const [d, side] of [[x, 'left'], [W - x, 'right'], [y, 'top'], [H - y, 'bottom']]) {
        const mg = d - w;
        if (mg < margin) {
          margin = mg;
          worst = { id: tx.id, side, px: d };
        }
      }
    }
  }
  return { margin, worst };
}

// Vista segura en un instante. ctx:
//   { W, H, stage, panels: [panelModel], camera: { view, dx, dy, drot, dzoom, dist?, orbit? }, t (local de la escena),
//     fullBleed?: bool (la escena en reposo está cubierta por viñetas), bounds?: 'art'|'panel'|'page' (default 'art'),
//     stageColor?: color del escenario, texts?: bool (check: textos cortados), keepText?: px | (id) → px | null }
// Devuelve { ok, margin (px del cuadro; negativo = se ve un hueco de ese tamaño), textMargin, textWorst, issues }.
// issue: { kind: 'edge'|'page'|'text', id, side, px, msg }
export function safeView(ctx) {
  const { W, H, stage, panels, camera, t } = ctx;
  const mode = BOUNDS.includes(ctx.bounds) ? ctx.bounds : 'art';
  const stageColor = ctx.stageColor ?? stage?.background ?? null;
  const cam = cameraAffine(camera, W, H);
  const frame = [[0, 0], [W, 0], [W, H], [0, H]];
  const issues = [];
  let margin = Infinity;
  let textMargin = Infinity;
  let textWorst = null;
  const on = panels.filter((m) => t >= m.start && t < m.start + m.duration);
  if (on.some((m) => !panelSettled(m, t - m.start))) return { ok: true, margin: Infinity, textMargin, issues, skipped: 'entrada/salida de viñeta' };
  const camInv = inv(cam);
  const sc = Math.sqrt(Math.abs(det(cam)));
  // 1) plano: 'page' = dentro de la página; 'panel' = dentro de las viñetas (o de la página si no están a sangre,
  //    como siempre); 'art' = por viñeta, más abajo (y 'panel' en las que no tienen datos de color)
  const flatOf = (list) => {
    const fc = coverage(frame, list);
    margin = Math.min(margin, fc.margin);
    if (fc.margin < -0.5) issues.push({ kind: 'page', id: fc.worst.id, side: fc.worst.side, px: fc.margin, msg: `se ve fuera de ${fc.worst.id === 'página' ? 'la página' : 'la viñeta ' + fc.worst.id} (borde ${SIDE_ES[fc.worst.side]}, ${fmtPx(fc.margin)})` });
  };
  const pageShape = { id: 'página', rect: [0, 0, stage.w, stage.h], toLocal: camInv, k: sc };
  if (mode === 'page') flatOf([pageShape]);
  else if (mode === 'panel') flatOf(ctx.fullBleed && on.length ? on.map((m) => ({ id: m.id, rect: m.rect, toLocal: camInv, k: sc })) : [pageShape]);
  for (const m of on) {
    const lt = t - m.start;
    const ls = m.layers ? layerShapes({ W, H, m, cam, t: lt, eye3d: camera }) : null;
    // 2) 'art': lo que se ve fuera de la caja tiene que ser marco (mismo color que el escenario), no un corte
    if (mode === 'art') {
      const e = boxEdgeCut({ W, H, stage, m, cam, lt, ls, stageColor });
      if (e) {
        margin = Math.min(margin, e.px);
        if (e.px < -0.5) {
          const what = e.id === m.id ? (hasFrameData(m) ? 'y corta el dibujo' : '(sin datos del marco: comic tags)') : `y corta ${e.id}`;
          issues.push({ kind: 'page', panel: m.id, id: m.id, side: e.side, px: e.px, msg: `se ve fuera de la viñeta ${m.id} ${what} (borde ${SIDE_ES[e.side]}, ${fmtPx(e.px)})` });
        }
      }
    }
    if (!ls) continue;
    // 3) capas: los fondos tienen que cubrir la caja visible
    const region = boxRegion({ W, H, m, cam });
    if (region.length >= 3 && Math.abs(polyArea(region)) >= 1 && ls.shapes.length) {
      const c = coverage(region, ls.shapes);
      margin = Math.min(margin, c.margin);
      if (c.margin < -0.5) issues.push({ kind: 'edge', panel: m.id, id: c.worst.id, side: c.worst.side, px: c.margin, msg: `se ve el borde ${SIDE_ES[c.worst.side]} de ${c.worst.id} (${fmtPx(c.margin)})` });
    }
    // 4) keepText: textos visibles enteros dentro del cuadro con margen
    if (ctx.keepText != null && ctx.keepText !== false) {
      const tm = textMargins(ls.texts, W, H, ctx.keepText);
      if (tm.margin < textMargin) {
        textMargin = tm.margin;
        textWorst = tm.worst;
      }
    }
    if (ctx.texts) {
      const boxInv = inv(ls.Mbox);
      for (const tx of ls.texts) {
        if (!tx.settled) continue;
        const corners = rectCorners(tx.rect).map(([x, y]) => ap(tx.toFrame, x, y));
        const o = overflow(corners, [0, 0, W, H], ls.Mbox && boxInv, m.inner);
        // entero fuera de cuadro solo cuenta si ACABA de aparecer (at > 0): un texto que la cámara no mira es
        // encuadre; uno que entra fuera de cuadro se pierde. Cortado cuenta siempre (check pide que dure ≥ 0.5 s).
        if (o.px < -2 && o.out && tx.at > 0 && tx.since < 1) issues.push({ kind: 'text', panel: m.id, id: tx.id, side: o.side, px: o.px, msg: `el texto ${tx.id} aparece fuera de cuadro (${fmtPx(o.px)})` });
        else if (o.px < -2 && !o.out) issues.push({ kind: 'text', panel: m.id, id: tx.id, side: o.side, px: o.px, msg: `el texto ${tx.id} queda cortado por el borde ${SIDE_ES[o.side]} (${fmtPx(o.px)})` });
      }
    }
  }
  return { ok: margin >= -0.5, margin, textMargin, textWorst, issues };
}

// Cuánto se sale un cuadrilátero (px del cuadro) del cuadro y de la caja de su viñeta.
function overflow(corners, [x0, y0, x1, y1], boxInv, inner) {
  let worst = { px: Infinity, side: null };
  const upd = (px, side) => {
    if (px < worst.px) worst = { px, side };
  };
  for (const [x, y] of corners) {
    upd(x - x0, 'left');
    upd(x1 - x, 'right');
    upd(y - y0, 'top');
    upd(y1 - y, 'bottom');
  }
  if (boxInv) {
    const k = Math.sqrt(1 / Math.abs(det(boxInv)));
    for (const [x, y] of corners) {
      const [u, v] = ap(boxInv, x, y);
      upd(u * k, 'left');
      upd((inner[0] - u) * k, 'right');
      upd(v * k, 'top');
      upd((inner[1] - v) * k, 'bottom');
    }
  }
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const out = Math.max(...xs) < x0 || Math.min(...xs) > x1 || Math.max(...ys) < y0 || Math.min(...ys) > y1;
  return { ...worst, out };
}

export const fmtPx = (px) => (px < 0 ? '−' : '+') + Math.round(Math.abs(px)) + ' px';

// ¿La escena en reposo (vista por defecto) está cubierta por sus viñetas? → los bordes de las viñetas cuentan.
export function isFullBleed({ W, H, stage, panels }) {
  if (!panels.length) return false;
  const cam = cameraAffine({ view: defaultView(stage, W, H) }, W, H);
  const camInv = inv(cam);
  const sc = Math.sqrt(Math.abs(det(cam)));
  const c = coverage([[0, 0], [W, 0], [W, H], [0, H]], panels.map((m) => ({ id: m.id, rect: m.rect, toLocal: camInv, k: sc })));
  return c.margin >= -0.5;
}

// Región de un VFX (polígono [[x,y],…] o rect [x,y,w,h], px de página) contra el rect de su viñeta.
// Devuelve null si entra, o { side, px } con lo que más se sale.
export function regionOutside(region, rect, tol = 1) {
  const pts = Array.isArray(region?.[0]) ? region : Array.isArray(region) && region.length === 4 ? [[region[0], region[1]], [region[0] + region[2], region[1] + region[3]]] : null;
  if (!pts) return null;
  const [x, y, w, h] = rect;
  let worst = null;
  for (const [px, py] of pts) {
    for (const [d, side] of [[px - x, 'left'], [x + w - px, 'right'], [py - y, 'top'], [y + h - py, 'bottom']]) if (d < -tol && (!worst || d < worst.px)) worst = { side, px: d };
  }
  return worst;
}
