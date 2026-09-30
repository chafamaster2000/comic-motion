// Modelo de escena compartido por player, panel, server y CLI.
// scene.json:
//   meta   { title, width, height, fps, background, generatorModel, guideModel?, maxVariants, direction? }
//   assets { [id]: { file, type: 'image'|'video', w, h, duration?, proxy?, cutout?, description?, focus?, bubbleSafe?, inOut? } }
//   scenes [ { id, title, active, direction?, variants: [SceneVariant] } ]
// direction (meta y escena): { clave: texto } del modo guiado. Vive en el holder, no en las variantes,
// así que no entra en contentHash: cambiarla no desactualiza aprobaciones.
// SceneVariant { id, status, parent?, instruction?, note?, rejection?, approvedHash?, createdAt?,
//                duration, stage?: {w,h,background}, transition?: {preset, duration, ease, params},
//                clips: [ { id, track, label, active, variants: [ClipVariant] } ] }
// ClipVariant  { id, status, parent?, instruction?, note?, rejection?, approvedHash?, createdAt?,
//                preset, start, duration, ease?, params }
// status: 'draft' | 'approved' | 'rejected' | 'hidden'

export const TRACKS = ['camera', 'panel', 'vfx', 'fx', 'bubble', 'ono'];
export const TRACK_LABELS = {
  camera: 'Cámara',
  panel: 'Viñetas',
  vfx: 'VFX',
  fx: 'Efectos',
  bubble: 'Globos',
  ono: 'Onomatopeyas',
};

export function activeVariant(holder) {
  if (!holder || !holder.variants || holder.variants.length === 0) return null;
  const byId = holder.variants.find((v) => v.id === holder.active);
  if (byId) return byId;
  return (
    holder.variants.find((v) => v.status === 'approved') ||
    holder.variants.find((v) => v.status !== 'hidden' && v.status !== 'rejected') ||
    holder.variants[0]
  );
}

export function approvedVariant(holder) {
  return holder?.variants?.find((v) => v.status === 'approved') || null;
}

// Assets para los prompts (brief del generador, contexto del guiado): sin los datos de píxeles de los límites de
// cámara en base64 (grid/hull de capas, bands de edges; ver src/pixel-bounds.js), que no le sirven al modelo y
// agregan decenas de KB por pedido. Quedan alpha, solid y edges { color, band }.
export function assetsForPrompt(assets) {
  const out = {};
  for (const [id, a] of Object.entries(assets || {})) {
    if (!a || typeof a !== 'object') {
      out[id] = a;
      continue;
    }
    const b = { ...a };
    if (b.edges && typeof b.edges === 'object') {
      const { bands, n, ...e } = b.edges;
      b.edges = e;
    }
    if (Array.isArray(b.layers)) {
      b.layers = b.layers.map((l) => {
        if (!l || (!l.grid && !l.hull)) return l;
        const { grid, hull, ...rest } = l;
        return rest;
      });
    }
    out[id] = b;
  }
  return out;
}

// Hash estable del contenido de una variante (sin campos de revisión) para detectar
// aprobaciones desactualizadas.
const REVIEW_KEYS = new Set(['status', 'note', 'rejection', 'approvedHash', 'createdAt', 'active']);
export function contentHash(value) {
  const s = stableStringify(value, true);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stableStringify(v, strip) {
  if (Array.isArray(v)) return '[' + v.map((x) => stableStringify(x, strip)).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .filter((k) => !(strip && REVIEW_KEYS.has(k)))
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k], strip))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

// Una variante de escena depende del contenido de las variantes activas de sus clips.
export function effectiveContent(variant, level) {
  if (level !== 'scene') return variant;
  return {
    ...variant,
    clips: (variant.clips || []).map((c) => ({ id: c.id, track: c.track, v: activeVariant(c) })),
  };
}

export function isStale(variant, level) {
  return (
    variant.status === 'approved' &&
    !!variant.approvedHash &&
    variant.approvedHash !== contentHash(effectiveContent(variant, level))
  );
}

// Ubica cada escena en el tiempo global. La transición de entrada se solapa con la cola
// de la escena anterior.
export function layoutScenes(scene) {
  const out = [];
  for (const s of scene.scenes || []) {
    const v = activeVariant(s);
    if (!v) continue;
    const prev = out[out.length - 1];
    const trans = prev && v.transition && v.transition.preset !== 'cut' ? v.transition : null;
    const overlap = trans ? Math.max(0, Math.min(trans.duration || 0, v.duration, prev.duration)) : 0;
    const start = prev ? prev.end - overlap : 0;
    out.push({ scene: s, variant: v, index: out.length, start, duration: v.duration, end: start + v.duration, transition: trans, transitionDuration: overlap });
  }
  return out;
}

export function totalDuration(scene) {
  const l = layoutScenes(scene);
  return l.length ? Math.max(...l.map((e) => e.end)) : 0;
}

export function activeClips(sceneVariant) {
  return (sceneVariant.clips || [])
    .map((c) => ({ clip: c, variant: activeVariant(c) }))
    .filter((x) => x.variant && x.variant.status !== 'hidden');
}

export function findTarget(scene, target) {
  const s = scene.scenes.find((x) => x.id === target.scene);
  if (!s) return {};
  if (!target.clip) return { sceneHolder: s, holder: s, level: 'scene' };
  const sv = target.sceneVariant ? s.variants.find((v) => v.id === target.sceneVariant) : activeVariant(s);
  const c = sv?.clips?.find((x) => x.id === target.clip);
  return { sceneHolder: s, sceneVariant: sv, holder: c, level: 'clip' };
}

export function nextVariantId(holder) {
  let n = 0;
  for (const v of holder.variants || []) {
    const m = /^v(\d+)$/.exec(v.id);
    if (m) n = Math.max(n, +m[1]);
  }
  return 'v' + (n + 1);
}

// Aplica una acción de revisión sobre una variante. Muta `scene` y devuelve el evento de historial.
export function reviewAction(scene, target, action, note) {
  const { holder, level } = findTarget(scene, target);
  if (!holder) throw new Error('target no encontrado: ' + JSON.stringify(target));
  const v = holder.variants.find((x) => x.id === target.variant);
  if (!v) throw new Error('variante no encontrada: ' + target.variant);
  switch (action) {
    case 'approve':
      for (const o of holder.variants) if (o.status === 'approved' && o !== v) o.status = 'draft';
      v.status = 'approved';
      v.note = note || v.note;
      delete v.rejection;
      holder.active = v.id;
      v.approvedHash = contentHash(effectiveContent(v, level));
      break;
    case 'unapprove':
      v.status = 'draft';
      delete v.approvedHash;
      break;
    case 'reject':
      v.status = 'rejected';
      v.rejection = note || v.rejection || '';
      delete v.approvedHash;
      break;
    case 'hide':
      v.status = 'hidden';
      if (holder.active === v.id) holder.active = activeVariantExcluding(holder, v.id)?.id;
      break;
    case 'restore':
      v.status = 'draft';
      break;
    case 'activate':
      holder.active = v.id;
      break;
    case 'note':
      v.note = note;
      break;
    default:
      throw new Error('acción desconocida ' + action);
  }
  return { ts: new Date().toISOString(), action, target, note: note || undefined };
}

function activeVariantExcluding(holder, id) {
  return (
    holder.variants.find((v) => v.id !== id && v.status === 'approved') ||
    holder.variants.find((v) => v.id !== id && v.status === 'draft') ||
    holder.variants.find((v) => v.id !== id)
  );
}

// Reúne lo aprendido de las hermanas para alimentar al generador.
export function reviewContext(holder) {
  return (holder.variants || []).map((v) => ({
    id: v.id,
    status: v.status,
    parent: v.parent,
    instruction: v.instruction,
    note: v.note,
    rejection: v.rejection,
  }));
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
