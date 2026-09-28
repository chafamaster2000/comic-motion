// Pistas del panel: se derivan de TRACKS (motor) + las que aparezcan en presets o clips,
// así una pista nueva (p. ej. 'vfx') se ve aunque el motor todavía no la haya declarado.
import { TRACKS, TRACK_LABELS, activeVariant } from '../shared/scene.js';

const NON_CLIP_KINDS = new Set(['transition', 'filter', 'custom']);
const EXTRA_LABELS = { vfx: 'VFX' };

export const trackLabel = (t) => TRACK_LABELS?.[t] || EXTRA_LABELS[t] || t;

export function trackList(scene, presets) {
  const out = [...TRACKS];
  const add = (t) => t && !out.includes(t) && out.push(t);
  for (const d of presets?.builtin || []) if (!NON_CLIP_KINDS.has(d.kind)) add(d.kind);
  for (const s of scene?.scenes || []) for (const v of s.variants || []) for (const c of v.clips || []) add(c.track);
  return out;
}

// ¿el param elige una viñeta de la escena? (tipo 'clipRef', o `target` sin tipo propio)
export const isClipRef = (p) => p.type === 'clipRef' || (p.key === 'target' && ['text', 'json', 'select', undefined].includes(p.type) && !p.options);

// Viñetas (pista panel) de una variante de escena, para el editor de target.
export function panelsOf(sceneVariant) {
  return (sceneVariant?.clips || [])
    .filter((c) => c.track === 'panel')
    .map((c) => ({ id: c.id, label: c.label || c.id, rect: activeVariant(c)?.params?.rect || null }));
}

// Clip nuevo con el primer preset de la pista. start es local a la escena.
export function makeClip(sv, track, presets, start, fps, meta) {
  const def = (presets?.builtin || []).find((d) => d.kind === track);
  if (!def) return null;
  const ids = new Set((sv.clips || []).map((c) => c.id));
  let n = 1;
  while (ids.has(track + n)) n++;
  const snap = (t) => Math.round(t * fps) / fps;
  const params = {};
  const panels = panelsOf(sv);
  const stage = { w: sv.stage?.w || meta.width, h: sv.stage?.h || meta.height };
  const panel = panels[0];
  if (panel && (def.params || []).some(isClipRef)) params[(def.params.find(isClipRef)).key] = panel.id;
  const anchorP = (def.params || []).find((p) => p.type === 'anchor');
  if (anchorP && def.defaults?.[anchorP.key] == null) {
    const r = panel?.rect || [0, 0, stage.w, stage.h];
    params[anchorP.key] = [Math.round(r[0] + r[2] / 2), Math.round(r[1] + r[3] / 2)];
  }
  const duration = Math.max(1 / fps, snap(Math.min(1, (sv.duration || 1) - start)));
  return {
    id: track + n,
    track,
    label: def.label,
    active: 'v1',
    variants: [{ id: 'v1', status: 'draft', preset: def.id, start, duration, params, createdAt: new Date().toISOString() }],
  };
}
