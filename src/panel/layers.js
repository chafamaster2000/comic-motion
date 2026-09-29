// Capas de una viñeta hecha con un asset `type: 'layers'` (PSD exportado por capas).
// Lógica pura del panel: overrides por capa en params.layers, profundidad automática,
// y rect de una capa en coordenadas de página (para el contorno del preview).
// El motor es quien dibuja; acá solo se edita y se aproxima dónde cae cada capa.
import { mediaLayout, panelView } from '../player/media.js';

export const ROLES = ['background', 'character', 'text', 'fx', 'divider', 'guide'];
export const ROLE_LABEL = { background: 'fondo', character: 'personaje', text: 'texto', fx: 'efecto', divider: 'divisor', guide: 'guía' };
// profundidad por rol si el asset no trae `depth` (misma escala que las capas VFX: back 0 · mid .5 · front 1.25)
import { ROLE_DEPTH } from '../player/layers.js';
export const DEPTH_RANGE = { min: 0, max: 2, step: 0.05 };
export const MOTION_KEYS = [
  { key: 'dx', label: 'dx', step: 1, suffix: 'px' },
  { key: 'dy', label: 'dy', step: 1, suffix: 'px' },
  { key: 'scale', label: 'escala', step: 0.01 },
  { key: 'rotate', label: 'giro', step: 0.5, suffix: '°' },
];

export const isLayersAsset = (a) => a?.type === 'layers' && Array.isArray(a.layers);

// asset de capas de un clip de viñeta (o null)
export function layersAssetOf(scene, params) {
  const a = params?.asset ? scene?.assets?.[params.asset] : null;
  return isLayersAsset(a) ? a : null;
}

// ¿este param es el editor de capas? (tipo declarado, o key `layers` con asset de capas)
export const isLayersParam = (p, asset) => p.type === 'layers' || (p.key === 'layers' && !!asset);
export const isLayerPairParam = (p) => p.type === 'layerPair' || p.key === 'between';

export const autoDepth = (layer) => (typeof layer.depth === 'number' ? layer.depth : ROLE_DEPTH[layer.role] ?? 0.5);

// capa con sus overrides aplicados
export function effectiveLayer(layer, ov = {}) {
  return {
    ...layer,
    role: ov.role ?? layer.role,
    depth: ov.depth ?? autoDepth(layer),
    hidden: ov.hidden ?? !!layer.hidden,
    at: ov.at ?? layer.at ?? null,
    enter: ov.enter ?? layer.enter ?? null,
    exit: ov.exit ?? layer.exit ?? null,
    dur: ov.dur ?? layer.dur ?? null,
    motion: ov.motion ?? layer.motion ?? null,
    clipTo: ov.clipTo !== undefined ? ov.clipTo : layer.clipTo ?? null,
  };
}

// adelante → atrás
export const layersFrontToBack = (asset) => [...(asset?.layers || [])].sort((a, b) => (b.z ?? 0) - (a.z ?? 0));

// Escribe el override `key` de la capa `id` y poda lo que no difiere del asset.
// Devuelve el objeto layers nuevo (o undefined si quedó vacío).
export function setOverride(layersParam, layer, key, value) {
  const all = { ...(layersParam || {}) };
  const ov = { ...(all[layer.id] || {}) };
  const base = key === 'depth' ? autoDepth(layer) : key === 'hidden' ? !!layer.hidden : layer[key];
  const same = value === undefined || value === null || value === '' || JSON.stringify(value) === JSON.stringify(base ?? null);
  // clipTo: null explícito ("libre") sí es un override si el asset trae clipTo
  if (key === 'clipTo' && value === null && layer.clipTo) ov.clipTo = null;
  else if (same || (key === 'motion' && isEmptyMotion(value) && !layer.motion)) delete ov[key];
  else ov[key] = value;
  if (Object.keys(ov).length) all[layer.id] = ov;
  else delete all[layer.id];
  return Object.keys(all).length ? all : undefined;
}

export const isEmptyMotion = (m) => !m || ['dx', 'dy', 'rotate'].every((k) => !m[k]) && (m.scale == null || m.scale === 1) && !m.ease;

export const overrideCount = (layersParam) => Object.keys(layersParam || {}).length;

// ---------- geometría ----------
// Esquinas (coords de página) del rect de una capa dentro de la viñeta, en el tiempo local tl.
// Aproximación 2D: cover + foco + ken burns + inclinación de la viñeta; ignora el parallax 3D.
export function layerPageQuad(params, asset, layer, stage, clipDuration, tl) {
  const p = params || {};
  const rect = p.rect || [0, 0, stage.w, stage.h];
  const b = p.border ?? 8;
  const innerW = rect[2] - 2 * b;
  const innerH = rect[3] - 2 * b;
  const view = panelView(p, asset, clipDuration || 1, Math.max(0, tl || 0));
  const L = mediaLayout(asset, p.crop, innerW, innerH, view.zoom, view.fx, view.fy);
  const ox = rect[0] + b + L.left;
  const oy = rect[1] + b + L.top;
  const pts = [
    [layer.x, layer.y],
    [layer.x + layer.w, layer.y],
    [layer.x + layer.w, layer.y + layer.h],
    [layer.x, layer.y + layer.h],
  ].map(([x, y]) => [ox + x * L.k, oy + y * L.k]);
  const tilt = ((p.tilt || 0) * Math.PI) / 180;
  if (!tilt) return pts;
  const cx = rect[0] + rect[2] / 2;
  const cy = rect[1] + rect[3] / 2;
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}

// Marcas de tiempo de las capas de una viñeta (tiempo local al clip): las que tienen `at`,
// y los textos (aparecen en 0 si nadie les dio `at`).
export function layerTimeMarks(asset, layersParam) {
  const out = [];
  for (const l of layersFrontToBack(asset)) {
    const e = effectiveLayer(l, layersParam?.[l.id]);
    if (e.hidden) continue;
    const hasEnter = e.enter && e.enter.preset && e.enter.preset !== 'none';
    if (e.at == null && !hasEnter && e.role !== 'text') continue;
    out.push({ id: l.id, name: l.name || l.id, role: e.role, at: e.at ?? 0, explicit: e.at != null });
  }
  return out;
}
