// VFX de pantalla dentro de la viñeta (pases de post): cuadros de impacto y bloom.
import { common, targetInfo, envelope } from './common.js';

const MODES = { none: 0, neg: 1, bw: 2, bwi: 3, white: 4, red: 5 };

// Cuadros de impacto estilo anime: 2–4 cuadros de negativo / umbral B/N + líneas radiales.
export const impactFlash = {
  id: 'impactFlash',
  kind: 'vfx',
  gpu: true,
  post: true,
  label: 'Cuadros de impacto (anime)',
  params: [
    ...common({ layer: false, anchor: true }),
    { key: 'at', label: 'Instante (s del clip)', type: 'number', min: 0, max: 30, step: 0.02, default: 0 },
    { key: 'frames', label: 'Cuadros (neg, bw, bwi, white, red, none; separados por coma)', type: 'text', default: 'neg,bw,neg' },
    { key: 'rate', label: 'Cuadros por segundo del flash', type: 'number', min: 4, max: 60, default: 12 },
    { key: 'threshold', label: 'Umbral B/N', type: 'number', min: 0.05, max: 0.95, step: 0.05, default: 0.5 },
    { key: 'lines', label: 'Líneas radiales (0 = sin líneas)', type: 'number', min: 0, max: 400, default: 110 },
    { key: 'inner', label: 'Radio libre de líneas (px)', type: 'number', min: 0, max: 3000, default: 260 },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const { vec2, vec3, vec4, float, dot, step, select, fract, floor, atan, length, smoothstep, fwidth, max, abs, uniform, int } = g.TSL;
    const p = ctx.params;
    const { anchor } = targetInfo(ctx);
    const mode = uniform(0);
    const fseed = uniform(0);
    const th = p.threshold ?? 0.5;
    const nl = Math.max(0, Math.round(p.lines ?? 110));
    const inner = p.inner ?? 260;
    g.post(
      (io) => {
        const c = io.color.rgb;
        const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        const bw = vec3(step(th, l));
        let out = select(mode.equal(1), vec3(1).sub(c), c);
        out = select(mode.equal(2), bw, out);
        out = select(mode.equal(3), vec3(1).sub(bw), out);
        out = select(mode.equal(4), vec3(1), out);
        out = select(mode.equal(5), vec3(step(th, l), 0, 0).add(vec3(0.85, 0.05, 0.05).mul(float(1).sub(step(th, l)))), out);
        if (nl > 0) {
          const D = io.pagePos.sub(vec2(anchor[0], anchor[1]));
          const a = atan(D.y, D.x).div(Math.PI * 2).add(0.5).mul(nl);
          const b = floor(a);
          const hsh = g.fx.hash2(b.toUint(), fseed.toUint());
          const hsh2 = g.fx.hash2(b.toUint().add(7919), fseed.toUint());
          const w = hsh.mul(0.35).add(0.05);
          const fr = abs(fract(a).sub(0.5));
          const r = length(D);
          const rin = hsh2.mul(0.8).add(0.6).mul(inner);
          // la línea se afina hacia adentro (cuña)
          const taper = smoothstep(rin, rin.add(inner * 1.5 + 1), r);
          const wid = w.mul(taper).mul(0.5);
          const aa = max(fwidth(a), 1e-4);
          const on = smoothstep(wid.add(aa), wid.sub(aa), fr).mul(step(rin, r)).mul(step(0.35, hsh2));
          const ink = select(mode.equal(1).or(mode.equal(3)), vec3(1), vec3(0));
          out = select(mode.greaterThan(0), out.mul(float(1).sub(on)).add(ink.mul(on)), out);
        }
        return vec4(out, 1);
      },
      { order: 20 },
    );
    const seq = String(p.frames || 'neg,bw,neg')
      .split(',')
      .map((s) => MODES[s.trim()] ?? 0);
    const rate = p.rate || 12;
    const at = p.at ?? 0;
    return {
      update(t) {
        const f = Math.floor((t - at) * rate + 1e-6);
        const m = t >= at && f < seq.length ? seq[f] : 0;
        mode.value = m;
        fseed.value = f + 1;
        g.enabled.value = m > 0 ? 1 : 0;
      },
    };
  },
};

// Bloom sobre la viñeta (BloomNode de three): umbral, radio, intensidad.
export const glow = {
  id: 'glow',
  kind: 'vfx',
  gpu: true,
  post: true,
  label: 'Bloom / resplandor',
  params: [
    ...common({ layer: false }),
    { key: 'threshold', label: 'Umbral (0..1)', type: 'number', min: 0, max: 1, step: 0.02, default: 0.88 },
    { key: 'radius', label: 'Radio (0..1)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.35 },
    { key: 'strength', label: 'Intensidad', type: 'number', min: 0, max: 4, step: 0.05, default: 0.55 },
    { key: 'fade', label: 'Fundido de entrada/salida (s)', type: 'number', min: 0, max: 3, step: 0.05, default: 0.25 },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const p = ctx.params;
    const b = g.bloom({ strength: 0, radius: p.radius ?? 0.35, threshold: p.threshold ?? 0.88 });
    return {
      update(t) {
        b.strength.value = (p.strength ?? 0.55) * (p.intensity ?? 1) * envelope(t, ctx.duration, p.fade ?? 0.25, p.fade ?? 0.25) * g.enabled.value;
      },
    };
  },
};

export const SCREEN = [impactFlash, glow];
export { targetInfo };
