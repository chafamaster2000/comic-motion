#!/usr/bin/env node
// Tests numéricos (sin navegador) de bounds.js y del preset move3d (camera3d.js).
//   node test/camera3d.mjs
// Escena sintética genérica: viñeta a sangre 1920×1080 con un asset por capas (fondo que llena la viñeta en
// reposo, un personaje con tag @hero y un texto).
import { safeView, panelModel, cameraAffine, defaultView, panelLayoutAt, boxToPage, mul, ap, eyeFor, planeToFocal, isFullBleed, regionOutside, coverage } from '../src/player/bounds.js';
import { planMove3d, move3dState, move3d, composeCamera, cameraResultsAt, MOVES } from '../src/player/camera3d.js';
import { BUILTIN, defaultsOf } from '../src/player/presets.js';
import { mulberry32, hashString } from '../src/shared/scene.js';

let fails = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) passes++;
  else {
    fails++;
    console.log('✗ ' + msg);
  }
};
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

const W = 1920;
const H = 1080;
const stage = { w: W, h: H };
const layersAsset = (withSky = false) => ({
  type: 'layers',
  w: 2000,
  h: 1200,
  file: 'x.png',
  layers: [
    ...(withSky ? [{ id: 'sky', file: 's.png', x: -1000, y: -600, w: 4000, h: 2400, z: 0, role: 'background', depth: 0, global: true }] : []),
    { id: 'bg', file: 'b.png', x: 40, y: 60, w: 1920, h: 1080, z: 1, role: 'background', depth: 0.4 },
    { id: 'hero', file: 'h.png', x: 900, y: 350, w: 400, h: 600, z: 2, role: 'character', depth: 0.875, tags: ['hero'] },
    { id: 'caption', file: 'c.png', x: 100, y: 100, w: 400, h: 120, z: 3, role: 'text', depth: 1 },
  ],
});
const panelParams = { ...defaultsOf(BUILTIN.find((d) => d.id === 'panel')), asset: 'a', border: 0, shadow: false, crop: [40, 60, 1920, 1080], autoTiming: false };

function world(asset = layersAsset()) {
  const m = panelModel({ id: 'p1', params: panelParams, asset, start: 0, duration: 4, stage, W, H });
  return { m, panels: [m], fullBleed: isFullBleed({ W, H, stage, panels: [m] }) };
}
const sv = (w, camera, t = 1, texts = false) => safeView({ W, H, stage, panels: w.panels, camera: { dx: 0, dy: 0, drot: 0, dzoom: 1, ...camera }, t, fullBleed: w.fullBleed, texts });

// ---------- bounds ----------
{
  const w = world();
  ok(w.fullBleed, 'la viñeta a sangre cubre el cuadro en reposo');
  const rest = sv(w, { view: defaultView(stage, W, H) });
  ok(rest.ok && rest.margin > -0.5 && rest.margin < 1, `reposo: cubierto con margen ~0 (${rest.margin})`);
  // afuera de la página: w 2000 → (2000−1920)/2 px de página × 1920/2000
  const out = sv(w, { view: { cx: 960, cy: 540, w: 2000 } });
  near(out.margin, -38.4, 0.5, 'zoom out: margen negativo = hueco en px del cuadro');
  ok(out.issues.some((i) => i.kind === 'page'), 'zoom out: avisa que se ve fuera de la viñeta');
  // paneo con zoom 1.2 contra un fondo MÁS CHICO que la viñeta: el límite es el del plano del fondo (parallax)
  const small = layersAsset();
  small.layers[0] = { ...small.layers[0], w: 1900 }; // borde derecho en x = 1940 del lienzo
  const ws = world(small);
  // C_max = c0 + (1940 − c0)·g − (w/2)(1 + Z·z) con c0 = 1000, g = 1.36, Z = 0.36, z = 1.2, w = 1600 → cx = C − 40
  const Cmax = 1000 + (1940 - 1000) * 1.36 - 800 * (1 + 0.36 * 1.2);
  const cxMax = Cmax - 40;
  const atMax = sv(ws, { view: { cx: cxMax, cy: 540, w: 1600 } });
  near(atMax.margin, 0, 0.6, `paneo al límite analítico cx=${cxMax.toFixed(1)}`);
  const past = sv(ws, { view: { cx: cxMax + 20, cy: 540, w: 1600 } });
  ok(!past.ok && past.issues.some((i) => i.kind === 'edge' && i.id === 'bg' && i.side === 'right'), 'paneo pasado: se ve el borde derecho del fondo');
  // el hueco del fondo en px del cuadro: 20 px de página → Δp = 20/g en la capa → ×(W/w)·g·q
  const expGap = -(20 / 1.36) * (W / 1600) * 1.36 / (1 + 0.36 * 1.2);
  near(past.margin, expGap, 0.6, 'paneo pasado: tamaño del hueco');
  ok(sv(ws, { view: { cx: cxMax - 20, cy: 540, w: 1600 } }).ok, 'paneo antes del límite: cubierto');
  // con un fondo global enorme detrás, el mismo paneo queda cubierto (unión de fondos)
  const wsky = world(layersAsset(true));
  ok(sv(wsky, { view: { cx: 1110, cy: 540, w: 1600 } }).ok, 'unión de fondos: el global cubre');
  // texto cortado
  const cut = sv(w, { view: { cx: 700, cy: 250, w: 1000 } }, 1, true);
  ok(cut.issues.some((i) => i.kind === 'text' && i.id === 'caption'), 'texto cortado por el borde del cuadro');
  // región de VFX
  ok(regionOutside([[0, 0], [1900, 0], [1900, 1000]], [0, 0, 1920, 1080]) === null, 'region dentro de la viñeta');
  near(regionOutside([100, 100, 2000, 200], [0, 0, 1920, 1080]).px, -180, 1e-9, 'region que sale por la derecha');
  // cobertura genérica: rect unitario
  const c = coverage([[0, 0], [10, 0], [10, 10], [0, 10]], [{ id: 'r', rect: [-5, -5, 20, 20], toLocal: [1, 0, 0, 1, 0, 0], k: 1 }]);
  near(c.margin, 5, 1e-9, 'coverage: margen de un rect');
}

// ---------- move3d ----------
function ctxFor(params, { asset = layersAsset(), duration = 4 } = {}) {
  const def = move3d;
  const warnings = [];
  const seed = hashString('s/c/v');
  return {
    ctx: {
      params: { ...defaultsOf(def), ...params },
      duration,
      variant: { start: 0 },
      stage,
      frame: { w: W, h: H },
      panels: [{ id: 'p1', start: 0, duration, params: panelParams }],
      asset: () => asset,
      hashRand: (n) => mulberry32(seed ^ Math.imul(n + 1, 2654435761))(),
      warn: (m) => warnings.push(m),
    },
    warnings,
  };
}
// proyección de un punto de una capa al cuadro con la cámara (misma cadena que el rig)
function project(m, res, layerId, pt, t = 0) {
  const cam = cameraAffine({ dx: 0, dy: 0, drot: 0, dzoom: 1, ...res }, W, H);
  const L = panelLayoutAt(m, t);
  const A = mul(mul(cam, boxToPage(m)), [L.k, 0, 0, L.k, L.left, L.top]);
  const l = m.layers.find((x) => x.id === layerId);
  const zmin = Math.min(0, ...m.layers.filter((x) => !x.hidden).map((x) => x.Z));
  const eye = eyeFor({ W, H, cam, layout: L, origin: m.origin, rest: m.rest, zmin, orbit: res.orbit || [0, 0], dist: res.dist ?? 1 });
  const P = ap(planeToFocal(eye, m.rest, l.Z), pt[0], pt[1]);
  return ap(A, P[0], P[1]);
}
// punto de mira de un personaje: centro en x, 40 % del alto en y
const heroC = [1100, 350 + 0.4 * 600];
const run = (params, opts) => {
  const { ctx, warnings } = ctxFor(params, opts);
  const plan = planMove3d(ctx);
  const at = (t) => {
    const st = move3dState(plan, t);
    const res = move3d.build(ctx).update(t);
    return { st, res };
  };
  return { plan, at, warnings, m: plan.env.panels[0] };
};
const allSafe = (r, dur = 4, n = 48) => {
  let worst = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = (dur * i) / n;
    const { res } = r.at(t);
    const s = safeView({ W, H, stage, panels: r.plan.env.panels, camera: { ...res }, t, fullBleed: r.plan.env.fullBleed });
    worst = Math.min(worst, s.margin);
  }
  return worst;
};

{
  const wsky = layersAsset(true);
  // pushIn: al final el centro del personaje queda en el centro del cuadro
  const r = run({ keepText: false, move: 'pushIn', target: '@hero', amount: 0.5 }, { asset: wsky });
  const end = r.at(4).res;
  const p = project(r.m, end, 'hero', heroC, 4);
  near(p[0], W / 2, 1, 'pushIn: objetivo centrado (x)');
  near(p[1], H / 2, 1, 'pushIn: objetivo centrado (y)');
  near(end.view.w, 1920 / Math.SQRT2, 1e-6, 'pushIn amount 0.5 (objetivo grande: zEnd ×2 → ×1.41)');
  ok(allSafe(r) >= -0.5, 'pushIn: nunca muestra bordes');
  // pullOut: arranca centrado en el objetivo y termina en el encuadre de la viñeta
  const po = run({ keepText: false, move: 'pullOut', target: '@hero', amount: 0.5 }, { asset: wsky });
  const p0 = project(po.m, po.at(0).res, 'hero', heroC, 0);
  near(p0[0], W / 2, 1, 'pullOut: objetivo centrado al inicio');
  near(po.at(4).res.view.w, 1920, 1e-6, 'pullOut: termina en la viñeta');
  ok(allSafe(po) >= -0.5, 'pullOut: nunca muestra bordes');
}
{
  // truck / pedestal: el objetivo pasa por el centro a mitad del recorrido, y se mueve para el lado pedido
  const wsky = layersAsset(true);
  for (const [move, dir, axis] of [['truck', 'right', 0], ['truck', 'left', 0], ['pedestal', 'down', 1], ['pedestal', 'up', 1]]) {
    const r = run({ keepText: false, move, target: '@hero', amount: 0.3, direction: dir, ease: 'linear' }, { asset: wsky });
    const mid = project(r.m, r.at(2).res, 'hero', heroC, 2);
    near(mid[axis], axis ? H / 2 : W / 2, 1, `${move} ${dir}: objetivo centrado a mitad`);
    const k = axis ? 'cy' : 'cx';
    const d = r.at(4).res.view[k] - r.at(0).res.view[k];
    ok(dir === 'right' || dir === 'down' ? d > 0 : d < 0, `${move} ${dir}: se mueve hacia ${dir} (${d.toFixed(1)})`);
    ok(allSafe(r) >= -0.5, `${move} ${dir}: nunca muestra bordes`);
  }
  // forzado: amount 1 no entra → se limita y AVISA
  const f = run({ keepText: false, move: 'truck', target: '@hero', amount: 1, direction: 'right' }, { asset: wsky });
  ok(f.warnings.some((w) => /amount limitado a/.test(w)), `truck amount 1: aviso de límite (${f.warnings.join(' | ')})`);
  ok(f.plan.limits.length === 1 && f.plan.limits[0].applied < 1, 'truck amount 1: limits expone lo aplicado');
  ok(allSafe(f) >= -0.5, 'truck limitado: nunca muestra bordes');
}
{
  // dollyZoom: el plano del objetivo conserva su tamaño en pantalla (±1 %) y el fondo cambia
  for (const dir of ['in', 'out']) {
    const r = run({ keepText: false, move: 'dollyZoom', target: '@hero', amount: 0.6, direction: dir }, { asset: layersAsset(true) });
    const size = (t, layer, a, b) => {
      const res = r.at(t).res;
      const pa = project(r.m, res, layer, a, t);
      const pb = project(r.m, res, layer, b, t);
      return Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    };
    const h0 = size(0, 'hero', [900, 350], [1300, 950]);
    const h1 = size(4, 'hero', [900, 350], [1300, 950]);
    near(h1 / h0, 1, 0.01, `dollyZoom ${dir}: el objetivo conserva el tamaño`);
    const b0 = size(0, 'bg', [40, 60], [1960, 1140]);
    const b1 = size(4, 'bg', [40, 60], [1960, 1140]);
    ok(dir === 'in' ? b1 / b0 < 0.97 : b1 / b0 > 1.03, `dollyZoom ${dir}: el fondo ${dir === 'in' ? 'se aleja' : 'se acerca'} (${(b1 / b0).toFixed(3)})`);
    const c = project(r.m, r.at(4).res, 'hero', heroC, 4);
    near(c[0], W / 2, 1, `dollyZoom ${dir}: objetivo centrado`);
    ok(r.at(4).res.dist !== undefined && (dir === 'in' ? r.at(4).res.dist < 1 : r.at(4).res.dist > 1), `dollyZoom ${dir}: canal dist`);
    ok(allSafe(r) >= -0.5, `dollyZoom ${dir}: nunca muestra bordes`);
  }
}
{
  // arc / crane: órbita alrededor del objetivo, que queda centrado todo el tiempo
  for (const [move, dir] of [['arc', 'right'], ['arc', 'left'], ['crane', 'up'], ['crane', 'down']]) {
    const r = run({ keepText: false, move, target: '@hero', amount: 0.5, direction: dir }, { asset: layersAsset(true) });
    for (const t of [0, 1.3, 4]) {
      const c = project(r.m, r.at(t).res, 'hero', heroC, t);
      near(Math.hypot(c[0] - W / 2, c[1] - H / 2), 0, 1, `${move} ${dir}: objetivo centrado en t=${t}`);
    }
    const o = r.at(4).res.orbit;
    const want = move === 'arc' ? 12 * 0.5 * (dir === 'left' ? -1 : 1) : 10 * 0.5 * (dir === 'down' ? 1 : -1);
    near(move === 'arc' ? o[0] : o[1], want, 1e-9, `${move} ${dir}: ángulo final`);
    ok(allSafe(r) >= -0.5, `${move} ${dir}: nunca muestra bordes`);
  }
}
{
  // reveal: arranca cerca contra un borde y termina en el objetivo (la viñeta)
  const r = run({ keepText: false, move: 'reveal', amount: 0.5, direction: 'right' }, { asset: layersAsset(true) });
  const a = r.at(0).res.view;
  const b = r.at(4).res.view;
  ok(a.w < b.w && a.cx < b.cx, 'reveal right: arranca cerca y a la izquierda');
  near(b.cx, 960, 1e-6, 'reveal: termina centrado en la viñeta');
  ok(allSafe(r) >= -0.5, 'reveal: nunca muestra bordes');
  // rackFocus: el foco va del fondo al personaje
  const rf = run({ keepText: false, move: 'rackFocus', from: 'layer:bg', to: '@hero', dof: 0.7 });
  near(rf.at(0).res.dof.focus, 0.4, 1e-9, 'rackFocus: foco inicial en el fondo');
  near(rf.at(4).res.dof.focus, 0.875, 1e-9, 'rackFocus: foco final en el personaje');
  near(rf.at(2).res.dof.amount, 0.7, 1e-9, 'rackFocus: intensidad');
  ok(move3d.usesDof({ move: 'rackFocus' }) && !move3d.usesDof({ move: 'truck' }), 'rackFocus: usesDof');
}
{
  // handheld / breathe: determinístico, acotado y seguro
  const r = run({ keepText: false, move: 'handheld', amount: 0.8 }, { asset: layersAsset(true) });
  const a = r.at(1.7).res;
  const b = r.at(1.7).res;
  ok(a.dx === b.dx && a.dy === b.dy && a.drot === b.drot, 'handheld: función pura de t');
  let maxd = 0;
  for (let t = 0; t <= 4; t += 0.05) maxd = Math.max(maxd, Math.abs(r.at(t).res.dx));
  ok(maxd > 3 && maxd <= 0.02 * W * 0.8 + 1e-9, `handheld: amplitud acotada (${maxd.toFixed(1)} px)`);
  ok(allSafe(r, 4, 96) >= -0.5, 'handheld: nunca muestra bordes');
  const br = run({ keepText: false, move: 'breathe', amount: 1 }, { asset: layersAsset(true) });
  let zmin = 9;
  let zmax = 0;
  for (let t = 0; t <= 4; t += 0.05) {
    const z = br.at(t).res.dzoom;
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  ok(zmin >= 1 - 1e-9 && zmax <= 1.08 + 1e-9 && zmax > 1.07, `breathe amount 1: zoom entre 1 y 1.08 (${zmin.toFixed(4)}..${zmax.toFixed(4)})`);
}
{
  // encadenado: el segundo tramo arranca donde terminó el primero
  const r = run({ keepText: false, shots: [{ at: 0, dur: 2, move: 'pushIn', target: '@hero', amount: 0.4 }, { at: 2, dur: 2, move: 'truck', direction: 'left', amount: 0.2 }] }, { asset: layersAsset(true) });
  const e1 = r.at(2 - 1e-9).res.view;
  const s2 = r.at(2).res.view;
  near(e1.cx, s2.cx, 1e-3, 'shots: continuidad en x');
  near(e1.w, s2.w, 1e-3, 'shots: continuidad en zoom');
  ok(r.at(4).res.view.cx < s2.cx, 'shots: el segundo tramo va a la izquierda');
  ok(allSafe(r) >= -0.5, 'shots: nunca muestra bordes');
  // todos los movimientos construyen sin error sobre una viñeta plana (sin capas) también
  for (const move of MOVES) {
    const flat = { type: 'image', w: 1920, h: 1080, file: 'x.png' };
    const rr = run({ keepText: false, move, amount: 0.5 }, { asset: flat });
    ok(!!rr.at(2).res.view, `${move}: funciona en viñeta plana`);
    ok(allSafe(rr) >= -0.5, `${move}: plana, nunca muestra bordes`);
  }
}

// ---------- qué es hueco (bounds: art / panel / page) ----------
{
  // página con marco negro: una capa global sólida negra debajo y el dibujo metido adentro
  const framed = (o = {}) => ({
    type: 'layers',
    w: 2000,
    h: 1200,
    file: 'x.png',
    layers: [
      ...(o.noSky ? [] : [{ id: 'paper', file: 'p.png', x: -1000, y: -600, w: 4000, h: 2400, z: 0, role: 'background', depth: 0, global: true, ...(o.noSolid ? {} : { solid: '#000000' }) }]),
      { id: 'art', file: 'a.png', x: 200, y: 200, w: 1600, h: 800, z: 1, role: 'background', depth: 0.4 },
      { id: 'hero', file: 'h.png', x: o.heroX ?? 900, y: 350, w: 400, h: 600, z: 2, role: 'character', depth: 0.875, tags: ['hero'] },
    ],
  });
  const view = { view: { cx: 1100, cy: 540, w: 1920 } }; // 140 px de página a la derecha de la viñeta
  const at = (asset, bounds, stageColor = '#000000') => {
    const w = world(asset);
    return safeView({ W, H, stage, panels: w.panels, camera: { dx: 0, dy: 0, drot: 0, dzoom: 1, ...view }, t: 1, fullBleed: w.fullBleed, bounds, stageColor });
  };
  const art = at(framed(), 'art');
  ok(art.ok && !art.issues.length, `art: mirar fuera de la viñeta sobre el marco negro de la página no es hueco (${art.issues.map((i) => i.msg).join(' | ')})`);
  const panel = at(framed(), 'panel');
  ok(!panel.ok && panel.issues.some((i) => i.kind === 'page'), 'panel: la misma vista sale del rect de la viñeta');
  near(panel.margin, -140, 0.6, 'panel: tamaño de lo que se ve afuera');
  ok(!at(framed(), 'page').ok, 'page: la misma vista sale de la página');
  const white = at(framed(), 'art', '#ffffff');
  ok(!white.ok && white.issues.some((i) => /fuera de la viñeta/.test(i.msg)), 'art: marco negro contra escenario blanco = borde recto de otro color → hueco');
  const cut = at(framed({ heroX: 1700 }), 'art');
  ok(!cut.ok && cut.issues.some((i) => /corta hero/.test(i.msg)), `art: un personaje cortado por el borde de la caja es hueco (${cut.issues.map((i) => i.msg).join(' | ')})`);
  const nodata = at(framed({ noSolid: true }), 'art');
  ok(!nodata.ok, 'art sin datos de color (sin solid): cae a panel en los lados ocultos');
  const empty = at(framed({ noSky: true }), 'art');
  ok(!empty.ok && empty.issues.some((i) => i.kind === 'edge' && i.id === 'art'), 'art: transparencia dentro de la caja (el fondo no cubre) sigue siendo hueco');
  // grilla del alfa: un fondo cuyo PNG llena la viñeta pero con la mitad derecha transparente es hueco
  const holed = layersAsset();
  holed.layers[0] = { ...holed.layers[0], grid: { cell: 960, cols: 2, rows: 2, bits: Buffer.from([0b0101]).toString('base64') } };
  const hw = world(holed);
  const hs = safeView({ W, H, stage, panels: hw.panels, camera: { dx: 0, dy: 0, drot: 0, dzoom: 1, view: defaultView(stage, W, H) }, t: 1, fullBleed: hw.fullBleed, bounds: 'art', stageColor: '#000' });
  ok(!hs.ok && hs.issues.some((i) => i.kind === 'edge' && i.id === 'bg'), 'grid: la parte transparente de un fondo (dentro de su bbox) es hueco');
  // imagen plana con canaleta negra de 60 px medida en los bordes (edges)
  const flatP = { ...panelParams, crop: null };
  const flatW = (edges) => {
    const m = panelModel({ id: 'p1', params: flatP, asset: { type: 'image', w: 1920, h: 1080, file: 'f.png', ...(edges ? { edges } : {}) }, start: 0, duration: 4, stage, W, H });
    return safeView({ W, H, stage, panels: [m], camera: { dx: 0, dy: 0, drot: 0, dzoom: 1, view: { cx: 1060, cy: 540, w: 1920 } }, t: 1, fullBleed: true, bounds: 'art', stageColor: '#000' });
  };
  ok(flatW({ color: '#000000', band: [60, 60, 60, 60] }).ok, 'art plana: la canaleta negra de la imagen (edges) es marco');
  near(flatW(null).margin, -100, 0.6, 'art plana sin edges: se ve fuera de la viñeta (cae a panel)');
  ok(!flatW({ color: '#ffffff', band: [60, 60, 60, 60] }).ok, 'art plana: canaleta blanca en escenario negro = hueco');
  // por tramos: el lado derecho tiene marco solo en la mitad de arriba (un personaje rompe el marco abajo)
  const segs = new Int16Array(4 * 8).fill(60);
  for (let i = 4; i < 8; i++) segs[2 * 8 + i] = 0;
  const half = flatW({ color: '#000000', band: [60, 60, 0, 60], n: 8, bands: Buffer.from(segs.buffer).toString('base64') });
  ok(!half.ok && half.issues.some((i) => i.side === 'right'), 'art plana por tramos: se corta donde el dibujo llega al borde');
  segs.fill(60);
  ok(flatW({ color: '#000000', band: [60, 60, 60, 60], n: 8, bands: Buffer.from(segs.buffer).toString('base64') }).ok, 'art plana por tramos: marco entero = sin hueco');
}

// ---------- keepText y escalas de amount ----------
const textCorners = (r, t) => {
  const { res } = r.at(t);
  const [x, y, w, h] = [100, 100, 400, 120];
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((pt) => project(r.m, res, 'caption', pt, t));
};
const textSlackMin = (r, from = 0, to = 4) => {
  let d = Infinity;
  for (let t = from; t <= to + 1e-9; t += 0.1) for (const [x, y] of textCorners(r, t)) d = Math.min(d, x, W - x, y, H - y);
  return d;
};
{
  const wsky = layersAsset(true);
  // sin keepText el pushIn fuerte al héroe corta el texto de arriba a la izquierda…
  const off = run({ keepText: false, move: 'pushIn', target: '@hero', amount: 1 }, { asset: wsky });
  ok(textSlackMin(off) < 0, `keepText false: el pushIn corta el texto (${textSlackMin(off).toFixed(1)} px)`);
  // …con keepText (default) el texto queda entero con 24 px, se reencuadra y se avisa
  const on = run({ move: 'pushIn', target: '@hero', amount: 1 }, { asset: wsky });
  ok(textSlackMin(on) >= 24 - 0.6, `keepText: el texto queda entero con ≥ 24 px (${textSlackMin(on).toFixed(1)} px)`);
  ok(on.warnings.some((w) => /keepText|texto|caption/.test(w)), `keepText: avisa el reencuadre (${on.warnings.join(' | ')})`);
  ok(allSafe(on) >= -0.5, 'keepText: sin huecos');
  // un texto que entra más tarde solo cuenta desde que aparece
  const late = { ...panelParams, layers: { caption: { at: 3 } } };
  const lr = (() => {
    const { ctx, warnings } = ctxFor({ move: 'pushIn', target: '@hero', amount: 1, ease: 'linear' }, { asset: wsky });
    ctx.panels[0].params = late;
    const plan = planMove3d(ctx);
    return { plan, warnings, m: plan.env.panels[0], at: (t) => ({ res: move3d.build(ctx).update(t) }) };
  })();
  ok(textSlackMin(lr, 3, 4) >= 24 - 0.6, `texto que entra en t=3: entero desde que aparece (${textSlackMin(lr, 3, 4).toFixed(1)} px)`);
  ok(textSlackMin(lr, 0, 1) < textSlackMin(on, 0, 1) - 1 || textSlackMin(lr, 0, 1) < 0, 'texto que entra en t=3: antes la cámara puede ir por el objetivo');
  // pushIn amount 1: un objetivo chico llena ~70–80 % del cuadro
  const small = layersAsset(true);
  small.layers.push({ id: 'face', file: 'f.png', x: 1300, y: 500, w: 240, h: 240, z: 5, role: 'fx', depth: 1, tags: ['face'] });
  const pf = run({ keepText: false, move: 'pushIn', target: '@face', amount: 1 }, { asset: small });
  const a0 = project(pf.m, pf.at(4).res, 'face', [1300, 500], 4);
  const a1 = project(pf.m, pf.at(4).res, 'face', [1300, 740], 4);
  const fill = (a1[1] - a0[1]) / H;
  ok(fill >= 0.7 && fill <= 0.82, `pushIn amount 1: el objetivo llena ${(fill * 100).toFixed(0)} % del alto`);
  const half = run({ keepText: false, move: 'pushIn', target: '@face', amount: 0.5 }, { asset: small });
  const z5 = 1920 / half.at(4).res.view.w;
  ok(z5 > 1.5, `pushIn amount 0.5: movimiento claramente visible (×${z5.toFixed(2)})`);
  // breathe 0.2: perceptible pero sutil (+1–2 %), y encadenado después de un pushIn pegado al límite no se limita
  const br = run({ keepText: false, move: 'breathe', amount: 0.2 }, { asset: wsky });
  let zmax = 0;
  for (let t = 0; t <= 4; t += 0.05) zmax = Math.max(zmax, br.at(t).res.dzoom);
  ok(zmax >= 1.01 && zmax <= 1.02, `breathe 0.2: zoom máx ${zmax.toFixed(4)} (1–2 %)`);
  const ch = run({ bounds: 'panel', target: '@hero', shots: [{ at: 0, dur: 2.5, move: 'pushIn', amount: 1 }, { at: 2.5, move: 'breathe', amount: 0.2 }] }, { asset: layersAsset(), duration: 5 });
  ok(!ch.plan.limits.some((l) => l.move === 'breathe'), `breathe tras un pushIn al límite: no se limita (${ch.warnings.join(' | ')})`);
  ok(allSafe(ch, 5) >= -0.5, 'pushIn + breathe (panel): sin huecos');
}

{
  // composición: igual a la del player original (view pisa, dx suma, dzoom multiplica; efectos terminan con su clip)
  const cams = [
    { variant: { start: 0, duration: 2 }, def: { id: 'camera' }, rt: { update: () => ({ view: { cx: 100, cy: 50, w: 800 } }) } },
    { variant: { start: 0.5, duration: 1 }, def: { id: 'shake' }, rt: { update: (t) => ({ dx: 10 * t, drot: 1 }) } },
    { variant: { start: 0, duration: 1 }, def: { id: 'dolly' }, rt: { update: () => ({ dzoom: 1.5 }) } },
  ];
  const base = defaultView(stage, W, H);
  const c1 = composeCamera(base, cameraResultsAt(cams, 0.75));
  ok(c1.view.cx === 100 && c1.dx === 2.5 && c1.drot === 1 && c1.dzoom === 1.5, 'composición en t=0.75');
  const c2 = composeCamera(base, cameraResultsAt(cams, 3));
  ok(c2.view.cx === 100 && c2.dx === 0 && c2.dzoom === 1, 'composición: camera sostiene, los efectos terminan');
}

{
  // escena completa por checkGaps: move3d encadenado + un shake encima → el límite incluye el shake (sin huecos)
  const clip = (id, track, preset, start, duration, params) => ({ id, track, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset, start, duration, params }] });
  const scene = {
    meta: { width: W, height: H, fps: 24 },
    assets: { a: layersAsset() },
    scenes: [
      {
        id: 's1',
        active: 'v1',
        variants: [
          {
            id: 'v1',
            status: 'draft',
            duration: 6,
            clips: [
              clip('p', 'panel', 'panel', 0, 6, panelParams),
              clip('cam', 'camera', 'move3d', 0, 6, { target: '@hero', shots: [{ at: 0, dur: 3.5, move: 'pushIn', amount: 0.3 }, { at: 3.5, move: 'breathe', amount: 0.5 }] }),
              clip('hit', 'camera', 'shake', 4.2, 0.5, { intensity: 22 }),
            ],
          },
        ],
      },
    ],
  };
  const presets = Object.fromEntries(BUILTIN.map((d) => [d.id, d]));
  const { checkGaps } = await import('../src/player/camera3d.js');
  const g = checkGaps(scene, presets, { fps: 24 });
  const gaps = g.issues.filter((i) => i.kind === 'edge' || i.kind === 'page');
  ok(!gaps.length, `move3d + shake: sin huecos (${gaps.map((i) => i.msg).join(' | ')})`);
  // sin el shake en el límite, el mismo plan pegado al borde daría hueco: el check sí ve las cámaras viejas
  const old = structuredClone(scene);
  old.scenes[0].variants[0].clips[1] = clip('cam', 'camera', 'camera', 0, 6, { keys: [{ at: 0, cx: 960, cy: 540, w: 1920 }] });
  const g2 = checkGaps(old, presets, { fps: 24 });
  ok(g2.issues.some((i) => i.kind === 'page' || i.kind === 'edge'), 'cámara vieja + shake sobre el encuadre de reposo: check avisa');
}
// ---------- datos de píxeles: marca de medido, huellas, grilla RLE (pixel-bounds.js) ----------
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const sharp = (await import('sharp')).default;
  const { annotateAssetBounds, boundsStatus, boundsWarnings, layerPixelInfo, GRID_MAX } = await import('../src/pixel-bounds.js');
  const { gridHas, hasFrameData } = await import('../src/player/bounds.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-bounds-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    // PNG RGBA w×h con dibujo opaco (color c) donde draw(x, y)
    // (con un degradé en el rojo: ninguna capa de un solo color)
    const png = async (file, w, h, draw, c = [200, 40, 40]) => {
      const buf = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (draw(x, y)) {
            const i = (y * w + x) * 4;
            buf[i] = (c[0] + x) & 255;
            buf[i + 1] = c[1];
            buf[i + 2] = c[2];
            buf[i + 3] = 255;
          }
      await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(dir, file));
    };
    // fondo: triángulo (viñeta inclinada) de 600×400; personaje: disco; ninguna capa de un solo color liso del escenario
    await png('assets/bg.png', 600, 400, (x, y) => x / 600 + y / 400 < 1.2, [30, 90, 160]);
    await png('assets/ch.png', 300, 300, (x, y) => (x - 150) ** 2 + (y - 150) ** 2 < 120 ** 2);
    const asset = () => ({ type: 'layers', w: 600, h: 400, file: 'x.png', layers: [
      { id: 'bg', file: 'assets/bg.png', x: 0, y: 0, w: 600, h: 400, z: 0, role: 'background', depth: 0.4 },
      { id: 'ch', file: 'assets/ch.png', x: 150, y: 50, w: 300, h: 300, z: 1, role: 'character', depth: 0.9, tags: ['hero'] },
    ] });
    // 7) grilla RLE hasta GRID_MAX celdas: decodifica igual que el alfa real (muestras lejos del borde del dibujo)
    const info = await layerPixelInfo(path.join(dir, 'assets/bg.png'));
    ok(info.grid && info.grid.rle && !info.grid.bits, 'grid v2: en RLE');
    ok(Math.max(info.grid.cols, info.grid.rows) <= GRID_MAX && Math.max(info.grid.cols, info.grid.rows) > 64, `grid v2: más fina que 64 celdas (${info.grid.cols}×${info.grid.rows})`);
    const lay = { x: 0, y: 0, w: 600, h: 400, alpha: info.alpha[2] < 600 || info.alpha[3] < 400 ? info.alpha : undefined, grid: info.grid };
    let bad = 0;
    for (let y = 2; y < 400; y += 7)
      for (let x = 2; x < 600; x += 7) {
        const v = x / 600 + y / 400;
        if (Math.abs(v - 1.2) < 0.04) continue;
        if (gridHas(lay, x, y) !== v < 1.2) bad++;
      }
    ok(bad === 0, `grid v2: gridHas coincide con el alfa (${bad} muestras distintas)`);
    // 1) marca de medido: sin ninguna capa sólida, el asset igual cuenta como medido (no repite "comic tags los mide")
    const a = asset();
    const m0 = panelModel({ id: 'p1', params: { ...panelParams, crop: null }, asset: a, start: 0, duration: 4, stage, W, H });
    ok(!hasFrameData(m0), 'sin medir: no hay datos del marco');
    const rep = { measured: [], kept: [] };
    await annotateAssetBounds(dir, a, { report: rep });
    ok(a.bounds && a.bounds.v >= 2 && a.bounds.measured && Object.keys(a.bounds.files).length === 2, 'annotateAssetBounds: deja la marca bounds { v, measured, files }');
    ok(!a.layers.some((l) => l.solid), 'el asset de prueba no tiene capas sólidas');
    const m1 = panelModel({ id: 'p1', params: { ...panelParams, crop: null }, asset: a, start: 0, duration: 4, stage, W, H });
    ok(hasFrameData(m1), 'medido sin capa sólida: hasFrameData por la marca');
    const pw = (as) => {
      const { ctx, warnings } = ctxFor({ move: 'pushIn', target: '@hero', amount: 0.3 }, { asset: as });
      ctx.panels[0].params = { ...panelParams, crop: null };
      planMove3d(ctx);
      return warnings;
    };
    ok(!pw(a).some((w) => /datos del marco/.test(w)), 'move3d: un asset medido sin marco liso no avisa "sin datos del marco"');
    // 3) sin datos: move3d avisa por ctx.warn (llega a player.warnings) que esa viñeta se evalúa como 'panel'
    ok(pw(asset()).some((w) => /no tiene datos del marco.*bounds 'panel'.*comic tags/.test(w)), 'move3d: sin datos del marco avisa por ctx.warn (cae a panel)');
    // 2) huellas: sin cambios → ok; PNG reemplazado → desactualizado (check) y tags recalcula solo esa capa
    ok(boundsStatus(dir, a).state === 'ok', `huellas: recién medido = ok (${JSON.stringify(boundsStatus(dir, a))})`);
    const before = JSON.stringify(a);
    const rep2 = { measured: [], kept: [] };
    await annotateAssetBounds(dir, a, { report: rep2 });
    ok(rep2.measured.length === 0 && rep2.kept.length === 2 && JSON.stringify(a) === before, 'tags sin cambios: no mide nada ni toca el asset');
    // mismo contenido con otro mtime (copia del proyecto): sigue al día (compara el sha1)
    const t = new Date(Date.now() - 86400e3);
    fs.utimesSync(path.join(dir, 'assets/ch.png'), t, t);
    ok(boundsStatus(dir, a).state === 'ok', 'huellas: otro mtime con el mismo contenido = al día');
    await png('assets/ch.png', 300, 300, (x, y) => x < 100 && y < 200); // reemplazado a mano
    const st = boundsStatus(dir, a);
    ok(st.state === 'stale' && st.files.join() === 'assets/ch.png', `huellas: PNG reemplazado = desactualizado (${JSON.stringify(st)})`);
    const bw = boundsWarnings(dir, { x: a });
    ok(bw.length === 1 && /datos de bordes desactualizados para x.*comic tags/.test(bw[0]), `check: avisa datos de bordes desactualizados (${bw.join(' | ')})`);
    const rep3 = { measured: [], kept: [] };
    await annotateAssetBounds(dir, a, { report: rep3 });
    ok(rep3.measured.join() === 'ch' && rep3.kept.join() === 'bg', `tags: recalcula solo lo que cambió (${JSON.stringify(rep3)})`);
    ok(boundsStatus(dir, a).state === 'ok' && a.layers[1].alpha && a.layers[1].alpha[2] === 100, 'tags: datos nuevos del PNG reemplazado');
    // una capa movida en el lienzo (x/y) también es un cambio (alpha va en px del lienzo)
    a.layers[1].x += 10;
    ok(boundsStatus(dir, a).state === 'stale', 'huellas: capa movida = desactualizado');
    // datos de una versión sin huellas (antes de bounds): se avisa
    const legacy = asset();
    legacy.layers[0].alpha = [0, 0, 10, 10];
    ok(boundsStatus(dir, legacy).state === 'legacy' && /versión anterior/.test(boundsWarnings(dir, { y: legacy })[0] || ''), 'huellas: datos viejos sin marca = avisa');
    // imagen plana sin franja pareja: medida (marca) aunque no haya edges
    await png('assets/flat.png', 200, 100, () => true, [10, 200, 10]);
    const img = { type: 'image', file: 'assets/flat.png', w: 200, h: 100 };
    await png('assets/flat.png', 200, 100, (x, y) => (x * y) % 7 !== 0, [10, 200, 10]);
    await annotateAssetBounds(dir, img);
    const mf = panelModel({ id: 'p1', params: { ...panelParams, crop: null }, asset: img, start: 0, duration: 4, stage, W, H });
    ok(img.bounds && hasFrameData(mf), 'imagen medida: hasFrameData aunque no tenga edges');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 4) shots: tiempos fuera del clip o que se pisan ----------
{
  const { shotProblems } = await import('../src/player/camera3d.js');
  const { validate } = await import('../src/project.js');
  ok(!shotProblems({ shots: [{ at: 0, dur: 2, move: 'pushIn' }, { at: 2, move: 'breathe' }] }, 4).length, 'shots en orden y dentro del clip: sin problemas');
  const late = shotProblems({ shots: [{ at: 0, move: 'pushIn' }, { at: 5, dur: 1, move: 'truck' }] }, 4);
  ok(late.some((m) => /shot 2 \(truck\): arranca en 5 s, después del fin del clip \(4 s\)/.test(m)), `at > duración: avisa (${late.join(' | ')})`);
  const over = shotProblems({ shots: [{ at: 0, dur: 3, move: 'pushIn' }, { at: 2, dur: 1, move: 'truck' }] }, 4);
  ok(over.some((m) => /shot 2 \(truck\) se pisa con shot 1 \(pushIn\)/.test(m)), `tramos que se pisan: avisa (${over.join(' | ')})`);
  const long = shotProblems({ shots: [{ at: 1, dur: 4, move: 'pushIn' }] }, 4);
  ok(long.some((m) => /termina en 5 s, después del fin del clip/.test(m)), `dur que excede: avisa (${long.join(' | ')})`);
  const { ctx, warnings } = ctxFor({ shots: [{ at: 0, dur: 3, move: 'pushIn', target: '@hero', amount: 0.2 }, { at: 2, dur: 3, move: 'breathe' }] }, { asset: layersAsset(true) });
  planMove3d(ctx);
  ok(warnings.some((w) => /se pisa/.test(w)) && warnings.some((w) => /termina en 5 s/.test(w)), `plan: warning claro (${warnings.join(' | ')})`);
  const clip = (id, track, preset, start, duration, params) => ({ id, track, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset, start, duration, params }] });
  const sc = { meta: { width: W, height: H, fps: 24 }, assets: { a: layersAsset(true) }, scenes: [{ id: 's1', active: 'v1', variants: [{ id: 'v1', status: 'draft', duration: 4, clips: [clip('p', 'panel', 'panel', 0, 4, panelParams), clip('cam', 'camera', 'move3d', 0, 4, { target: '@hero', shots: [{ at: 0, move: 'pushIn' }, { at: 4.5, dur: 1, move: 'truck' }] })] }] }] };
  const v = validate(sc, null);
  ok(v.errors.some((e) => /cam\/v1: shot 2 \(truck\): arranca en 4.5 s/.test(e)), `check: error por shot fuera del clip (${v.errors.join(' | ')})`);
}

// ---------- 5) memo del plan entre rebuilds ----------
{
  const { cachedPlan, planKey, clearPlanCache, PLAN_CACHE_MAX } = await import('../src/player/camera3d.js');
  clearPlanCache();
  const params = { move: 'truck', target: '@hero', amount: 1 };
  const a1 = ctxFor(params, { asset: layersAsset(true) });
  const t0 = performance.now();
  const p1 = cachedPlan(a1.ctx);
  const cold = performance.now() - t0;
  // rebuild: objetos nuevos con el mismo contenido (como al editar otra escena) → mismo plan, avisos repetidos
  const a2 = ctxFor(params, { asset: layersAsset(true) });
  const t1 = performance.now();
  const p2 = cachedPlan(a2.ctx);
  const warm = performance.now() - t1;
  ok(p1 === p2, 'memo: mismo contenido = mismo plan (no se recalcula)');
  ok(a1.warnings.length > 0 && JSON.stringify(a2.warnings) === JSON.stringify(a1.warnings), `memo: los avisos se repiten por ctx.warn (${a2.warnings.length})`);
  console.log(`  plan move3d: ${cold.toFixed(1)} ms sin memo, ${warm.toFixed(2)} ms con memo`);
  // determinismo: el plan memorizado da el mismo estado que uno nuevo
  const fresh = planMove3d(ctxFor(params, { asset: layersAsset(true) }).ctx);
  let same = true;
  for (let t = 0; t <= 4; t += 0.25) same = same && JSON.stringify(move3dState(p2, t)) === JSON.stringify(move3dState(fresh, t));
  ok(same, 'memo: el estado es idéntico al de un plan nuevo');
  // cualquier cambio relevante cambia la clave: params, asset, viñetas, efectos de cámara, fps
  const k0 = planKey(a2.ctx);
  const variants = [
    ctxFor({ ...params, amount: 0.9 }, { asset: layersAsset(true) }).ctx,
    ctxFor(params, { asset: layersAsset(false) }).ctx,
    (() => { const c = ctxFor(params, { asset: layersAsset(true) }).ctx; c.panels = [{ ...c.panels[0], params: { ...panelParams, depthScale: 0.5 } }]; return c; })(),
    (() => { const c = ctxFor(params, { asset: layersAsset(true) }).ctx; c.cameraEffects = [{ clip: { id: 'hit' }, variant: { id: 'v1', preset: 'shake', start: 1, duration: 0.5, params: { intensity: 20 } }, def: { id: 'shake' }, rt: { update: () => ({}) } }]; return c; })(),
    (() => { const c = ctxFor(params, { asset: layersAsset(true) }).ctx; c.fps = 30; return c; })(),
  ];
  ok(variants.every((c) => planKey(c) !== k0), 'memo: params/asset/viñetas/efectos/fps cambian la clave');
  // el player arma el plan con move3d.build: también pasa por el memo
  const b = ctxFor(params, { asset: layersAsset(true) });
  const rt = move3d.build(b.ctx);
  ok(JSON.stringify(rt.update(2)) === JSON.stringify(move3dState(p1, 2) && move3d.build(a2.ctx).update(2)) && JSON.stringify(b.warnings) === JSON.stringify(a1.warnings), 'memo: build usa el plan memorizado');
  // límite de tamaño
  for (let i = 0; i < PLAN_CACHE_MAX + 5; i++) cachedPlan(ctxFor({ ...params, amount: 0.01 * i }, { asset: layersAsset(true) }).ctx);
  ok(cachedPlan(ctxFor(params, { asset: layersAsset(true) }).ctx) !== p1, 'memo: LRU con límite (el más viejo sale)');
}

// ---------- 6) check --gaps --bounds: fuerza la definición de hueco ----------
{
  const { checkGaps } = await import('../src/player/camera3d.js');
  const presets = Object.fromEntries(BUILTIN.map((d) => [d.id, d]));
  const framedAsset = { type: 'layers', w: 2000, h: 1200, file: 'x.png', layers: [
    { id: 'paper', file: 'p.png', x: -1000, y: -600, w: 4000, h: 2400, z: 0, role: 'background', depth: 0, global: true, solid: '#000000' },
    { id: 'art', file: 'a.png', x: 200, y: 200, w: 1600, h: 800, z: 1, role: 'background', depth: 0.4 },
  ] };
  const clip = (id, track, preset, start, duration, params) => ({ id, track, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset, start, duration, params }] });
  const sc = { meta: { width: W, height: H, fps: 24, background: '#000000' }, assets: { a: framedAsset }, scenes: [{ id: 's1', active: 'v1', variants: [{ id: 'v1', status: 'draft', duration: 2, clips: [clip('p', 'panel', 'panel', 0, 2, panelParams), clip('cam', 'camera', 'camera', 0, 2, { keys: [{ at: 0, cx: 1100, cy: 540, w: 1920 }] })] }] }] };
  const art = checkGaps(sc, presets, { fps: 4 });
  ok(!art.issues.length, `--gaps (art por defecto): el marco negro no es hueco (${art.issues.map((i) => i.msg).join(' | ')})`);
  const page = checkGaps(sc, presets, { fps: 4, bounds: 'panel' });
  ok(page.issues.some((i) => i.kind === 'page'), '--gaps --bounds panel: la misma vista sale de la viñeta');
  // con un move3d bounds 'page' en la escena, --bounds art lo pisa
  const sc2 = structuredClone(sc);
  // (antes que la cámara: la vista que se ve es la de `camera`; move3d solo aporta su bounds)
  sc2.scenes[0].variants[0].clips.splice(1, 0, clip('m3', 'camera', 'move3d', 0, 0.1, { move: 'breathe', amount: 0, bounds: 'page' }));
  const own = checkGaps(sc2, presets, { fps: 4 });
  const forced = checkGaps(sc2, presets, { fps: 4, bounds: 'art' });
  ok(own.issues.length > 0 && !forced.issues.some((i) => i.kind === 'page'), `--bounds art pisa el bounds del move3d (${own.issues.length} vs ${forced.issues.length})`);
}

console.log(`${fails ? '✗' : '✓'} camera3d: ${passes} ok, ${fails} fallas`);
process.exit(fails ? 1 : 0);
