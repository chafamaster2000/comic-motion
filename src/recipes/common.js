// Helpers de las recetas: armar clips normales (holder + variante v1 draft) y tiempos de textos.

export const round = (x, n = 3) => +(+x).toFixed(n);

// Clip holder listo para scene.json (mismo formato que escribe a mano el agente o el generador).
export function clip(id, track, label, preset, start, duration, params = {}, ease) {
  const v = { id: 'v1', status: 'draft', preset, start: round(Math.max(0, start)), duration: round(Math.max(0.05, duration)), params };
  if (ease) v.ease = ease;
  return { id, track, label, active: 'v1', variants: [v] };
}

// Cámara por capas (preset move3d): siempre con una referencia semántica, nunca coordenadas crudas.
export function move3d(id, label, start, duration, { move, target, amount, direction, ease = 'easeInOut', ...rest }) {
  const params = { move, amount };
  if (target) params.target = target;
  if (direction) params.direction = direction;
  if (ease) params.ease = ease;
  return clip(id, 'camera', label, 'move3d', start, duration, { ...params, ...rest });
}

// Textos en orden de lectura desde `from` (s de escena): 0.4 s + 0.25 s por palabra, comprimidos para
// que el último entre antes de `until`. Devuelve [{ layer, at }] en s de escena.
export function readingTimes(g, from, until) {
  const ats = [];
  let t = from;
  for (const l of g.texts) {
    ats.push(t);
    const w = g.wordsOf(l);
    t += w ? 0.4 + 0.25 * w : 0.6;
  }
  const last = ats.length ? ats[ats.length - 1] : from;
  const k = last > until && last > from ? (until - from) / (last - from) : 1;
  return g.texts.map((l, i) => ({ layer: l, at: from + (ats[i] - from) * k }));
}

export const center = (box) => [Math.round(box[0] + box[2] / 2), Math.round(box[1] + box[3] / 2)];

// Lugar para una onomatopeya de tamaño `size`: prueba una grilla dentro de la viñeta y elige el punto que menos
// pisa textos y personajes (cajas de capa en px de página; el héroe pesa la mitad) y queda cerca del héroe.
export function onoSpot(g, heroBox, size) {
  const [rx, ry, rw, rh] = g.rect;
  const ow = size * 2.4;
  const oh = size * 1.1;
  const obstacles = g.layers.filter((l) => !l.hidden && (l.role === 'character' || l.role === 'text')).map((l) => ({ b: g.box(l), w: l.role === 'text' ? 3 : 1 }));
  const hc = center(heroBox);
  const inter = (a, b) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  let best = null;
  for (let i = 0; i < 7; i++)
    for (let j = 0; j < 5; j++) {
      const x = rx + ow / 2 + ((rw - ow) * i) / 6;
      const y = ry + oh / 2 + ((rh - oh) * j) / 4;
      const box = [x - ow / 2, y - oh / 2, ow, oh];
      let cost = 0;
      for (const o of obstacles) cost += (o.w * inter(box, o.b)) / (ow * oh);
      // la caja del héroe cuenta de nuevo con peso negativo parcial: cerca del héroe está bien
      cost -= (0.5 * inter(box, heroBox)) / (ow * oh);
      cost += (0.35 * Math.hypot(x - hc[0], y - hc[1])) / Math.hypot(rw, rh);
      if (!best || cost < best.cost) best = { cost, at: [Math.round(x), Math.round(y)] };
    }
  return best.at;
}