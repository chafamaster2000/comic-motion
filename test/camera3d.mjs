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
console.log(`${fails ? '✗' : '✓'} camera3d: ${passes} ok, ${fails} fallas`);
process.exit(fails ? 1 : 0);
