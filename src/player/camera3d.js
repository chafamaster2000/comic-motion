// Cámara 3D: preset `move3d` (movimientos clásicos de cámara sobre viñetas por capas y planas), composición
// pura de los clips de cámara (la usan el player y `comic check --gaps`) y el chequeo de huecos por escena.
// Todo es función pura de t. Formato y ejemplos en references/scene-format.md, "Cámara 3D (move3d) y límites".
//
// Cada movimiento es un cambio sobre (C = centro, D = distancia/zoom, FOV) expresado con la MISMA interfaz que
// las cámaras 2D: { view: {cx, cy, w, rotate}, dx, dy, drot, dzoom } más tres canales para el rig de capas:
//   dist  factor de distancia a igual encuadre del plano focal (dolly zoom: cambia la perspectiva, no el tamaño
//         del plano focal; equivale a cambiar el FOV, que el rig no expone: D = D0·s0/s·dist)
//   orbit [yaw, pitch] en grados, se suma a la órbita de la viñeta (arc, crane)
//   dof   { amount, focus } que reemplaza al dof de la viñeta (rackFocus)
// Así el pipeline 2D → 3D, la paridad de capas y los globos DOM no cambian.
import { easing, progress, mix, clamp } from './ease.js';
import { resolveLayerRef } from './layers.js';
import { hashString, mulberry32, activeClips, layoutScenes } from '../shared/scene.js';
import { panelModel, safeView, isFullBleed, defaultView, cameraAffine, boxToPage, ap, regionOutside, SIDE_ES, fmtPx } from './bounds.js';

// ---------- composición de clips de cámara (player y check) ----------
// Los clips `camera` y `move3d` sostienen su vista al terminar; los efectos (shake, dutch, dolly) terminan con su clip.
export const holdsView = (def) => def?.id === 'camera' || !!def?.holds;

// cams: [{ variant, def, rt }] en orden de clip. local: segundos de la escena.
export function cameraResultsAt(cams, local) {
  const out = [];
  for (const r of cams) {
    const cs = r.variant.start || 0;
    const ce = cs + (r.variant.duration || 0);
    if (local < cs) continue;
    const lt = Math.min(local - cs, r.variant.duration || 0);
    const res = r.rt.update ? r.rt.update(lt) || {} : {};
    if (local >= ce && !holdsView(r.def)) continue;
    out.push(res);
  }
  return out;
}

export function composeCamera(base, results) {
  let view = base;
  let dx = 0;
  let dy = 0;
  let drot = 0;
  let dzoom = 1;
  let dist = 1;
  let yaw = 0;
  let pitch = 0;
  let dof = null;
  for (const res of results) {
    if (res.view) view = { ...view, ...res.view };
    dx += res.dx || 0;
    dy += res.dy || 0;
    drot += res.drot || 0;
    dzoom *= res.dzoom || 1;
    dist *= res.dist || 1;
    if (res.orbit) {
      yaw += res.orbit[0] || 0;
      pitch += res.orbit[1] || 0;
    }
    if (res.dof) dof = res.dof;
  }
  return { view, dx, dy, drot, dzoom, dist, orbit: [yaw, pitch], dof };
}

// ---------- move3d ----------
const SAFE_PX = -0.5; // misma tolerancia que safeView/check
export const MOVES = ['pushIn', 'pullOut', 'truck', 'pedestal', 'dollyZoom', 'arc', 'crane', 'reveal', 'rackFocus', 'handheld', 'breathe'];
// recorrido nominal (amount = 1) y encuadre base de cada movimiento. amount nunca es px: es fracción de esto,
// y si los bordes no dan se limita (con aviso).
export const MOVE_SPECS = {
  pushIn: { zoom: 1, desc: 'amount 1 = el doble de cerca (zoom ×2) hacia el objetivo' },
  pullOut: { zoom: 1, desc: 'arranca a zoom 1 + amount sobre el objetivo y abre hasta la viñeta' },
  truck: { zoom: 1.2, desc: 'paneo lateral con parallax; amount 1 = medio ancho de vista de recorrido' },
  pedestal: { zoom: 1.2, desc: 'sube/baja la cámara; amount 1 = medio alto de vista' },
  dollyZoom: { zoom: 1.25, desc: 'la cámara se acerca (in) o se aleja (out) y el zoom compensa: el objetivo queda del mismo tamaño y cambia la perspectiva; amount 1 = distancia ×0.4 (in) / ×2.5 (out)' },
  arc: { zoom: 1.15, desc: 'órbita horizontal alrededor del objetivo; amount 1 = 12°' },
  crane: { zoom: 1.15, desc: 'órbita vertical (grúa) alrededor del objetivo; amount 1 = 10°' },
  reveal: { zoom: 1, desc: 'arranca cerca (zoom 1 + 0.8·amount) contra un borde y abre hasta el objetivo' },
  rackFocus: { zoom: 1, desc: 'cambio de foco del DOF de `from` a `to`; amount no mueve la cámara' },
  handheld: { zoom: 1.06, desc: 'cámara en mano: ruido suave; amount 1 = ±2 % del ancho y ±0.4°' },
  breathe: { zoom: 1.04, desc: 'respiración: zoom lento ±3 %·amount y deriva mínima' },
};
const DIRS = ['auto', 'left', 'right', 'up', 'down', 'in', 'out'];

const defaultsOfDef = (def) => {
  const o = {};
  for (const prm of def?.params || []) if (prm.default !== undefined) o[prm.key] = structuredClone(prm.default);
  return o;
};

// ruido de valor suave (determinístico) en [-1, 1]
function smoothNoise(hashRand, ch, t, freq) {
  const x = t * freq;
  const i = Math.floor(x);
  const f = x - i;
  const a = hashRand(ch * 100003 + i) * 2 - 1;
  const b = hashRand(ch * 100003 + i + 1) * 2 - 1;
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}
const noise2 = (hr, ch, t, f) => 0.7 * smoothNoise(hr, ch, t, f) + 0.3 * smoothNoise(hr, ch + 50, t, f * 2.3);

const NUM = ['cx', 'cy', 'w', 'dist', 'yaw', 'pitch', 'dx', 'dy', 'drot', 'dzoom'];
const lerpState = (a, b, e) => {
  const o = { ...b };
  for (const k of NUM) o[k] = mix(a[k] ?? 0, b[k] ?? 0, e);
  return o;
};
const baseState = (v) => ({ cx: v.cx, cy: v.cy, w: v.w, dist: 1, yaw: 0, pitch: 0, dx: 0, dy: 0, drot: 0, dzoom: 1, dof: null });

// Escena vista desde la cámara: viñetas como modelos de bounds.js.
function sceneEnv(ctx) {
  const W = ctx.frame.w;
  const H = ctx.frame.h;
  const panels = (ctx.panels || []).map((pc) => panelModel({ id: pc.id, params: pc.params || {}, asset: ctx.asset(pc.params?.asset), start: pc.start || 0, duration: pc.duration || 0, stage: ctx.stage, W, H }));
  return { W, H, stage: ctx.stage, panels, fullBleed: isFullBleed({ W, H, stage: ctx.stage, panels }) };
}

// encuadre de una viñeta (sin márgenes): el mismo que la cámara en reposo del rig de capas
function framing(env, m) {
  const r = m ? m.rect : [0, 0, env.stage.w, env.stage.h];
  return { cx: r[0] + r[2] / 2, cy: r[1] + r[3] / 2, w: Math.max(r[2], r[3] * (env.W / env.H)) };
}

// px del lienzo del plano focal de una viñeta → px de página (caja con tilt)
const pageOf = (m, [x, y]) => ap(boxToPage(m), m.layout0.left + m.layout0.k * x, m.layout0.top + m.layout0.k * y);

// Objetivo → { m (viñeta), X (px del lienzo, plano focal), Z (unidades de D0), page (centro en página), size [w,h] página, layer }
export function resolveTarget(env, ref, warn) {
  const panels = env.panels;
  const first = panels[0] || null;
  const panelTarget = (m) => ({ m, Z: 0, page: m ? [m.rect[0] + m.rect[2] / 2, m.rect[1] + m.rect[3] / 2] : [env.stage.w / 2, env.stage.h / 2], size: m ? [m.rect[2], m.rect[3]] : [env.stage.w, env.stage.h], layer: null });
  if (ref == null || ref === '' || ref === 'panel') return panelTarget(first);
  if (Array.isArray(ref) || (typeof ref === 'string' && ref.startsWith('region:'))) {
    let r = ref;
    if (typeof ref === 'string') {
      try {
        r = JSON.parse(ref.slice(7));
      } catch {
        r = null;
      }
    }
    if (!Array.isArray(r) || r.length !== 4) {
      warn?.(`target ${JSON.stringify(ref)}: region tiene que ser [x,y,w,h] en px de página`);
      return panelTarget(first);
    }
    const m = panels.find((p) => r[0] + r[2] / 2 >= p.rect[0] && r[0] + r[2] / 2 <= p.rect[0] + p.rect[2] && r[1] + r[3] / 2 >= p.rect[1] && r[1] + r[3] / 2 <= p.rect[1] + p.rect[3]) || first;
    return { m, Z: 0, page: [r[0] + r[2] / 2, r[1] + r[3] / 2], size: [r[2], r[3]], layer: null };
  }
  if (typeof ref !== 'string') return panelTarget(first);
  if (ref.startsWith('panel:')) {
    const m = panels.find((p) => p.id === ref.slice(6));
    if (!m) warn?.(`target ${ref}: la viñeta no existe (se usa la primera)`);
    return panelTarget(m || first);
  }
  if (ref === 'focus') {
    const m = first;
    if (!m?.layout0) return panelTarget(m);
    const a = m.asset;
    const f = m.p.focus || a.focus || [0.5, 0.5];
    const [cx, cy, cw, ch] = m.p.crop || [0, 0, a.w, a.h];
    const pt = [cx + f[0] * cw, cy + f[1] * ch];
    return { m, Z: 0, X: pt, page: pageOf(m, pt), size: [m.rect[2] / 2, m.rect[3] / 2], layer: null };
  }
  for (const m of panels) {
    if (!m.layers) continue;
    const id = resolveLayerRef(m.layers, ref);
    if (!id) continue;
    const L = m.layers.find((l) => l.id === id);
    const g = 1 + L.Z;
    const c0 = m.rest.c0;
    const pc = [L.x + L.w / 2, L.y + L.h / 2];
    // punto del mundo sobre el eje óptico: centrar la vista ahí pone el centro de la capa en el centro del cuadro
    const X = [c0[0] + (pc[0] - c0[0]) * g, c0[1] + (pc[1] - c0[1]) * g];
    return { m, Z: L.Z, X, page: pageOf(m, X), size: [L.w * m.layout0.k, L.h * m.layout0.k], layer: L };
  }
  warn?.(`target ${ref}: no hay capa ni viñeta con esa referencia (se usa la viñeta)`);
  return panelTarget(first);
}

// centro de la vista (página) para que el objetivo quede centrado con la cámara orbitada (yaw/pitch en grados):
// C = X + tan(θ)·Zw (derivado de P = E + (X − E)·D/(D + Zw) con E = C + D·tan θ)
function pivotCenter(tg, yaw, pitch) {
  if (!tg.X || !tg.m?.rest) return tg.page;
  const Zw = tg.Z * tg.m.rest.D0;
  return pageOf(tg.m, [tg.X[0] + Math.tan((yaw * Math.PI) / 180) * Zw, tg.X[1] + Math.tan((pitch * Math.PI) / 180) * Zw]);
}

function layerDepth(env, ref, fallback) {
  if (ref == null) return fallback;
  if (typeof ref === 'number') return ref;
  for (const m of env.panels) {
    if (!m.layers) continue;
    const id = resolveLayerRef(m.layers, ref);
    if (id) return m.layers.find((l) => l.id === id).depth;
  }
  return fallback;
}

// Plan de un tramo: { path(e, lt) → estado } con amount ya escalado por k (y lam para centrar en el objetivo).
function planShot(env, shot, start, k, lam, ctxLike) {
  const move = shot.move;
  const spec = MOVE_SPECS[move];
  const tg = shot._tg;
  const B = framing(env, tg.m);
  const a = clamp(0, 1, shot.amount ?? 0.5) * k;
  const aspect = env.W / env.H;
  const zoom = shot.zoom ?? spec.zoom;
  const dir = shot.direction && shot.direction !== 'auto' ? shot.direction : null;
  const center = (c) => ({ cx: c[0], cy: c[1] });
  const towards = (from, to, l) => [mix(from[0], to[0], l), mix(from[1], to[1], l)];
  const T0 = tg.page;
  const tight = (z, c) => ({ ...baseState(B), ...center(c), w: B.w / z });
  const S0 = start || tight(zoom, towards([B.cx, B.cy], T0, lam));
  const hr = ctxLike.hashRand;
  switch (move) {
    case 'pushIn': {
      const from = start || baseState(B);
      const to = { ...from, ...center(towards([from.cx, from.cy], T0, lam)), w: from.w / (1 + a) };
      return { from, to, path: (e) => lerpState(from, to, e) };
    }
    case 'pullOut': {
      const to = start ? { ...start, ...center(towards([start.cx, start.cy], [B.cx, B.cy], 1)), w: Math.min(B.w, start.w * (1 + a)) } : baseState(B);
      const from = start || tight(1 + a, towards([B.cx, B.cy], T0, lam));
      return { from, to, path: (e) => lerpState(from, to, e) };
    }
    case 'truck':
    case 'pedestal': {
      const horiz = move === 'truck';
      const sg = horiz ? (dir === 'left' ? -1 : 1) : dir === 'up' ? -1 : 1;
      const base = start || tight(zoom, towards([B.cx, B.cy], T0, lam));
      const span = horiz ? 0.5 * base.w : (0.5 * base.w) / aspect;
      const travel = a * span * sg;
      const off = (d) => (horiz ? { cx: base.cx + d } : { cy: base.cy + d });
      const from = start ? base : { ...base, ...off(-travel / 2) };
      const to = start ? { ...base, ...off(travel) } : { ...base, ...off(travel / 2) };
      return { from, to, path: (e) => lerpState(from, to, e) };
    }
    case 'dollyZoom': {
      const base = start || tight(zoom, towards([B.cx, B.cy], T0, lam));
      const d0 = base.dist ?? 1;
      const d1 = dir === 'out' ? d0 * (1 + 1.5 * a) : d0 * (1 - 0.6 * a);
      // r = escala del plano focal relativa al reposo (∝ 1/w). El plano del objetivo mide en pantalla
      // ∝ r·dist/(dist + Zt·r) (proyección del rig); se mantiene constante despejando r para cada dist.
      const Zt = tg.Z || 0;
      const r0 = B.w / base.w;
      const K = (r0 * d0) / (d0 + Zt * r0);
      const zmin = tg.m?.layers ? Math.min(0, ...tg.m.layers.filter((l) => !l.hidden).map((l) => l.Z)) : 0;
      return {
        from: base,
        path: (e) => {
          const dist = mix(d0, d1, e);
          const den = dist - K * Zt;
          const r = den > 1e-6 ? (K * dist) / den : Infinity;
          const st = { ...base, dist, w: B.w / r };
          // el rig no deja que la cámara cruce las capas cercanas: si D choca con ese límite, no hay dolly zoom
          if (!(r < 1e6) || dist / r < -zmin + 0.15 - 1e-9) st._infeasible = true;
          return st;
        },
      };
    }
    case 'arc':
    case 'crane': {
      const horiz = move === 'arc';
      const sg = horiz ? (dir === 'left' ? -1 : 1) : dir === 'down' ? 1 : -1;
      const deg = (horiz ? 12 : 10) * a * sg;
      const base = start || tight(zoom, towards([B.cx, B.cy], T0, lam));
      const y0 = base.yaw || 0;
      const p0 = base.pitch || 0;
      return {
        from: base,
        path: (e) => {
          const yaw = horiz ? y0 + deg * e : y0;
          const pitch = horiz ? p0 : p0 + deg * e;
          const pv = towards([B.cx, B.cy], pivotCenter(tg, yaw, pitch), lam);
          const c = start ? towards([start.cx, start.cy], pv, e) : pv;
          return { ...base, cx: c[0], cy: c[1], yaw, pitch };
        },
      };
    }
    case 'reveal': {
      const to = start ? { ...start, ...center(towards([start.cx, start.cy], T0, lam)), w: Math.max(start.w, B.w) } : { ...baseState(B), ...center(towards([B.cx, B.cy], T0, lam)) };
      let from = start;
      if (!from) {
        const z = 1 + 0.8 * a;
        const w = B.w / z;
        const h = w / aspect;
        const bh = B.w / aspect;
        const sgx = dir === 'left' ? 1 : dir === 'right' ? -1 : 0;
        const sgy = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
        const edgeX = sgx || sgy ? sgx : -1; // por defecto revela hacia la derecha
        from = { ...baseState(B), cx: B.cx + edgeX * (B.w - w) / 2, cy: B.cy + sgy * (bh - h) / 2, w };
      }
      return { from, to, path: (e) => lerpState(from, to, e) };
    }
    case 'rackFocus': {
      const base = start || tight(zoom, towards([B.cx, B.cy], T0, lam));
      const bgDepth = tg.m?.layers?.filter((l) => l.role === 'background' && !l.hidden && !l.global).map((l) => l.depth) || [];
      const chDepth = tg.m?.layers?.filter((l) => l.role === 'character' && !l.hidden).map((l) => l.depth) || [];
      const f0 = layerDepth(env, shot.from, bgDepth.length ? Math.min(...bgDepth) : 0.4);
      const f1 = layerDepth(env, shot.to ?? (tg.layer ? tg.layer.id : null), tg.layer ? tg.layer.depth : chDepth.length ? Math.max(...chDepth) : 1);
      const amount = clamp(0, 1, shot.dof ?? 0.6);
      return { from: base, path: (e) => ({ ...base, dof: { amount, focus: mix(f0, f1, e) } }) };
    }
    case 'handheld':
    case 'breathe': {
      const base = start || tight(zoom, towards([B.cx, B.cy], T0, lam));
      const hand = move === 'handheld';
      const A = (hand ? 0.02 : 0.006) * env.W * a;
      const rot = hand ? 0.4 * a : 0;
      const f = hand ? 0.55 : 0.15;
      const ch = shot._i * 10;
      return {
        from: base,
        noisy: true,
        path: (e, lt) => ({
          ...base,
          dx: (base.dx || 0) + A * noise2(hr, ch + 1, lt, f),
          dy: (base.dy || 0) + A * noise2(hr, ch + 2, lt, f),
          drot: (base.drot || 0) + rot * noise2(hr, ch + 3, lt, f * 0.8),
          dzoom: (base.dzoom || 1) * (hand ? 1 : 1 + 0.03 * a * 0.5 * (1 - Math.cos((2 * Math.PI * lt) / 4))),
        }),
      };
    }
  }
  return { from: S0, path: () => S0 };
}

// encuadre agrandado o veces (w / o) en todo el tramo
function overscan(plan, o) {
  if (!(o > 1)) return plan;
  return { ...plan, from: plan.from && { ...plan.from, w: plan.from.w / o }, path: (e, lt) => {
    const st = plan.path(e, lt);
    return { ...st, w: st.w / o };
  } };
}

// estado → resultado de cámara (misma interfaz que las cámaras 2D + canales 3D)
function stateToResult(st) {
  const res = { view: { cx: st.cx, cy: st.cy, w: st.w, rotate: 0 }, dx: st.dx || 0, dy: st.dy || 0, drot: st.drot || 0, dzoom: st.dzoom || 1 };
  if ((st.dist ?? 1) !== 1) res.dist = st.dist;
  if (st.yaw || st.pitch) res.orbit = [st.yaw || 0, st.pitch || 0];
  if (st.dof) res.dof = st.dof;
  return res;
}

// Arma los tramos con sus límites. Devuelve { shots, warnings, limits }.
export function planMove3d(ctx) {
  const env = sceneEnv(ctx);
  const warnings = [];
  const warn = (m) => {
    warnings.push(m);
    ctx.warn?.(m);
  };
  const p = ctx.params;
  const dur = ctx.duration || 0;
  const raw = Array.isArray(p.shots) && p.shots.length ? p.shots : [{ at: 0, dur, move: p.move, target: p.target, amount: p.amount, direction: p.direction, ease: p.ease, zoom: p.zoom, from: p.from, to: p.to, dof: p.dof }];
  const shots = raw
    .map((s, i) => ({
      ...s,
      _i: i,
      at: +s.at || 0,
      dur: Math.max(0, s.dur ?? (i + 1 < raw.length ? (+raw[i + 1].at || 0) - (+s.at || 0) : dur - (+s.at || 0))),
      move: MOVES.includes(s.move) ? s.move : (warn(`move desconocido "${s.move}" (${MOVES.join('|')}); se usa pushIn`), 'pushIn'),
      target: s.target !== undefined ? s.target : p.target,
      ease: s.ease || p.ease || 'easeInOut',
      zoom: s.zoom ?? (Array.isArray(p.shots) && p.shots.length ? undefined : p.zoom ?? undefined),
      direction: s.direction ?? (Array.isArray(p.shots) && p.shots.length ? undefined : p.direction),
      amount: s.amount ?? p.amount ?? 0.5,
    }))
    .sort((a, b) => a.at - b.at);
  const vstart = ctx.variant?.start || 0;
  // efectos de cámara de la escena (no sostienen vista: shake, dutch, dolly); los llena el player/check al construir
  const effects = (ctx.cameraEffects || []).filter((r) => r && r.variant && !holdsView(r.def));
  const limits = [];
  let prevEnd = null;
  for (const sh of shots) {
    sh._tg = resolveTarget(env, sh.target, warn);
    if (sh.zoom == null) delete sh.zoom;
    const ease = easing(sh.ease, sh.dur || 1);
    // tiempos de muestra (locales al tramo): uniformes, y a los fps del proyecto donde hay efectos de cámara
    // (shake, dutch, dolly de otros clips) que se suman encima: el límite los incluye
    // muestras { lt (local al tramo), t (de la escena) }. El estado final del tramo tiene que aguantar también
    // los efectos que vienen DESPUÉS (el tramo siguiente arranca de ahí y move3d sostiene su vista al final).
    const lts = [];
    {
      // denso (≤ 30 fps) para que ningún instante entre muestras quede fuera del límite
      const t0 = vstart + sh.at;
      const n = Math.max(16, Math.ceil(sh.dur * Math.min(30, ctx.fps || 24)));
      for (let i = 0; i <= n; i++) lts.push({ lt: (sh.dur * i) / n, t: t0 + (sh.dur * i) / n });
      const step = 1 / Math.min(60, ctx.fps || 24);
      for (const fx of effects) {
        const a = Math.max(t0, fx.variant.start || 0);
        const b = (fx.variant.start || 0) + (fx.variant.duration || 0);
        for (let t = a; t < b; t += step) lts.push({ lt: Math.min(sh.dur, t - t0), t });
      }
    }
    const marginOf = (k, lam, o = over) => {
      const plan = overscan(planShot(env, sh, prevEnd, k, lam, ctx), o);
      let mg = Infinity;
      for (const { lt, t } of lts) {
        const st = plan.path(ease(sh.dur > 0 ? lt / sh.dur : 1), lt);
        if (st._infeasible) return -1e9;
        const camera = stateToResult(st);
        if (effects.length) {
          const fx = composeCamera(camera.view, cameraResultsAt(effects, t));
          camera.dx += fx.dx;
          camera.dy += fx.dy;
          camera.drot += fx.drot;
          camera.dzoom *= fx.dzoom;
        }
        const r = safeView({ W: env.W, H: env.H, stage: env.stage, panels: env.panels, camera, t, fullBleed: env.fullBleed });
        if (r.skipped) continue;
        mg = Math.min(mg, r.margin);
      }
      return mg;
    };
    const ok = (k, lam, o = over) => marginOf(k, lam, o) >= SAFE_PX;
    let over = 1;
    let k = 1;
    let lam = 1;
    const label = Array.isArray(p.shots) && p.shots.length ? `shot ${sh._i + 1} (${sh.move})` : sh.move;
    if (!ok(1, 1)) {
      const bisect = (f) => {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          if (f(mid)) lo = mid;
          else hi = mid;
        }
        return lo;
      };
      const decenter = (l) => {
        lam = l;
        if (sh._tg.layer || sh.target) warn(`${label}: encuadre corrido para no ver bordes (objetivo centrado al ${Math.round(lam * 100)} %)`);
      };
      const limit = (l) => {
        k = bisect((kk) => ok(kk, l));
        const applied = +((sh.amount ?? 0.5) * k).toFixed(2);
        limits.push({ shot: sh._i, move: sh.move, requested: sh.amount, applied });
        warn(`${label}: amount limitado a ${applied} (pedido ${sh.amount}) para no ver bordes`);
      };
      // pushIn/pullOut/reveal: el zoom es el pedido, así que primero se corre el encuadre (objetivo cerca de un
      // borde) y después se limita amount. El resto encuadra el objetivo: primero se limita amount.
      const centerFirst = ['pushIn', 'pullOut', 'reveal'].includes(sh.move);
      if (centerFirst && ok(1, 0)) decenter(bisect((l) => ok(1, l)));
      else if (!centerFirst && ok(0, 1)) limit(1);
      else if (ok(0, 0)) {
        decenter(bisect((l) => ok(0, l)));
        if (!ok(1, lam)) limit(lam);
      } else {
        // ni sin moverse entra (típico: un shake viejo encima del encuadre de reposo): se agranda el encuadre lo
        // mínimo (overscan, hasta ×1.5; no en dollyZoom, que tiene que conservar el tamaño del objetivo)
        lam = centerFirst ? 0 : 1;
        const before = marginOf(0, lam, 1);
        const can = sh.move !== 'dollyZoom' && ok(0, lam, 1.5);
        if (can) {
          let lo = 1;
          let hi = 1.5;
          for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) / 2;
            if (ok(0, lam, mid)) hi = mid;
            else lo = mid;
          }
          over = hi;
          warn(`${label}: encuadre agrandado ×${over.toFixed(3)} para no ver bordes (el de partida mostraba ${fmtPx(before)}, p. ej. por un shake)`);
          if (!ok(1, lam)) limit(lam);
        } else warn(`${label}: el encuadre de partida ya muestra bordes (${fmtPx(before)}); amount sin limitar`);
      }
    }
    sh._plan = overscan(planShot(env, sh, prevEnd, k, lam, ctx), over);
    sh._ease = ease;
    sh._k = k;
    prevEnd = sh._plan.path(1, sh.dur);
    delete prevEnd._infeasible;
  }
  const initial = shots.length ? shots[0]._plan.from || shots[0]._plan.path(0, 0) : null;
  return { env, shots, warnings, limits, initial };
}

// estado del plan en el tiempo local del clip
export function move3dState(plan, t) {
  const { shots, initial } = plan;
  if (!shots.length) return null;
  let st = initial;
  for (const sh of shots) {
    if (t < sh.at) break;
    const lt = Math.min(t - sh.at, sh.dur);
    st = sh._plan.path(sh._ease(progress(lt, 0, sh.dur)), lt);
  }
  return st;
}

export const move3d = {
  id: 'move3d',
  kind: 'camera',
  label: 'Cámara 3D (movimientos clásicos con límites)',
  holds: true,
  // el rig de capas prepara el desenfoque si la cámara lo va a empujar
  usesDof: (params) => params?.move === 'rackFocus' || (Array.isArray(params?.shots) && params.shots.some((s) => s?.move === 'rackFocus')),
  params: [
    { key: 'move', label: 'Movimiento', type: 'select', options: MOVES, default: 'pushIn' },
    { key: 'target', label: 'Objetivo (@tag, layer:id, panel:id, region:[x,y,w,h], focus; vacío = la viñeta)', type: 'text', default: null },
    { key: 'amount', label: 'Cantidad 0..1 (del recorrido nominal; se limita para no ver bordes)', type: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: 'direction', label: 'Dirección', type: 'select', options: DIRS, default: 'auto' },
    { key: 'ease', label: 'Ease', type: 'ease', default: 'easeInOut' },
    { key: 'zoom', label: 'Encuadre base (zoom ≥ 1; vacío = el del movimiento)', type: 'number', min: 1, max: 3, step: 0.01, default: null },
    { key: 'from', label: 'rackFocus: capa de foco inicial (@tag, layer:id o depth)', type: 'text', default: null },
    { key: 'to', label: 'rackFocus: capa de foco final (vacío = el objetivo)', type: 'text', default: null },
    { key: 'dof', label: 'rackFocus: intensidad del desenfoque', type: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
    { key: 'shots', label: 'Encadenado [{at, dur, move, target, amount, direction, ease, zoom}]', type: 'json', default: null },
  ],
  build(ctx) {
    // el plan se arma en el primer uso: así ya están construidos los demás clips de cámara (ctx.cameraEffects)
    let plan = null;
    const get = () => (plan = plan || planMove3d(ctx));
    return {
      get warnings() {
        return get().warnings;
      },
      get limits() {
        return get().limits;
      },
      update(t) {
        const st = move3dState(get(), t);
        return st ? stateToResult(st) : {};
      },
    };
  },
};

// ---------- evaluación pura de la cámara de una escena (sin DOM) ----------
// Mismo ctx que arma el player para los clips de cámara (params, seed, hashRand, panelRect, panels, asset, warn).
export function sceneCamera(scene, entry, presets, { warn } = {}) {
  const v = entry.variant;
  const W = scene.meta.width;
  const H = scene.meta.height;
  const stage = { w: v.stage?.w || W, h: v.stage?.h || H };
  const clips = activeClips(v);
  const panelRects = {};
  const panels = [];
  for (const { clip, variant } of clips) {
    if (clip.track !== 'panel') continue;
    panelRects[clip.id] = variant.params?.rect || [0, 0, stage.w, stage.h];
    // meta.panelDefaults va debajo de los params de la variante (como en el player)
    const pd = scene.meta?.panelDefaults && typeof scene.meta.panelDefaults === 'object' && !Array.isArray(scene.meta.panelDefaults) ? scene.meta.panelDefaults : {};
    panels.push({ id: clip.id, start: variant.start || 0, duration: variant.duration || 0, params: { ...defaultsOfDef(presets.panel), ...structuredClone(pd), ...(variant.params || {}) } });
  }
  const cams = [];
  const skipped = [];
  const cameraEffects = [];
  for (const { clip, variant } of clips) {
    if (clip.track !== 'camera') continue;
    const def = presets[variant.preset];
    if (!def || !def.build) {
      skipped.push(clip.id);
      continue;
    }
    const seed = hashString(entry.scene.id + '/' + clip.id + '/' + variant.id);
    const ctx = {
      params: { ...defaultsOfDef(def), ...(variant.params || {}) },
      duration: variant.duration,
      clip,
      variant,
      stage,
      frame: { w: W, h: H },
      fps: scene.meta.fps || 24,
      presets,
      seed,
      rand: mulberry32(seed),
      hashRand: (n) => mulberry32(seed ^ Math.imul(n + 1, 2654435761))(),
      easing,
      mix,
      uid: (s) => s,
      asset: (id) => (id ? scene.assets?.[id] : null),
      panelRect: (id) => panelRects[id],
      panels,
      cameraEffects,
      warn: (m) => warn?.(`${clip.id}: ${m}`),
    };
    try {
      cams.push({ clip, variant, def, rt: def.build(ctx) || {} });
    } catch (e) {
      warn?.(`${clip.id}: ${e.message}`);
    }
  }
  for (const r of cams) if (!holdsView(r.def)) cameraEffects.push(r);
  const base = defaultView(stage, W, H);
  return {
    W,
    H,
    stage,
    panels,
    cams,
    skipped,
    at: (local) => composeCamera(base, cameraResultsAt(cams, local)),
  };
}

// ---------- comic check --gaps ----------
// Muestrea cada escena a `fps` (4) y junta los problemas en tramos. Devuelve { issues: [{ scene, t0, t1, kind, id, px, msg }], warnings }.
export function checkGaps(scene, presets, { fps = 4 } = {}) {
  const issues = [];
  const warnings = [];
  for (const entry of layoutScenes(scene)) {
    const sid = entry.scene.id;
    const sc = sceneCamera(scene, entry, presets, { warn: (m) => warnings.push(`${sid}/${m}`) });
    for (const id of sc.skipped) warnings.push(`${sid}/${id}: cámara custom, no se evalúa sin navegador`);
    const models = sc.panels.map((pc) => panelModel({ id: pc.id, params: pc.params, asset: scene.assets?.[pc.params.asset] || null, start: pc.start, duration: pc.duration, stage: sc.stage, W: sc.W, H: sc.H }));
    const fullBleed = isFullBleed({ W: sc.W, H: sc.H, stage: sc.stage, panels: models });
    const open = new Map(); // clave → tramo abierto
    // textos/globos cortados: solo si dura ≥ 0.5 s (un paneo que los cruza no es un error)
    const minText = Math.max(1, Math.ceil(0.5 * fps - 1e-9));
    const flush = (keep) => {
      for (const [key, it] of open) if (!keep.has(key)) {
        if (it.kind !== 'text' || it.n >= minText) issues.push(it);
        open.delete(key);
      }
    };
    const n = Math.max(1, Math.ceil(entry.duration * fps - 1e-6));
    const bubbles = activeClips(entry.variant).filter(({ clip, variant }) => clip.track === 'bubble' && variant.params?.box);
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      const cam = sc.at(t);
      const r = safeView({ W: sc.W, H: sc.H, stage: sc.stage, panels: models, camera: cam, t, fullBleed, texts: true });
      const found = [...r.issues];
      // globos DOM (px de página): cortados por el cuadro mientras se ven
      const A = cameraAffine(cam, sc.W, sc.H);
      for (const { clip, variant } of bubbles) {
        const lt = t - (variant.start || 0);
        const din = variant.params.enter?.duration ?? 0.35;
        const dout = variant.params.exit?.duration ?? 0.2;
        if (lt < din || lt > variant.duration - dout) continue;
        const [bx, by, bw, bh] = variant.params.box;
        const cs = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]].map(([x, y]) => ap(A, x, y));
        let worst = null;
        for (const [x, y] of cs) for (const [d, side] of [[x, 'left'], [sc.W - x, 'right'], [y, 'top'], [sc.H - y, 'bottom']]) if (d < -2 && (!worst || d < worst.px)) worst = { px: d, side };
        if (worst) found.push({ kind: 'text', id: clip.id, side: worst.side, px: worst.px, msg: `el globo ${clip.id} queda cortado por el borde ${SIDE_ES[worst.side]} (${fmtPx(worst.px)})` });
      }
      const keep = new Set();
      for (const f of found) {
        const key = `${f.kind}|${f.panel || ''}|${f.id}|${f.side}`;
        keep.add(key);
        const it = open.get(key);
        if (it) {
          it.t1 = t;
          if (f.px < it.px) Object.assign(it, { px: f.px, msg: f.msg, tWorst: t });
          it.n++;
        } else open.set(key, { scene: sid, t0: t, t1: t, tWorst: t, n: 1, kind: f.kind, id: f.id, side: f.side, px: f.px, msg: f.msg });
      }
      flush(keep);
    }
    flush(new Set());
    // VFX con region fuera de su viñeta
    const vclips = activeClips(entry.variant);
    const firstPanel = vclips.find(({ clip }) => clip.track === 'panel')?.clip.id;
    for (const { clip, variant } of vclips) {
      if (clip.track !== 'vfx' || !variant.params?.region) continue;
      const tgt = variant.params.target || firstPanel;
      const m = models.find((x) => x.id === tgt);
      if (!m) continue;
      const o = regionOutside(variant.params.region, m.rect);
      if (o) issues.push({ scene: sid, t0: variant.start || 0, t1: variant.start || 0, tWorst: variant.start || 0, kind: 'vfx', id: clip.id, side: o.side, px: o.px, static: true, msg: `la region del VFX ${clip.id} sale de la viñeta ${tgt} por el borde ${SIDE_ES[o.side]} (${fmtPx(o.px)})` });
    }
  }
  return { issues, warnings };
}

export function formatGap(it) {
  if (it.static) return `${it.scene}: ${it.msg}`;
  const when = it.t0 === it.t1 ? `t=${it.t0.toFixed(2)}s` : `t=${it.t0.toFixed(2)}–${it.t1.toFixed(2)}s (peor en ${it.tWorst.toFixed(2)}s)`;
  return `${it.scene} ${when}: ${it.msg}`;
}
