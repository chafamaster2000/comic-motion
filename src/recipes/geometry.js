// Geometría de una viñeta por capas para las recetas y el brief del generador: capas del lienzo → px de página.
// Pura (sin DOM): usa el mismo mediaLayout que el player con la cámara en reposo (sin ken burns).
import { mediaLayout } from '../player/media.js';
import { withPanelDefaults } from '../player/presets.js';
import { activeVariant } from '../shared/scene.js';
import { resolveLayerRef, readingOrder, wordsOf } from '../player/layers.js';

// Primera viñeta de la variante de escena, prefiriendo la que usa un asset de capas.
export function mainPanel(scene, sceneVariant, clipId = null) {
  const panels = (sceneVariant.clips || []).filter((c) => c.track === 'panel' && activeVariant(c));
  const pick = clipId ? panels.find((c) => c.id === clipId) : panels.find((c) => scene.assets?.[activeVariant(c).params?.asset]?.type === 'layers') || panels[0];
  if (!pick) return null;
  const v = activeVariant(pick);
  const params = withPanelDefaults(scene.meta, v.params);
  const asset = scene.assets?.[params.asset] || null;
  const stage = { w: sceneVariant.stage?.w || scene.meta.width, h: sceneVariant.stage?.h || scene.meta.height };
  const rect = params.rect || [0, 0, stage.w, stage.h];
  const b = params.border ?? 8;
  let map = null;
  if (asset) {
    const focus = params.focus || asset.focus || [0.5, 0.5];
    const L = mediaLayout(asset, params.crop, rect[2] - 2 * b, rect[3] - 2 * b, 1, focus[0], focus[1]);
    map = { k: L.k, ox: rect[0] + b + L.left, oy: rect[1] + b + L.top };
  }
  const toPage = (x, y) => (map ? [map.ox + x * map.k, map.oy + y * map.k] : [x, y]);
  const layers = asset?.type === 'layers' ? asset.layers : [];
  // caja de una capa en px de página, recortada al rect de la viñeta
  const box = (l) => {
    const [x0, y0] = toPage(l.x, l.y);
    const [x1, y1] = toPage(l.x + l.w, l.y + l.h);
    const cx0 = Math.max(rect[0], x0);
    const cy0 = Math.max(rect[1], y0);
    const cx1 = Math.min(rect[0] + rect[2], x1);
    const cy1 = Math.min(rect[1] + rect[3], y1);
    return [Math.round(cx0), Math.round(cy0), Math.round(Math.max(0, cx1 - cx0)), Math.round(Math.max(0, cy1 - cy0))];
  };
  const ref = (r) => {
    const id = resolveLayerRef(layers, r);
    return id ? layers.find((l) => l.id === id) : null;
  };
  const texts = readingOrder(layers.filter((l) => l.role === 'text' && !l.attachedTo && !l.hidden));
  return { clip: pick, variant: v, params, asset, stage, rect, toPage, layers, box, ref, texts, wordsOf, isLayers: asset?.type === 'layers' };
}

// Resumen de capas para el generador y el guiado (sin rutas de PNG).
export function layersSummary(scene, sceneVariant) {
  const out = [];
  for (const c of sceneVariant.clips || []) {
    if (c.track !== 'panel') continue;
    const g = mainPanel(scene, sceneVariant, c.id);
    if (!g?.isLayers) continue;
    out.push({
      panel: c.id,
      asset: g.params.asset,
      canvas: [g.asset.w, g.asset.h],
      rect: g.rect,
      crop: g.params.crop || null,
      layers: g.layers.map((l) => {
        const o = { id: l.id, tags: l.tags || [], role: l.role, depth: l.depth, bbox: [l.x, l.y, l.w, l.h], pageBox: g.box(l) };
        if (l.clipTo) o.clipTo = l.clipTo;
        if (l.attachedTo) o.attachedTo = l.attachedTo;
        if (l.global) o.global = true;
        return o;
      }),
    });
  }
  return out;
}
