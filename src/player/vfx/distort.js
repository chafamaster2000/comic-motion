// VFX de deformación: muestrean la viñeta ya compuesta (post) en coordenadas desplazadas.
import { common, targetInfo, envelope } from './common.js';

// Onda de choque radial desde `anchor`: refracción (derivada de gaussiana) + borde brillante.
export const shockwave = {
  id: 'shockwave',
  kind: 'vfx',
  gpu: true,
  distort: true,
  label: 'Onda de choque',
  params: [
    ...common({ layer: false, anchor: true }),
    { key: 'at', label: 'Instante (s del clip)', type: 'number', min: 0, max: 30, step: 0.02, default: 0.05 },
    { key: 'life', label: 'Duración de la onda (s)', type: 'number', min: 0.05, max: 5, step: 0.05, default: 0.65 },
    { key: 'radius', label: 'Radio final (px)', type: 'number', min: 10, max: 4000, default: 900 },
    { key: 'width', label: 'Ancho del frente (px)', type: 'number', min: 2, max: 600, default: 70 },
    { key: 'strength', label: 'Refracción (px)', type: 'number', min: 0, max: 200, default: 34 },
    { key: 'edge', label: 'Brillo del borde', type: 'number', min: 0, max: 2, step: 0.05, default: 0.45 },
    { key: 'chroma', label: 'Separación de color', type: 'number', min: 0, max: 1, step: 0.05, default: 0.35 },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const { vec2, vec3, vec4, float, length, exp, max, uniform } = g.TSL;
    const p = ctx.params;
    const { anchor } = targetInfo(ctx);
    const r = uniform(0);
    const env = uniform(0);
    const W = p.width ?? 70;
    const S = (p.strength ?? 34) * (p.intensity ?? 1);
    const E = (p.edge ?? 0.45) * (p.intensity ?? 1);
    const C = p.chroma ?? 0.35;
    g.post(
      (io) => {
        const D = io.pagePos.sub(vec2(anchor[0], anchor[1]));
        const d = length(D);
        const dir = D.div(max(d, 1e-3));
        const x = d.sub(r).div(W);
        const g1 = exp(x.mul(x).negate());
        const off = dir.mul(x.mul(g1).mul(-2 * S)).mul(env);
        const uv0 = io.uv.sub(io.pageDeltaToUv(off));
        const dc = io.pageDeltaToUv(off.mul(C));
        const col = vec3(io.sample(uv0.sub(dc)).r, io.sample(uv0).g, io.sample(uv0.add(dc)).b);
        const glow = g1.mul(g1).mul(E).mul(env);
        return vec4(col.add(vec3(glow)), 1);
      },
      { sample: true, order: 10 },
    );
    const at = p.at ?? 0.05;
    const life = p.life ?? 0.65;
    const R = p.radius ?? 900;
    return {
      update(t) {
        const k = (t - at) / life;
        const on = k >= 0 && k < 1;
        g.enabled.value = on ? 1 : 0;
        const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 2.2);
        r.value = e * R;
        env.value = on ? Math.pow(1 - k, 1.5) * Math.min(1, k * 12) : 0;
      },
    };
  },
};

// Distorsión por calor: ruido ascendente dentro de una zona elíptica sobre `anchor`.
export const heat = {
  id: 'heat',
  kind: 'vfx',
  gpu: true,
  distort: true,
  label: 'Distorsión por calor',
  params: [
    ...common({ layer: false, anchor: true }),
    { key: 'radius', label: 'Ancho de la zona (px, semieje)', type: 'number', min: 10, max: 3000, default: 320 },
    { key: 'height', label: 'Alto de la zona (px, hacia arriba)', type: 'number', min: 10, max: 3000, default: 520 },
    { key: 'strength', label: 'Desplazamiento (px)', type: 'number', min: 0, max: 60, step: 0.5, default: 7 },
    { key: 'scale', label: 'Tamaño del ruido (px)', type: 'number', min: 4, max: 600, default: 70 },
    { key: 'speed', label: 'Velocidad de subida (px/s)', type: 'number', min: 0, max: 2000, default: 160 },
  ],
  build(ctx) {
    const g = ctx.gpu;
    const { vec2, vec3, vec4, float, length, smoothstep } = g.TSL;
    const p = ctx.params;
    const { anchor } = targetInfo(ctx);
    const env = g.uniform(0);
    const sc = p.scale ?? 70;
    const hgt = p.height ?? 520;
    const cx = anchor[0];
    const cy = anchor[1] - hgt / 2;
    const S = (p.strength ?? 7) * (p.intensity ?? 1);
    g.post(
      (io) => {
        const P = io.pagePos;
        const q = P.sub(vec2(cx, cy)).div(vec2(p.radius ?? 320, hgt / 2));
        const mask = float(1).sub(smoothstep(0.35, 1, length(q)));
        const n = P.div(sc).add(vec2(0, g.time.mul((p.speed ?? 160) / sc)));
        const nx = g.fx.noise(vec3(n, g.time.mul(0.6)));
        const ny = g.fx.noise(vec3(n.add(17.3), g.time.mul(0.6).add(4.1)));
        const off = vec2(nx, ny).mul(S).mul(mask).mul(env);
        return vec4(io.sample(io.uv.add(io.pageDeltaToUv(off))).rgb, 1);
      },
      { sample: true, order: 11 },
    );
    return {
      update(t) {
        env.value = envelope(t, ctx.duration, 0.4, 0.4);
      },
    };
  },
};

export const DISTORT = [shockwave, heat];
