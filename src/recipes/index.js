// Recetas de escena: funciones puras (ctx) → clips normales y editables (cámara move3d, overrides de capas
// de la viñeta, fx/ono/shake/flash, vfx). No son un formato nuevo: después de aplicarlas queda scene.json
// común, que se revisa, aprueba o retoca como cualquier otro. Ver references/camera-recipes.md.
//
// Contrato de una receta (src/recipes/<id>.js):
//   { id, label, mood, description, expand(ctx) → { summary, clips: [ClipHolder], layers?: { idCapa: override },
//     panel?: { param: valor }, notes?: [texto] } }
//   ctx = { scene, holder (escena), variant (variante de escena de partida), meta, stage, g (mainPanel: capas,
//           tags, ref('@tag'), box(capa) en px de página, textos en orden de lectura), panelStart, T0 (s de escena),
//           D (duración), target ('@tag' | 'layer:<id>' | null), replaceCamera, hasViewCamera, opts }
import { activeVariant, nextVariantId } from '../shared/scene.js';
import { mainPanel } from './geometry.js';
import { BUILTIN } from '../player/presets.js';
import establishing from './establishing.js';
import dialogue from './dialogue.js';
import heroEntrance from './hero-entrance.js';
import reveal from './reveal.js';
import tension from './tension.js';
import impact from './impact.js';

export const RECIPES = [establishing, dialogue, heroEntrance, reveal, tension, impact];
const byId = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

export const listRecipes = () => RECIPES.map(({ id, label, mood, description }) => ({ id, label, mood, description }));

const VIEW_CAMERAS = ['camera', 'move3d'];

// Expande una receta sobre la variante activa de una escena (sin escribir nada).
export function expandRecipe(scene, sceneId, name, opts = {}) {
  const recipe = byId[name];
  if (!recipe) throw new Error(`receta desconocida "${name}" (${RECIPES.map((r) => r.id).join(', ')})`);
  const holder = (scene.scenes || []).find((s) => s.id === sceneId);
  if (!holder) throw new Error(`escena no encontrada: ${sceneId}`);
  const variant = activeVariant(holder);
  const g = mainPanel(scene, variant);
  if (!g) throw new Error(`la escena ${sceneId} no tiene viñetas`);
  if (!g.isLayers) throw new Error(`la escena ${sceneId} no usa una viñeta por capas: las recetas necesitan tags (comic layers)`);
  const T0 = Math.max(0, Math.min(variant.duration - 0.2, +opts.at || 0));
  const D = Math.max(0.2, Math.min(variant.duration - T0, opts.duration ? +opts.duration : variant.duration - T0));
  const target = opts.target || null;
  if (target && !g.ref(target)) throw new Error(`--target ${target} no resuelve a ninguna capa de ${g.params.asset} (mirá comic tags)`);
  const hasViewCamera = (variant.clips || []).some((c) => c.track === 'camera' && VIEW_CAMERAS.includes(activeVariant(c)?.preset));
  const ctx = { scene, holder, variant, meta: scene.meta, stage: g.stage, g, panelStart: activeVariant(g.clip).start || 0, T0, D, target, replaceCamera: !!opts.replaceCamera, hasViewCamera, opts };
  const res = recipe.expand(ctx);
  res.notes = res.notes || [];
  // params de viñeta que ya valen eso (con defaults y panelDefaults) no justifican una variante nueva
  if (res.panel) {
    const def = Object.fromEntries((BUILTIN.find((d) => d.id === 'panel')?.params || []).map((p) => [p.key, p.default]));
    for (const [k, val] of Object.entries(res.panel)) if (JSON.stringify(g.params[k] ?? def[k]) === JSON.stringify(val)) delete res.panel[k];
  }
  if (hasViewCamera && !opts.replaceCamera && res.clips.some((c) => c.track === 'camera' && VIEW_CAMERAS.includes(c.variants[0].preset)))
    res.notes.push('la escena ya tiene una cámara con recorrido: las dos compiten (gana la última). Usá --replace-camera para reemplazarla');
  return { recipe, holder, variant, g, res };
}

// Aplica la receta. Si la variante activa de la escena está aprobada (o hay que sacar clips aprobados),
// crea una variante NUEVA de escena copiando la activa (draft, parent = la activa) y aplica ahí: lo
// aprobado queda intacto. Si no, agrega los clips a la variante activa (draft). La viñeta nunca se edita
// en su lugar: los overrides van en una variante nueva del clip de la viñeta, que queda activa.
export function applyRecipe(scene, sceneId, name, opts = {}) {
  const { recipe, holder, variant: base, g, res } = expandRecipe(scene, sceneId, name, opts);
  const removing = opts.replaceCamera ? (base.clips || []).filter((c) => c.track === 'camera' && VIEW_CAMERAS.includes(activeVariant(c)?.preset)) : [];
  const created = base.status === 'approved' || !!opts.newVariant || removing.some((c) => c.variants.some((v) => v.status === 'approved'));
  let v = base;
  if (created) {
    v = structuredClone(base);
    for (const k of ['approvedHash', 'note', 'rejection', 'request', 'createdAt']) delete v[k];
    Object.assign(v, { id: nextVariantId(holder), status: 'draft', parent: base.id, instruction: `receta ${recipe.id}`, summary: res.summary, createdAt: new Date().toISOString() });
    holder.variants.push(v);
    if (opts.activate) holder.active = v.id;
  }
  if (removing.length) {
    const drop = new Set(removing.map((c) => c.id));
    v.clips = v.clips.filter((c) => !drop.has(c.id));
  }
  const ids = new Set(v.clips.map((c) => c.id));
  const added = [];
  for (const c of res.clips) {
    let id = c.id;
    for (let n = 2; ids.has(id); n++) id = `${c.id}_${n}`;
    ids.add(id);
    const e = c.variants[0];
    if (e.start + e.duration > v.duration) e.duration = +Math.max(0.05, v.duration - e.start).toFixed(3);
    v.clips.push({ ...c, id });
    added.push({ id, track: c.track, preset: e.preset, start: e.start, duration: e.duration, params: e.params });
  }
  let panelVariant = null;
  if ((res.layers && Object.keys(res.layers).length) || (res.panel && Object.keys(res.panel).length)) {
    const pc = v.clips.find((c) => c.id === g.clip.id);
    const pv = activeVariant(pc);
    const nv = structuredClone(pv);
    for (const k of ['approvedHash', 'note', 'rejection', 'request', 'createdAt']) delete nv[k];
    const params = { ...(nv.params || {}), ...(res.panel || {}) };
    if (res.layers && Object.keys(res.layers).length) {
      params.layers = { ...(params.layers || {}) };
      for (const [id, o] of Object.entries(res.layers)) params.layers[id] = { ...(params.layers[id] || {}), ...o };
    }
    Object.assign(nv, { id: nextVariantId(pc), status: 'draft', parent: pv.id, instruction: `receta ${recipe.id}`, summary: `overrides de la receta ${recipe.id}`, params, createdAt: new Date().toISOString() });
    pc.variants.push(nv);
    pc.active = nv.id;
    panelVariant = { clip: pc.id, id: nv.id, panel: res.panel || {}, layers: res.layers || {} };
  }
  if (!created && !v.summary) v.summary = res.summary;
  return { recipe: recipe.id, sceneId, variant: v.id, base: base.id, created, activated: created && !!opts.activate, removed: removing.map((c) => c.id), added, panelVariant, summary: res.summary, notes: res.notes };
}
