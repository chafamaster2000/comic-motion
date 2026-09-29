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
      const s = slack(ap(sh.toLocal, P[0], P[1]), sh.rect, sh.k);
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
// Planos que cubren (fondos) de una viñeta por capas en el tiempo local t, como formas del cuadro.
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
  for (const r of vis) {
    const st = layerState(r, t, m.duration);
    if (!st.visible) continue;
    const toFocal = mul(planeToFocal(eye, m.rest, r.Z), st.m); // local de la capa → plano focal
    const toFrame = mul(A, toFocal);
    const k = sA * Math.sqrt(Math.abs(det(toFocal)));
    const sh = { id: r.id, role: r.role, Z: r.Z, rect: [r.x, r.y, r.w, r.h], toFrame, toLocal: inv(toFrame), k, opacity: st.opacity, settled: layerSettled(r, t, m.duration), at: r.at || 0, since: t - (r.at || 0) };
    if (r.role === 'background' && st.opacity >= 0.5) shapes.push(sh);
    if (r.role === 'text') texts.push(sh);
  }
  return { shapes, texts, A, Mbox, eye, L };
}

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

// Vista segura en un instante. ctx:
//   { W, H, stage, panels: [panelModel], camera: { view, dx, dy, drot, dzoom, dist?, orbit? }, t (local de la escena),
//     fullBleed?: bool (la escena en reposo está cubierta por viñetas), texts?: bool }
// Devuelve { ok, margin (px del cuadro; negativo = se ve un borde vacío de ese tamaño), issues: [...] }.
// issue: { kind: 'edge'|'page'|'text', id, side, px, msg }
export function safeView(ctx) {
  const { W, H, stage, panels, camera, t } = ctx;
  const cam = cameraAffine(camera, W, H);
  const frame = [[0, 0], [W, 0], [W, H], [0, H]];
  const issues = [];
  let margin = Infinity;
  const on = panels.filter((m) => t >= m.start && t < m.start + m.duration);
  if (on.some((m) => !panelSettled(m, t - m.start))) return { ok: true, margin: Infinity, issues, skipped: 'entrada/salida de viñeta' };
  // 1) plano: fuera de la página, o fuera de las viñetas si la escena es a sangre
  const camInv = inv(cam);
  const sc = Math.sqrt(Math.abs(det(cam)));
  const flat = ctx.fullBleed && on.length
    ? on.map((m) => ({ id: m.id, rect: m.rect, toLocal: camInv, k: sc, what: 'viñeta' }))
    : [{ id: 'página', rect: [0, 0, stage.w, stage.h], toLocal: camInv, k: sc, what: 'página' }];
  const fc = coverage(frame, flat);
  margin = Math.min(margin, fc.margin);
  if (fc.margin < -0.5) issues.push({ kind: 'page', id: fc.worst.id, side: fc.worst.side, px: fc.margin, msg: `se ve fuera de ${fc.worst.id === 'página' ? 'la página' : 'la viñeta ' + fc.worst.id} (borde ${SIDE_ES[fc.worst.side]}, ${fmtPx(fc.margin)})` });
  // 2) capas: los fondos tienen que cubrir la caja visible
  for (const m of on) {
    if (!m.layers) continue;
    const lt = t - m.start;
    const region = boxRegion({ W, H, m, cam });
    if (region.length < 3 || Math.abs(polyArea(region)) < 1) continue;
    const ls = layerShapes({ W, H, m, cam, t: lt, eye3d: camera });
    if (!ls.shapes.length) continue;
    const c = coverage(region, ls.shapes);
    margin = Math.min(margin, c.margin);
    if (c.margin < -0.5) issues.push({ kind: 'edge', panel: m.id, id: c.worst.id, side: c.worst.side, px: c.margin, msg: `se ve el borde ${SIDE_ES[c.worst.side]} de ${c.worst.id} (${fmtPx(c.margin)})` });
    if (ctx.texts) {
      const boxInv = inv(ls.Mbox);
      for (const tx of ls.texts) {
        if (!tx.settled) continue;
        const corners = [[tx.rect[0], tx.rect[1]], [tx.rect[0] + tx.rect[2], tx.rect[1]], [tx.rect[0] + tx.rect[2], tx.rect[1] + tx.rect[3]], [tx.rect[0], tx.rect[1] + tx.rect[3]]].map(([x, y]) => ap(tx.toFrame, x, y));
        const o = overflow(corners, [0, 0, W, H], ls.Mbox && boxInv, m.inner);
        // entero fuera de cuadro solo cuenta si ACABA de aparecer (at > 0): un texto que la cámara no mira es
        // encuadre; uno que entra fuera de cuadro se pierde. Cortado cuenta siempre (check pide que dure ≥ 0.5 s).
        if (o.px < -2 && o.out && tx.at > 0 && tx.since < 1) issues.push({ kind: 'text', panel: m.id, id: tx.id, side: o.side, px: o.px, msg: `el texto ${tx.id} aparece fuera de cuadro (${fmtPx(o.px)})` });
        else if (o.px < -2 && !o.out) issues.push({ kind: 'text', panel: m.id, id: tx.id, side: o.side, px: o.px, msg: `el texto ${tx.id} queda cortado por el borde ${SIDE_ES[o.side]} (${fmtPx(o.px)})` });
      }
    }
  }
  return { ok: margin >= -0.5, margin, issues };
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
