// Params y utilidades comunes de los presets VFX (sin three: este módulo también lo lee Node).
export const LAYERS = ['back', 'mid', 'front'];

// Params comunes. `layer` solo para los que dibujan geometría; `anchor` para los que nacen en un punto.
export function common({ layer = 'mid', anchor = false, style = false } = {}) {
  const out = [{ key: 'target', label: 'Viñeta (clip id; vacío = la primera de la escena)', type: 'clipRef', default: null }];
  if (anchor) out.push({ key: 'anchor', label: 'Punto [x,y] en la página, "@tag" / "layer:<id>" (centro de la capa) o ["@tag", fx, fy] (vacío = centro de la viñeta)', type: 'anchor', default: null });
  if (layer)
    out.push(
      { key: 'layer', label: 'Capa', type: 'select', options: LAYERS, default: layer },
      // viñeta por capas: entre dos capas del PSD, o a una profundidad (escala depth 0..2); pisa a `layer`
      { key: 'between', label: 'Entre capas [idAtrás, idAdelante] (viñeta por capas)', type: 'layerPair', default: null },
      { key: 'z', label: 'Profundidad (viñeta por capas, escala depth 0..2; vacío = según capa/between)', type: 'number', min: 0, max: 2, step: 0.05, default: null },
    );
  if (style) out.push({ key: 'style', label: 'Estilo', type: 'select', options: ['glow', 'ink'], default: 'glow' });
  out.push(
    { key: 'intensity', label: 'Intensidad', type: 'number', min: 0, max: 3, step: 0.05, default: 1 },
    { key: 'stepFps', label: 'Cuadros/s del efecto (0 = continuo, 12 = de a dos)', type: 'number', min: 0, max: 30, step: 1, default: 0 },
  );
  return out;
}

// Rect de la viñeta destino y ancla en px de página. `anchor`: [x, y] en px, o una capa de la viñeta por capas:
// "@tag" / "layer:<id>" (centro del bbox del alfa) o ["@tag", fx, fy] (punto relativo a ese bbox, 0..1).
// Vacío (o una capa que no resuelve, con aviso) = centro de la viñeta.
export function targetInfo(ctx) {
  const rect = ctx.panelRect(ctx.gpu.target) || [0, 0, ctx.stage.w, ctx.stage.h];
  const center = [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
  const a = ctx.params.anchor;
  let anchor = center;
  if (Array.isArray(a) && typeof a[0] === 'number') anchor = a;
  else if (typeof a === 'string' || (Array.isArray(a) && typeof a[0] === 'string')) {
    const [ref, fx = 0.5, fy = 0.5] = Array.isArray(a) ? a : [a];
    const p = ctx.gpu.layerPoint?.(ref, fx, fy);
    if (p) anchor = p;
    else ctx.warn?.(`anchor ${JSON.stringify(a)} no resuelve a una capa de la viñeta ${ctx.gpu.target} (se usa el centro)`);
  }
  return { rect, anchor };
}

// Envolvente de entrada/salida (0..1) del clip en t.
export function envelope(t, duration, fadeIn = 0.2, fadeOut = 0.3) {
  const a = fadeIn > 0 ? Math.min(1, Math.max(0, t / fadeIn)) : 1;
  const b = fadeOut > 0 ? Math.min(1, Math.max(0, (duration - t) / fadeOut)) : 1;
  return Math.min(a, b);
}

// Param `region`: polígono [[x,y],…] en px de página (ej. la forma dibujada de la viñeta, para que el
// efecto no pise el borde negro ni la canaleta). También acepta un rect [x,y,w,h].
export function regionParams(what = 'el efecto') {
  return [
    { key: 'region', label: `Zona [[x,y],…] o [x,y,w,h] en la página donde se ve ${what} (vacío = toda la viñeta)`, type: 'json', default: null },
    { key: 'regionFeather', label: 'Borde suave de la zona (px)', type: 'number', min: 0, max: 400, default: 4 },
  ];
}

export function toPolygon(region) {
  if (!Array.isArray(region) || !region.length) return null;
  if (typeof region[0] === 'number' && region.length === 4) {
    const [x, y, w, h] = region;
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  const pts = region.filter((q) => Array.isArray(q) && q.length >= 2).map((q) => [+q[0], +q[1]]);
  return pts.length >= 3 ? pts : null;
}

// TSL: 0..1, 1 dentro del polígono (par-impar, sirve para cóncavos) con borde suave de `feather` px.
export function polygonMask(TSL, P, poly, feather = 4) {
  const { float, vec2, select, length, clamp, min, dot, mod } = TSL;
  let dmin = null;
  let cross = float(0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const A = vec2(a[0], a[1]);
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const e = vec2(ex, ey);
    const w = P.sub(A);
    const ee = Math.max(1e-6, ex * ex + ey * ey);
    const h = clamp(dot(w, e).div(ee), 0, 1);
    const d = length(w.sub(e.mul(h)));
    dmin = dmin ? min(dmin, d) : d;
    if (a[1] !== b[1]) {
      const straddle = P.y.greaterThanEqual(Math.min(a[1], b[1])).and(P.y.lessThan(Math.max(a[1], b[1])));
      const xAt = P.y.sub(a[1]).mul((b[0] - a[0]) / (b[1] - a[1])).add(a[0]);
      cross = cross.add(select(straddle.and(P.x.lessThan(xAt)), float(1), float(0)));
    }
  }
  const inside = mod(cross, 2).greaterThan(0.5);
  const sd = select(inside, dmin, dmin.negate());
  // 0 sobre el borde, 1 a `feather` px hacia adentro: el efecto nunca se sale del polígono
  return TSL.smoothstep(0, Math.max(0.5, feather), sd);
}
