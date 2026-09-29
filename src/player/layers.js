// Viñetas por capas (asset `type: 'layers'`): lógica pura, sin three ni DOM.
// La usan el preset panel (tiempos por capa), el motor GPU (profundidad, orden, VFX entre capas),
// `comic check` y `comic layers`. Formato en references/scene-format.md, "Viñetas por capas".
//
// Escala de profundidad `depth` (la misma que muestra el panel, 0..2; más alto = más cerca):
//   0 = fondo lejano · 1 = plano focal (la página: globos, textos) · 2 = muy cerca.
// Físicamente cada capa es un plano a distancia Z = (1 − depth) · DEPTH_UNIT · depthScale · D0 del plano
// focal (D0 = distancia de la cámara en reposo). Los textos van siempre en el plano focal (sin parallax).
import { easing, progress, mix, clamp } from './ease.js';

export const LAYER_ROLES = ['background', 'character', 'text', 'fx', 'divider', 'guide'];
export const DEPTH_UNIT = 0.6;
// profundidades por defecto (las escribe `comic layers`; se usan si el asset no trae depth)
export const ROLE_DEPTH = { background: 0.4, character: 1, text: 1, fx: 1.15, divider: 0.4, guide: 0 };
export const GLOBAL_BG_DEPTH = 0;
export const CHARACTER_DEPTH_RANGE = [0.75, 1];

// Z físico en unidades de D0 (positivo = detrás del plano focal)
export const depthToZ = (depth, depthScale = 1) => (1 - depth) * DEPTH_UNIT * depthScale;

// Rol por nombre de capa (heurística de `comic layers`; el resto se decide por tamaño/cobertura).
export function roleFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/margin|guide|guia|guía/.test(n)) return 'guide';
  if (/bkg|background|backdrop|fondo/.test(n)) return 'background';
  if (/dialog|rhyme|snif|text|bubble|balloon|globo|huh|caption|cartel|sfx|ono/.test(n)) return 'text';
  if (/lines|vertigo|speed|motion_fx|\bfx\b/.test(n)) return 'fx';
  if (/(^|_)div|divider|border|gutter/.test(n)) return 'divider';
  return null;
}

// palabras de un texto: `text` (transcripción) → `words` → estimación por área de alfa (~7000 px²/palabra)
export function wordsOf(l) {
  if (typeof l.text === 'string' && l.text.trim()) return l.text.trim().split(/\s+/).length;
  if (l.words > 0) return l.words;
  if (l.area > 0) return Math.max(1, Math.min(40, Math.round(l.area / 7000)));
  return null;
}

// Orden de lectura: por renglones (cajas que se solapan en vertical más del 40 %), izquierda → derecha.
export function readingOrder(items) {
  const rest = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of rest) {
    const row = rows.find((r) => {
      const top = Math.max(r.y0, it.y);
      const bot = Math.min(r.y1, it.y + it.h);
      return bot - top > 0.4 * Math.min(r.y1 - r.y0, it.h);
    });
    if (row) {
      row.items.push(it);
      row.y0 = Math.min(row.y0, it.y);
      row.y1 = Math.max(row.y1, it.y + it.h);
    } else rows.push({ y0: it.y, y1: it.y + it.h, items: [it] });
  }
  rows.sort((a, b) => a.y0 - b.y0);
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

const normSpec = (s, fallbackDur) => {
  if (!s) return null;
  if (typeof s === 'string') return s === 'none' ? null : { preset: s, duration: fallbackDur };
  if (!s.preset || s.preset === 'none') return null;
  return s;
};

// Capas del asset con los overrides de params.layers aplicados, en ORDEN DE DIBUJO.
// Cada una: { id, name, file, x, y, w, h, z, role, depth, Z (en unidades de D0), hidden, at, dur, enter, exit,
//             motion, clipTo, clipMask, keepOrder, index }
export function resolveLayers(asset, params = {}, duration = 4) {
  // overrides por id, '@tag' o 'layer:<id>' (los de id exacto pisan a los de tag)
  const ovAll = layerOverridesById(asset?.layers, params.layers);
  const depthScale = params.depthScale ?? 1;
  const auto = params.autoTiming !== false;
  const out = [];
  for (const l of asset?.layers || []) {
    const ov = ovAll[l.id] || {};
    const role = LAYER_ROLES.includes(ov.role) ? ov.role : LAYER_ROLES.includes(l.role) ? l.role : 'character';
    const depth = typeof ov.depth === 'number' ? ov.depth : typeof l.depth === 'number' ? l.depth : ROLE_DEPTH[role];
    const clipTo = 'clipTo' in ov ? (ov.clipTo ? resolveLayerRef(asset.layers, ov.clipTo) || ov.clipTo : null) : l.clipTo || null;
    out.push({
      ...l,
      role,
      depth,
      Z: role === 'text' ? 0 : depthToZ(depth, depthScale),
      hidden: role === 'guide' ? true : !!(ov.hidden ?? l.hidden),
      at: ov.at ?? l.at ?? null,
      dur: ov.dur ?? l.dur ?? null,
      enter: normSpec(ov.enter !== undefined ? ov.enter : l.enter, 0.4),
      exit: normSpec(ov.exit !== undefined ? ov.exit : l.exit, 0.3),
      motion: ov.motion !== undefined ? ov.motion : l.motion || null,
      clipTo,
      clipMask: l.clipMask && l.clipMask.for === clipTo ? l.clipMask : null,
    });
  }
  // guía (role guide): nunca se dibuja; para verla hay que cambiarle el rol con un override
  // tiempos automáticos: textos escalonados en orden de lectura (0.4 s + 0.25 s/palabra; 0.6 s si no hay datos)
  if (auto) {
    const texts = readingOrder(out.filter((r) => r.role === 'text' && !r.hidden && r.at == null && !r.attachedTo));
    let t = Math.min(0.5, duration * 0.12);
    const ats = [];
    for (const r of texts) {
      ats.push(t);
      const w = wordsOf(r);
      t += w ? 0.4 + 0.25 * w : 0.6;
    }
    // si no entran, se comprimen para que el último aparezca antes del 70 % de la viñeta
    const last = ats.length ? ats[ats.length - 1] : 0;
    const lim = duration * 0.7;
    const k = last > lim && last > 0 ? lim / last : 1;
    texts.forEach((r, i) => {
      r.at = +(ats[i] * k).toFixed(3);
      if (!r.enter && !(r.id in ovAll && 'enter' in ovAll[r.id])) r.enter = { preset: 'pop', duration: 0.35 };
    });
    // adornos pegados a un texto (ej. el bastón de caramelo del cartel) entran con él
    for (const r of out) {
      if (!r.attachedTo || r.at != null) continue;
      const host = out.find((h) => h.id === r.attachedTo);
      if (host) {
        r.at = host.at;
        if (!r.enter && !(ovAll[r.id] && 'enter' in ovAll[r.id])) r.enter = host.enter;
      }
    }
  }
  for (const r of out) if (r.at == null) r.at = 0;
  // orden de dibujo: el del PSD (z); los textos suben arriba de todo salvo que tapen/estén tapados por algo
  // que en el PSD va encima (keepOrder, lo calcula `comic layers` mirando el alfa)
  out.sort((a, b) => a.z - b.z);
  const lifted = (r) => r.role === 'text' && !r.keepOrder;
  const order = [...out.filter((r) => !lifted(r)), ...out.filter(lifted)];
  order.forEach((r, i) => (r.index = i));
  return order;
}

// ---------- entrada / salida numéricas (misma matemática que inOut() del preset panel) ----------
function defaultEnterEase(preset) {
  return { pop: 'spring', slam: 'springHard', drop: 'spring', scale: 'backOut' }[preset] || 'easeOut';
}

// Afines 2D [a,b,c,d,e,f] (como DOMMatrix: x' = a x + c y + e, y' = b x + d y + f)
const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];
const S = (s) => [s, 0, 0, s, 0, 0];
const R = (deg) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};

function inOutNumeric(t, duration, enter, exit, w, h) {
  const out = { opacity: 1, m: [1, 0, 0, 1, 0, 0], clip: [0, 0, 0, 0] }; // clip: inset l,t,r,b (0..1)
  const apply = (spec, p, dir) => {
    const k = easing(spec.ease || (dir === 'in' ? defaultEnterEase(spec.preset) : 'easeIn'), spec.duration || 0.4)(dir === 'in' ? p : 1 - p);
    switch (spec.preset) {
      case 'fade':
        out.opacity *= clamp(0, 1, k);
        break;
      case 'pop':
        out.opacity *= clamp(0, 1, k * 3);
        out.m = mul(out.m, S(Math.max(0, k)));
        break;
      case 'scale':
        out.opacity *= clamp(0, 1, k);
        out.m = mul(out.m, S(mix(0.6, 1, k)));
        break;
      case 'slam':
        out.opacity *= clamp(0, 1, k * 4);
        out.m = mul(out.m, S(mix(3, 1, k)));
        break;
      case 'drop':
        out.opacity *= clamp(0, 1, k * 3);
        out.m = mul(out.m, T(0, (mix(-120, 0, k) / 100) * h));
        break;
      case 'slideLeft':
        out.m = mul(out.m, T((mix(110, 0, k) / 100) * w, 0));
        break;
      case 'slideRight':
        out.m = mul(out.m, T((mix(-110, 0, k) / 100) * w, 0));
        break;
      case 'slideUp':
        out.m = mul(out.m, T(0, (mix(110, 0, k) / 100) * h));
        break;
      case 'slideDown':
        out.m = mul(out.m, T(0, (mix(-110, 0, k) / 100) * h));
        break;
      case 'wipeRight':
        out.clip[2] = Math.max(out.clip[2], mix(1, 0, clamp(0, 1, k)));
        break;
      case 'wipeDown':
        out.clip[3] = Math.max(out.clip[3], mix(1, 0, clamp(0, 1, k)));
        break;
    }
  };
  if (enter) {
    const d = enter.duration ?? 0.4;
    if (t < d) apply(enter, progress(t, 0, d), 'in');
  }
  if (exit) {
    const d = exit.duration ?? 0.3;
    if (t > duration - d) apply(exit, progress(t, duration - d, d), 'out');
  }
  return out;
}

// Estado de una capa en el tiempo local de la viñeta: visible, opacidad, afín (px del asset, alrededor del
// centro de la capa) y recorte (wipe) en fracciones de la capa.
export function layerState(L, t, panelDuration) {
  const at = L.at || 0;
  const dur = L.dur > 0 ? L.dur : Math.max(0, panelDuration - at);
  const lt = t - at;
  if (L.hidden || lt < 0 || lt >= dur + (L.dur > 0 ? 0 : 1e9)) return { visible: false, opacity: 0, m: [1, 0, 0, 1, 0, 0], clip: [0, 0, 0, 0] };
  const io = inOutNumeric(lt, dur, L.enter, L.exit, L.w, L.h);
  const cx = L.x + L.w / 2;
  const cy = L.y + L.h / 2;
  let m = io.m;
  const mo = L.motion;
  if (mo && (mo.dx || mo.dy || mo.rotate || (mo.scale != null && mo.scale !== 1))) {
    const p = easing(mo.ease || 'easeInOut', dur)(progress(lt, 0, dur));
    m = mul(mul(mul(T((mo.dx || 0) * p, (mo.dy || 0) * p), R((mo.rotate || 0) * p)), S(mix(1, mo.scale ?? 1, p))), m);
  }
  return { visible: io.opacity > 0, opacity: io.opacity, m: mul(mul(T(cx, cy), m), T(-cx, -cy)), clip: io.clip };
}

// Ángulos de órbita (grados) en el tiempo local: de `from` (o 0) a {yaw, pitch} con ease.
export function orbitAt(orbit, t, duration) {
  if (!orbit || (!orbit.yaw && !orbit.pitch && !orbit.from)) return [0, 0];
  const e = easing(orbit.ease || 'easeInOut', duration)(progress(t, 0, duration));
  const f = orbit.from || {};
  return [mix(f.yaw || 0, orbit.yaw || 0, e), mix(f.pitch || 0, orbit.pitch || 0, e)];
}

// DOF: { amount, focus } (focus en la escala depth; por defecto el plano focal = 1)
export function dofOf(dof) {
  if (!dof) return { amount: 0, focus: 1 };
  if (typeof dof === 'number') return { amount: Math.max(0, dof), focus: 1 };
  return { amount: Math.max(0, dof.amount || 0), focus: dof.focus ?? 1 };
}

// Dónde va un VFX dentro de una viñeta de capas: { order (posición en el orden de dibujo, fraccionaria),
// Z (unidades de D0) }. `between: [atrás, adelante]`, `z` (escala depth) o `layer` back|mid|front|screen.
export function vfxPlacement(resolved, { layer = 'mid', between = null, z = null } = {}, depthScale = 1) {
  const vis = resolved.filter((r) => !r.hidden);
  if (layer === 'screen') return { order: 1e4, Z: 0, screen: true };
  const byId = (ref) => {
    const id = resolveLayerRef(resolved, ref);
    return vis.find((r) => r.id === id);
  };
  if (Array.isArray(between) && between.length === 2) {
    const a = byId(between[0]);
    const b = byId(between[1]);
    if (a && b) return { order: a.index + 0.5, Z: (a.Z + b.Z) / 2 };
    if (a) return { order: a.index + 0.5, Z: a.Z };
    if (b) return { order: b.index - 0.5, Z: b.Z };
  }
  if (typeof z === 'number') {
    const Zv = depthToZ(z, depthScale);
    let after = -1;
    for (const r of vis) if (r.role !== 'text' && r.Z > Zv) after = Math.max(after, r.index);
    return { order: after + 0.5, Z: Zv };
  }
  if (!vis.length) return { order: 0, Z: 0 };
  const maxZ = Math.max(...vis.map((r) => r.Z));
  const minZ = Math.min(0, ...vis.map((r) => r.Z));
  if (layer === 'back') {
    // delante del fondo más lejano (ej. black_bkg), detrás del fondo de la viñeta
    const far = vis.filter((r) => r.Z >= maxZ - 1e-9);
    const lastFar = far[far.length - 1];
    const next = vis.find((r) => r.index > lastFar.index);
    return { order: lastFar.index + 0.5, Z: next ? (lastFar.Z + next.Z) / 2 : lastFar.Z };
  }
  if (layer === 'front') return { order: vis[vis.length - 1].index + 0.5, Z: minZ };
  // mid: entre el último fondo/divisor y el primer personaje
  const firstChar = vis.find((r) => r.role === 'character' || r.role === 'fx');
  if (!firstChar) return { order: vis[vis.length - 1].index + 0.5, Z: 0 };
  const prev = [...vis].reverse().find((r) => r.index < firstChar.index);
  return { order: firstChar.index - 0.5, Z: prev ? (prev.Z + firstChar.Z) / 2 : firstChar.Z };
}

// Referencia a una capa desde params: 'layer:<id>', '<id>' o '@<tag>' (tags que pone `comic layers`, p.ej. @hero, @bg-main).
// Con '@tag' devuelve la primera capa (de adelante hacia atrás) que lo tenga. Devuelve el id o null.
export function resolveLayerRef(layers, ref) {
  if (!ref || typeof ref !== 'string' || !Array.isArray(layers)) return null;
  if (ref.startsWith('@')) {
    const tag = ref.slice(1);
    const hit = [...layers].sort((a, b) => (b.z ?? 0) - (a.z ?? 0)).find((l) => (l.tags || []).includes(tag));
    return hit ? hit.id : null;
  }
  const id = ref.startsWith('layer:') ? ref.slice(6) : ref;
  return layers.some((l) => l.id === id) ? id : null;
}

// params.layers con claves '@tag' / 'layer:<id>' → { id: override }. Primero se aplican las de tag y
// encima las de id exacto (lo escrito a mano para una capa concreta gana). Las que no resuelven se descartan.
export function layerOverridesById(layers, ov) {
  if (!ov || typeof ov !== 'object') return {};
  const keys = Object.keys(ov);
  if (!keys.some((k) => k.startsWith('@') || k.startsWith('layer:'))) return ov;
  const out = {};
  for (const k of keys.filter((k) => k.startsWith('@'))) {
    const id = resolveLayerRef(layers, k);
    if (id) out[id] = { ...(out[id] || {}), ...ov[k] };
  }
  for (const k of keys.filter((k) => !k.startsWith('@'))) {
    const id = k.startsWith('layer:') ? k.slice(6) : k;
    out[id] = { ...(out[id] || {}), ...ov[k] };
  }
  return out;
}
