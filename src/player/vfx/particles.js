// VFX de partículas analíticas: nieve, chispas y estallido de impacto.
// Posición = f(semilla, t) en forma cerrada, todo en el vertex shader (instanciado). Los aleatorios por
// partícula salen de mulberry32 en JS (atributos r0, r1), no de fract(sin()).
import { common, targetInfo, envelope } from './common.js';

const TAU = Math.PI * 2;

export const snow = {
  id: 'snow',
  kind: 'vfx',
  gpu: true,
  label: 'Nieve',
  params: [
    ...common({ layer: 'mid', style: true }),
    { key: 'count', label: 'Densidad (copos)', type: 'number', min: 50, max: 40000, step: 50, default: 2500 },
    { key: 'size', label: 'Tamaño (px)', type: 'number', min: 1, max: 60, step: 0.5, default: 7 },
    { key: 'speed', label: 'Velocidad de caída (px/s)', type: 'number', min: 0, max: 1500, default: 140 },
    { key: 'wind', label: 'Viento (px/s)', type: 'number', min: -800, max: 800, default: 40 },
    { key: 'drift', label: 'Deriva (px)', type: 'number', min: 0, max: 200, default: 26 },
    { key: 'blur', label: 'Bokeh / desenfoque (0..1)', type: 'number', min: 0, max: 1, step: 0.05, default: 0 },
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'opacity', label: 'Opacidad', type: 'number', min: 0, max: 1, step: 0.05, default: 0.9 },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const { vec2, vec3, float, sin, cos, floor } = g.TSL;
    const p = ctx.params;
    const { rect } = targetInfo(ctx);
    const layer = p.layer || 'mid';
    const m = Math.max(rect[2], rect[3]) * 0.12 + (p.size || 7) * 3;
    const X0 = rect[0] - m;
    const Y0 = rect[1] - m;
    const Ww = rect[2] + 2 * m;
    const Hh = rect[3] + 2 * m;
    const fmod = (x, y) => x.sub(float(y).mul(floor(x.div(y))));
    const col = new g.THREE.Color(p.color || '#ffffff');
    const opacity = (p.opacity ?? 0.9) * (p.intensity ?? 1);
    const size = p.size ?? 7;
    const blur = p.blur ?? 0;
    g.particles(
      {
        count: p.count ?? 2500,
        style: p.style === 'ink' ? 'ink' : 'soft',
        blend: 'normal',
        halo: 0,
        soft: 0.12 + blur * 0.9,
        shutter: 0.5 / (ctx.fps || 24),
        motion: ({ r0, r1, t }) => {
          const vy = float(p.speed ?? 140).mul(r0.z.mul(0.7).add(0.55));
          const y = fmod(r1.z.mul(Hh).add(vy.mul(t)), Hh).add(Y0);
          const fr = r1.x.mul(0.5).add(0.15).mul(TAU);
          const ph = r0.w.mul(TAU);
          const amp = r1.y.mul(0.6).add(0.4).mul(p.drift ?? 26);
          const xr = r0.x.mul(Ww).add(t.mul(p.wind ?? 40)).add(amp.mul(sin(fr.mul(t).add(ph))));
          const x = fmod(xr, Ww).add(X0);
          const vel = vec2(amp.mul(fr).mul(cos(fr.mul(t).add(ph))).add(p.wind ?? 40), vy);
          return {
            pos: vec2(x, y),
            vel,
            size: r0.z.mul(0.9).add(0.45).mul(size * (1 + blur * 1.5)),
            alpha: r1.w.mul(0.45).add(0.55).mul(opacity).mul(g.enabled),
            color: vec3(col.r, col.g, col.b),
          };
        },
      },
      layer,
    );
    return {
      update() {},
    };
  },
};

// Chispas balísticas con gravedad y drag, estiradas por velocidad, aditivas, color por temperatura.
export const sparks = {
  id: 'sparks',
  kind: 'vfx',
  gpu: true,
  label: 'Chispas',
  params: [
    ...common({ layer: 'front', anchor: true, style: true }),
    { key: 'rate', label: 'Chispas por segundo', type: 'number', min: 1, max: 5000, default: 160 },
    { key: 'emit', label: 'Emite durante (s, 0 = todo el clip)', type: 'number', min: 0, max: 30, step: 0.05, default: 0 },
    { key: 'life', label: 'Vida (s)', type: 'number', min: 0.05, max: 5, step: 0.05, default: 0.9 },
    { key: 'speed', label: 'Velocidad (px/s)', type: 'number', min: 0, max: 5000, default: 750 },
    { key: 'angle', label: 'Dirección (°, -90 = arriba)', type: 'number', min: -180, max: 180, default: -90 },
    { key: 'spread', label: 'Apertura (°)', type: 'number', min: 0, max: 360, default: 70 },
    { key: 'gravity', label: 'Gravedad (px/s²)', type: 'number', min: -3000, max: 5000, default: 1500 },
    { key: 'drag', label: 'Drag (1/s)', type: 'number', min: 0, max: 10, step: 0.1, default: 1.2 },
    { key: 'size', label: 'Tamaño (px)', type: 'number', min: 0.5, max: 30, step: 0.5, default: 3 },
    { key: 'stretch', label: 'Estiramiento por velocidad', type: 'number', min: 0, max: 4, step: 0.1, default: 1 },
    { key: 'temperature', label: 'Temperatura (0 = blanco caliente, 1 = brasa)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.1 },
    { key: 'color', label: 'Color fijo (vacío = por temperatura)', type: 'color', default: '' },
    { key: 'radius', label: 'Radio del emisor (px)', type: 'number', min: 0, max: 400, default: 10 },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const p = ctx.params;
    const { anchor } = targetInfo(ctx);
    const rate = Math.max(1, p.rate ?? 160);
    const emit = p.emit > 0 ? Math.min(p.emit, ctx.duration) : ctx.duration;
    const count = Math.ceil(rate * emit);
    sparkSystem(ctx, { ...p, anchor, count, birth: (i, r) => i.div(rate).add(r.mul(1 / rate)) });
    return { update() {} };
  },
};

// Motor común de chispas: `birth(idx, r)` (TSL) da el instante de nacimiento de la partícula idx.
function sparkSystem(ctx, o) {
  const g = ctx.gpu;
  const { vec2, vec3, float, sin, cos, max, pow, select } = g.TSL;
  const col = o.color ? new g.THREE.Color(o.color) : null;
  const angle = ((o.angle ?? -90) * Math.PI) / 180;
  const spread = ((o.spread ?? 70) * Math.PI) / 180;
  const inten = o.intensity ?? 1;
  return g.particles(
    {
      count: o.count,
      style: o.style === 'ink' ? 'ink' : 'glow',
      stretch: o.stretch ?? 1,
      shutter: 1 / (ctx.fps || 24),
      halo: 0.55,
      soft: 0.25,
      motion: ({ r0, r1, t, idx, fx }) => {
        const tb = o.birth(float(idx), r0.w);
        const life = r0.z.mul(0.5).add(0.5).mul(o.life ?? 0.9);
        const tau = t.sub(tb);
        const a = o.radial ? r0.x.mul(Math.PI * 2) : r0.x.sub(0.5).mul(spread).add(angle);
        const sp = o.radial ? pow(r0.y, 0.5).mul(0.75).add(0.25).mul(o.speed ?? 750) : r0.y.mul(0.6).add(0.4).mul(o.speed ?? 750);
        const v0 = vec2(cos(a), sin(a)).mul(sp);
        const p0 = vec2(o.anchor[0], o.anchor[1]).add(r1.xy.sub(0.5).mul((o.radius ?? 10) * 2));
        const pv = fx.ballistic(p0, v0, vec2(0, o.gravity ?? 1500), float(o.drag ?? 1.2), max(tau, 0));
        const u = tau.div(life).clamp(0, 1);
        const alive = tau.greaterThanEqual(0).and(tau.lessThan(life));
        const alpha = select(alive, pow(float(1).sub(u), 1.3).mul(inten), float(0)).mul(g.enabled);
        const color = col ? vec3(col.r, col.g, col.b) : fx.heat(u.mul(0.85).add(o.temperature ?? 0.1).clamp(0, 1));
        return { pos: pv.xy, vel: pv.zw, size: r1.z.mul(0.8).add(0.6).mul(o.size ?? 3).mul(float(1).sub(u.mul(0.5))), alpha, color };
      },
    },
    o.layer || 'front',
  );
}

// Estallido de impacto radial en `anchor` en el instante `at`: chispas + destello + anillo.
export const burst = {
  id: 'burst',
  kind: 'vfx',
  gpu: true,
  label: 'Estallido de impacto',
  params: [
    ...common({ layer: 'front', anchor: true, style: true }),
    { key: 'at', label: 'Instante del impacto (s del clip)', type: 'number', min: 0, max: 30, step: 0.02, default: 0.05 },
    { key: 'count', label: 'Chispas', type: 'number', min: 0, max: 5000, default: 220 },
    { key: 'speed', label: 'Velocidad (px/s)', type: 'number', min: 0, max: 6000, default: 1600 },
    { key: 'life', label: 'Vida (s)', type: 'number', min: 0.05, max: 3, step: 0.05, default: 0.7 },
    { key: 'gravity', label: 'Gravedad (px/s²)', type: 'number', min: -3000, max: 5000, default: 700 },
    { key: 'drag', label: 'Drag (1/s)', type: 'number', min: 0, max: 12, step: 0.1, default: 3.5 },
    { key: 'size', label: 'Tamaño de chispa (px)', type: 'number', min: 0.5, max: 30, step: 0.5, default: 4 },
    { key: 'ring', label: 'Anillo: radio máx (px, 0 = sin anillo)', type: 'number', min: 0, max: 3000, default: 480 },
    { key: 'flash', label: 'Destello: tamaño (px, 0 = sin destello)', type: 'number', min: 0, max: 3000, default: 520 },
    { key: 'temperature', label: 'Temperatura (0 = blanco, 1 = brasa)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.05 },
    { key: 'color', label: 'Color fijo (vacío = por temperatura)', type: 'color', default: '' },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const T = g.THREE;
    const { vec2, vec3, vec4, float, uv, length, exp, clamp, fwidth, max, atan, cos, abs, pow, uniform } = g.TSL;
    const p = ctx.params;
    const { anchor } = targetInfo(ctx);
    const at = p.at ?? 0.05;
    const layer = p.layer || 'front';
    const inten = p.intensity ?? 1;
    if ((p.count ?? 220) > 0) sparkSystem(ctx, { ...p, anchor, radial: true, radius: 6, stretch: 1.2, birth: (i, r) => r.mul(0.03).add(at) });
    const grp = g.layer(layer);
    const tint = p.color ? new T.Color(p.color) : new T.Color(1, 0.93, 0.7);
    // anillo: quad de 2R, perfil gaussiano alrededor del radio actual
    const ringR = uniform(0);
    const ringW = uniform(1);
    const ringA = uniform(0);
    const Rmax = Math.max(1, p.ring ?? 480);
    if ((p.ring ?? 480) > 0) {
      const d = length(uv().sub(0.5)).mul(Rmax * 2.2); // px desde el centro
      const x = d.sub(ringR).div(ringW);
      const aa = max(fwidth(d).div(ringW), 1e-3);
      const a = exp(x.mul(x).mul(-1)).mul(clamp(float(1.5).sub(abs(x)).div(aa), 0, 1)).mul(ringA);
      const mesh = new T.Mesh(new T.PlaneGeometry(Rmax * 2.2, Rmax * 2.2), g.material({ fragment: p.style === 'ink' ? vec4(vec3(0.07).mul(a), a) : vec4(vec3(tint.r, tint.g, tint.b).mul(a), 0), blend: p.style === 'ink' ? 'normal' : 'add' }));
      mesh.position.set(anchor[0], anchor[1], 0);
      mesh.renderOrder = 5;
      grp.add(mesh);
    }
    // destello: disco suave + estrella de 8 puntas
    const flA = uniform(0);
    const flS = uniform(1);
    const F = Math.max(1, p.flash ?? 520);
    if ((p.flash ?? 520) > 0) {
      const q = uv().sub(0.5).mul(2);
      const r = length(q).div(flS);
      const ang = atan(q.y, q.x);
      const star = pow(abs(cos(ang.mul(4))), 12).mul(exp(r.mul(-2.2)));
      const disc = exp(r.mul(r).mul(-9));
      const a = clamp(disc.add(star.mul(0.8)), 0, 1).mul(flA);
      const mesh = new T.Mesh(new T.PlaneGeometry(F, F), g.material({ fragment: vec4(vec3(1, 0.98, 0.9).mul(a), 0), blend: 'add' }));
      mesh.position.set(anchor[0], anchor[1], 0);
      mesh.renderOrder = 6;
      if (p.style !== 'ink') grp.add(mesh);
    }
    return {
      update(t) {
        const tau = t - at;
        const on = tau >= 0;
        const k = Math.max(0, tau);
        // anillo: sale rápido (easeOut) y se afina
        const pr = Math.min(1, k / 0.45);
        const e = 1 - Math.pow(1 - pr, 3);
        ringR.value = e * Rmax;
        ringW.value = Math.max(2, (1 - pr) * Rmax * 0.09 + 3);
        ringA.value = on && pr < 1 ? (1 - pr) * inten : 0;
        // destello: sube en 1 cuadro y cae exponencial
        flA.value = on ? Math.exp(-k * 14) * inten : 0;
        flS.value = 0.35 + 0.65 * Math.min(1, k / 0.06);
      },
    };
  },
};

export const PARTICLES = [snow, sparks, burst];
export { envelope };
