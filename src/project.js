// Acceso a un proyecto en disco: scene.json (fuente de verdad), history.jsonl, efectos custom.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BUILTIN, defaultsOf, ENTERS } from './player/presets.js';
import { TRACKS, activeVariant, nextVariantId, findTarget, layoutScenes } from './shared/scene.js';
import { vfxNeeds } from './player/vfx/index.js';
import { unsupportedGpuFilters } from './player/gpu/filter-support.js';
import { LAYER_ROLES } from './player/layers.js';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sha(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export class Conflict extends Error {}

export function openProject(dir) {
  dir = path.resolve(dir);
  const scenePath = path.join(dir, 'scene.json');
  if (!fs.existsSync(scenePath)) throw new Error(`No hay scene.json en ${dir}. Usá: comic init ${dir}`);
  const internal = path.join(dir, '.comic');
  fs.mkdirSync(internal, { recursive: true });
  return {
    dir,
    scenePath,
    internal,
    read() {
      const text = fs.readFileSync(scenePath, 'utf8');
      return { scene: JSON.parse(text), rev: sha(text) };
    },
    rev() {
      return sha(fs.readFileSync(scenePath, 'utf8'));
    },
    write(scene, baseRev) {
      if (baseRev && baseRev !== this.rev()) throw new Conflict('scene.json cambió desde que lo cargaste');
      const text = JSON.stringify(scene, null, 2) + '\n';
      const tmp = scenePath + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, scenePath);
      return sha(text);
    },
    history(events) {
      if (!events?.length) return;
      fs.appendFileSync(path.join(dir, 'history.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    },
    customEffects() {
      const d = path.join(dir, 'effects');
      if (!fs.existsSync(d)) return [];
      return fs
        .readdirSync(d)
        .filter((f) => f.endsWith('.js'))
        // effects/<id>.js (clip/filtro/transición) o effects/<id>.vfx.js (VFX GPU, kind 'vfx')
        .map((f) => ({ id: f.replace(/(\.vfx)?\.js$/, ''), vfx: f.endsWith('.vfx.js'), file: 'effects/' + f, url: '/p/effects/' + f }));
    },
  };
}

export function newScene({ title = 'Sin título', width = 1920, height = 1080, fps = 24 } = {}) {
  return {
    meta: { title, width, height, fps, background: '#f4efe3', generatorModel: 'sonnet', maxVariants: 3, generatorConcurrency: 3 },
    assets: {},
    scenes: [],
  };
}

// Catálogo de presets serializable (para el panel y el generador headless).
export function catalog(project) {
  const builtin = BUILTIN.map((d) => ({ id: d.id, kind: d.kind, label: d.label, params: d.params || [], defaults: defaultsOf(d) }));
  const custom = project ? project.customEffects().map((c) => ({ id: c.id, kind: c.vfx ? 'vfx' : 'custom', label: c.id, custom: true, url: c.url })) : [];
  return { builtin, custom };
}

// ---------- validación ----------
export function validate(scene, project) {
  const errors = [];
  const warnings = [];
  const ids = new Set(BUILTIN.map((d) => d.id));
  const kinds = Object.fromEntries(BUILTIN.map((d) => [d.id, d.kind]));
  const customList = project ? project.customEffects() : [];
  const custom = new Set(customList.map((c) => c.id));
  const customVfx = new Set(customList.filter((c) => c.vfx).map((c) => c.id));
  const defs = Object.fromEntries(BUILTIN.map((d) => [d.id, d]));
  const m = scene.meta || {};
  if (!m.width || !m.height || !m.fps) errors.push('meta.width/height/fps faltan');
  // dirección (modo guiado): objeto libre de textos; no participa del hash de aprobación
  const checkDirection = (d, where) => {
    if (d == null) return;
    if (typeof d !== 'object' || Array.isArray(d)) warnings.push(`${where}: direction tiene que ser un objeto { clave: texto }`);
    else for (const [k, v] of Object.entries(d)) if (typeof v !== 'string') warnings.push(`${where}: direction.${k} no es texto`);
  };
  checkDirection(m.direction, 'meta');
  const assetIds = new Set(Object.keys(scene.assets || {}));
  for (const [id, a] of Object.entries(scene.assets || {})) {
    if (!a.file) errors.push(`asset ${id}: falta file`);
    else if (project && !fs.existsSync(path.join(project.dir, a.file))) errors.push(`asset ${id}: no existe ${a.file}`);
    if (!a.w || !a.h) errors.push(`asset ${id}: faltan w/h (usá comic ingest)`);
    if (a.type === 'video' && a.proxy && project && !fs.existsSync(path.join(project.dir, a.proxy))) errors.push(`asset ${id}: no existe proxy ${a.proxy}`);
    if (a.type === 'layers') checkLayersAsset(id, a, project, errors, warnings);
  }
  const sceneIds = new Set();
  for (const s of scene.scenes || []) {
    const where = `escena ${s.id}`;
    if (!s.id) errors.push('escena sin id');
    if (sceneIds.has(s.id)) errors.push(`${where}: id repetido`);
    sceneIds.add(s.id);
    checkDirection(s.direction, where);
    if (!s.variants?.length) {
      errors.push(`${where}: sin variantes`);
      continue;
    }
    if (s.active && !s.variants.some((v) => v.id === s.active)) errors.push(`${where}: active=${s.active} no existe`);
    checkHolderStatus(s, where, errors);
    for (const v of s.variants) {
      const w2 = `${where}/${v.id}`;
      if (!(v.duration > 0)) errors.push(`${w2}: duration inválida`);
      if (v.transition && !ids.has(v.transition.preset) && !custom.has(v.transition.preset)) errors.push(`${w2}: transición desconocida ${v.transition.preset}`);
      if (v.transition && ids.has(v.transition.preset) && kinds[v.transition.preset] !== 'transition') errors.push(`${w2}: ${v.transition.preset} no es una transición`);
      const clipIds = new Set();
      const panelOf = {};
      for (const c of v.clips || []) if (c.track === 'panel') panelOf[c.id] = activeVariant(c);
      const firstPanel = Object.keys(panelOf)[0] || null;
      const gpuMode = {};
      for (const c of v.clips || []) {
        const av = activeVariant(c);
        if (!av || av.status === 'hidden') continue;
        if (c.track === 'panel' && (av.params?.gpu || scene.assets?.[av.params?.asset]?.type === 'layers')) gpuMode[c.id] = 'full';
        if (c.track !== 'vfx') continue;
        const tgt = av.params?.target || firstPanel;
        const w3 = `${w2}/${c.id}/${av.id}`;
        if (!tgt) errors.push(`${w3}: VFX sin viñeta en la escena`);
        else if (!panelOf[tgt]) errors.push(`${w3}: target "${tgt}" no es una viñeta de la escena`);
        else {
          const m = customVfx.has(av.preset) ? 'full' : vfxNeeds(defs[av.preset], av.params);
          if (m) gpuMode[tgt] = gpuMode[tgt] === 'full' || m === 'full' ? 'full' : 'overlay';
        }
        const an = av.params?.anchor;
        if (an != null && !(Array.isArray(an) && an.length === 2 && an.every((x) => typeof x === 'number'))) errors.push(`${w3}: anchor tiene que ser [x, y] en px de página`);
        if (av.params?.layer && !['back', 'mid', 'front'].includes(av.params.layer)) errors.push(`${w3}: layer inválido ${av.params.layer} (back|mid|front)`);
        // between / z: solo en viñetas por capas
        const btw = av.params?.between;
        const tAsset = tgt && panelOf[tgt] ? scene.assets?.[panelOf[tgt].params?.asset] : null;
        if (btw != null || av.params?.z != null) {
          if (tAsset?.type !== 'layers') warnings.push(`${w3}: between/z solo sirven con una viñeta por capas (se usa layer)`);
          else if (btw != null) {
            const ids = new Set(tAsset.layers.map((l) => l.id));
            if (!Array.isArray(btw) || btw.length !== 2) errors.push(`${w3}: between tiene que ser [idAtrás, idAdelante]`);
            else for (const b of btw) if (!ids.has(b)) errors.push(`${w3}: between menciona la capa "${b}", que no está en ${panelOf[tgt].params.asset}`);
          }
          if (av.params?.z != null && typeof av.params.z !== 'number') errors.push(`${w3}: z tiene que ser un número (escala depth 0..2)`);
        }
      }
      for (const [pid, mode] of Object.entries(gpuMode)) {
        if (mode !== 'full') continue;
        const pv = panelOf[pid];
        for (const f of unsupportedGpuFilters(pv.params?.filters)) warnings.push(`${w2}/${pid}: filtro ${f} no soportado en viñeta GPU (se ignora)`);
      }
      for (const c of v.clips || []) {
        const w3 = `${w2}/${c.id}`;
        if (clipIds.has(c.id)) errors.push(`${w3}: id de clip repetido`);
        clipIds.add(c.id);
        if (!TRACKS.includes(c.track)) errors.push(`${w3}: track inválido ${c.track}`);
        if (!c.variants?.length) {
          errors.push(`${w3}: sin variantes`);
          continue;
        }
        if (c.active && !c.variants.some((x) => x.id === c.active)) errors.push(`${w3}: active=${c.active} no existe`);
        checkHolderStatus(c, w3, errors);
        for (const cv of c.variants) {
          const w4 = `${w3}/${cv.id}`;
          if (!ids.has(cv.preset) && !custom.has(cv.preset)) errors.push(`${w4}: preset desconocido ${cv.preset}`);
          else if (ids.has(cv.preset)) {
            const k = kinds[cv.preset];
            const want = c.track === 'camera' ? 'camera' : c.track;
            if (k !== want) errors.push(`${w4}: preset ${cv.preset} es ${k} pero el track es ${c.track}`);
          } else if (c.track === 'vfx' && !customVfx.has(cv.preset)) {
            errors.push(`${w4}: el efecto custom ${cv.preset} no es VFX (tiene que llamarse effects/${cv.preset}.vfx.js)`);
          }
          if (typeof cv.start !== 'number' || cv.start < 0) errors.push(`${w4}: start inválido`);
          if (!(cv.duration > 0)) errors.push(`${w4}: duration inválida`);
          if (cv.start + cv.duration > v.duration + 1e-6 && cv === activeVariant(c)) warnings.push(`${w4}: termina en ${(cv.start + cv.duration).toFixed(2)}s, después del fin de la escena (${v.duration}s)`);
          const a = cv.params?.asset;
          if (a && !assetIds.has(a)) errors.push(`${w4}: asset desconocido ${a}`);
          if (cv.preset === 'panel' && !a) warnings.push(`${w4}: viñeta sin asset`);
          if (cv.preset === 'panel' && cv.params?.depth && a && scene.assets[a]?.type !== 'layers' && !scene.assets[a]?.cutout) warnings.push(`${w4}: depth>0 pero el asset ${a} no tiene cutout (comic cutout)`);
          if (cv.preset === 'panel' && a && scene.assets[a]?.type === 'layers') checkLayerOverrides(w4, scene.assets[a], cv.params, errors, warnings);
          else if (cv.preset === 'panel' && cv.params?.layers) warnings.push(`${w4}: params.layers solo sirve con un asset type 'layers'`);
          for (const f of cv.params?.filters || []) if (!ids.has(f.preset) && !custom.has(f.preset)) errors.push(`${w4}: filtro desconocido ${f.preset}`);
          if (cv.preset === 'camera') for (const k of cv.params?.keys || []) if (k.panel && !(v.clips || []).some((x) => x.id === k.panel)) errors.push(`${w4}: la cámara apunta a la viñeta ${k.panel} que no existe`);
        }
      }
    }
  }
  if ((scene.scenes || []).length && !layoutScenes(scene).length) errors.push('ninguna escena tiene variante activa');
  return { errors, warnings };
}

// ---------- viñetas por capas ----------
function checkLayersAsset(id, a, project, errors, warnings) {
  if (!Array.isArray(a.layers) || !a.layers.length) return errors.push(`asset ${id}: type 'layers' sin layers`);
  const ids = new Map();
  for (const l of a.layers) {
    const w = `asset ${id}/capa ${l.id}`;
    if (!l.id) errors.push(`asset ${id}: capa sin id`);
    if (ids.has(l.id)) errors.push(`${w}: id repetido`);
    ids.set(l.id, l);
    if (!l.file) errors.push(`${w}: falta file`);
    else if (project && !fs.existsSync(path.join(project.dir, l.file))) errors.push(`${w}: no existe ${l.file}`);
    for (const k of ['x', 'y', 'w', 'h']) if (typeof l[k] !== 'number') errors.push(`${w}: falta ${k} (px del lienzo)`);
    if (!(l.w > 0 && l.h > 0)) errors.push(`${w}: w/h inválidos`);
    if (l.role && !LAYER_ROLES.includes(l.role)) errors.push(`${w}: rol inválido ${l.role} (${LAYER_ROLES.join('|')})`);
    if (l.depth != null && typeof l.depth !== 'number') errors.push(`${w}: depth tiene que ser un número (0..2)`);
    if (l.clipMask?.file && project && !fs.existsSync(path.join(project.dir, l.clipMask.file))) errors.push(`${w}: no existe la máscara ${l.clipMask.file}`);
  }
  for (const l of a.layers) {
    if (!l.clipTo) continue;
    const bg = ids.get(l.clipTo);
    if (!bg) errors.push(`asset ${id}/capa ${l.id}: clipTo "${l.clipTo}" no existe`);
    else if (bg === l) errors.push(`asset ${id}/capa ${l.id}: clipTo a sí misma`);
    else if (bg.role !== 'background') warnings.push(`asset ${id}/capa ${l.id}: clipTo "${l.clipTo}" no es un fondo (role ${bg.role})`);
  }
}

function checkLayerOverrides(where, asset, params, errors, warnings) {
  const ids = new Map(asset.layers.map((l) => [l.id, l]));
  const ov = params?.layers;
  if (ov != null && (typeof ov !== 'object' || Array.isArray(ov))) return errors.push(`${where}: params.layers tiene que ser { idCapa: { … } }`);
  for (const [lid, o] of Object.entries(ov || {})) {
    const w = `${where}/capa ${lid}`;
    if (!ids.has(lid)) {
      warnings.push(`${w}: la capa no existe en el asset (override ignorado)`);
      continue;
    }
    if (o.role != null && !LAYER_ROLES.includes(o.role)) errors.push(`${w}: rol inválido ${o.role} (${LAYER_ROLES.join('|')})`);
    if (o.depth != null && typeof o.depth !== 'number') errors.push(`${w}: depth tiene que ser un número (0..2)`);
    if (o.clipTo) {
      if (!ids.has(o.clipTo)) errors.push(`${w}: clipTo "${o.clipTo}" no existe`);
      else if (o.clipTo === lid) errors.push(`${w}: clipTo a sí misma`);
    }
    for (const k of ['at', 'dur']) if (o[k] != null && !(typeof o[k] === 'number' && o[k] >= 0)) errors.push(`${w}: ${k} tiene que ser segundos >= 0`);
    for (const k of ['enter', 'exit']) {
      const sp = o[k];
      const preset = typeof sp === 'string' ? sp : sp?.preset;
      if (sp != null && !ENTERS.includes(preset)) errors.push(`${w}: ${k} desconocido ${preset} (${ENTERS.join('|')})`);
    }
  }
  const o = params?.orbit;
  if (o != null && (typeof o !== 'object' || Array.isArray(o))) errors.push(`${where}: orbit tiene que ser { yaw, pitch } en grados`);
  const d = params?.dof;
  if (d != null && typeof d !== 'number' && typeof d !== 'object') errors.push(`${where}: dof tiene que ser un número 0..1 o { amount, focus }`);
}

function checkHolderStatus(h, where, errors) {
  const ok = ['draft', 'approved', 'rejected', 'hidden'];
  let approved = 0;
  for (const v of h.variants) {
    if (!v.id) errors.push(`${where}: variante sin id`);
    if (!ok.includes(v.status)) errors.push(`${where}/${v.id}: status inválido ${v.status}`);
    if (v.status === 'approved') approved++;
  }
  if (approved > 1) errors.push(`${where}: más de una variante aprobada`);
}

// ---------- integración de variantes generadas ----------
// raw: salida del generador. Para clip: {preset,start,duration,ease?,params,summary}.
// Para escena: {duration, transition?, stage?, summary, clips:[{id,track,label,preset,start,duration,ease?,params}]}
export function mergeGenerated(scene, target, raw, { parent, instruction, requestId }) {
  const { holder, level } = findTarget(scene, target);
  if (!holder) throw new Error('target ya no existe');
  const id = nextVariantId(holder);
  const base = { id, status: 'draft', parent: parent || undefined, instruction: instruction || undefined, summary: raw.summary || undefined, request: requestId, createdAt: new Date().toISOString() };
  let v;
  if (level === 'clip') {
    v = { ...base, preset: raw.preset, start: +raw.start, duration: +raw.duration, ease: raw.ease, params: raw.params || {} };
  } else {
    v = {
      ...base,
      duration: +raw.duration,
      stage: raw.stage,
      transition: raw.transition,
      clips: (raw.clips || []).map((c) =>
        c.variants
          ? c
          : { id: c.id, track: c.track, label: c.label || c.id, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset: c.preset, start: +c.start, duration: +c.duration, ease: c.ease, params: c.params || {} }] },
      ),
    };
  }
  for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  holder.variants.push(v);
  return v;
}
