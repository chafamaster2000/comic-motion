// Filtros de viñeta portados a TSL para las viñetas GPU. Mismos params que los filtros DOM de presets.js.
// Cada filtro: { sample: bool (necesita muestrear en otro uv), node({ color, sample, params, h, seed }) → vec4 }.
// h: helpers de coordenadas (localPos en px de la caja interior, pageDeltaToUv, …) de engine.js.
import * as TSL from 'three/tsl';
import { Color } from 'three/webgpu';
import { parseCssFilter } from './filter-support.js';

const { vec2, vec3, vec4, float, dot, clamp, mix, length, fract, floor, smoothstep, hash } = TSL;

const hex = (c) => {
  const k = new Color(c || '#000');
  return vec3(k.r, k.g, k.b);
};

// ---- matrices de las funciones de filtro CSS (Filter Effects 1), en sRGB como hace Chrome ----
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const mul3 = (a, b) => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
};
const saturateM = (s) => [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
const sepiaM = (a) => {
  const k = 1 - Math.min(1, a);
  return [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k];
};
const hueM = (deg) => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
};
const applyM = (rgb, m) => clamp(vec3(dot(vec3(m[0], m[1], m[2]), rgb), dot(vec3(m[3], m[4], m[5]), rgb), dot(vec3(m[6], m[7], m[8]), rgb)), 0, 1);

function cssOps(rgb, ops) {
  let c = rgb;
  for (const [fn, v] of ops) {
    if (fn === 'brightness') c = clamp(c.mul(v), 0, 1);
    else if (fn === 'contrast') c = clamp(c.sub(0.5).mul(v).add(0.5), 0, 1);
    else if (fn === 'saturate') c = applyM(c, saturateM(v));
    else if (fn === 'grayscale') c = applyM(c, saturateM(1 - Math.min(1, v)));
    else if (fn === 'sepia') c = applyM(c, sepiaM(v));
    else if (fn === 'invert') c = mix(c, vec3(1).sub(c), Math.min(1, v));
    else if (fn === 'hue-rotate') c = applyM(c, hueM(v));
  }
  return c;
}

const lum = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));

export const TSL_FILTERS = {
  css: {
    node({ color, params }) {
      return vec4(cssOps(color.rgb, parseCssFilter(params.value ?? 'contrast(1.2) saturate(1.3)').ops), color.a);
    },
  },
  posterize: {
    node({ color, params }) {
      const levels = Math.max(2, Math.round(params.levels ?? 4));
      const s = applyM(color.rgb, saturateM(params.saturate ?? 1.3));
      // feFuncX type=discrete con n valores equiespaciados
      const q = clamp(floor(s.mul(levels)), 0, levels - 1).div(levels - 1);
      return vec4(q, color.a);
    },
  },
  chroma: {
    sample: true,
    node({ color, sample, params, h }) {
      const o = params.offset ?? 3;
      const d = h.pageDeltaToUv(vec2(o, 0));
      const r = sample(h.uv.sub(d)).r;
      const b = sample(h.uv.add(d)).b;
      return vec4(r, color.g, b, color.a);
    },
  },
  paper: {
    node({ color, params, h }) {
      const sep = params.sepia ?? 0.35;
      return vec4(cssOps(color.rgb, [['sepia', sep], ['contrast', 1.05]]), color.a);
    },
    // capas que el filtro DOM agrega encima de la imagen (van después de todos los filtros CSS)
    overlay({ color, params, h }) {
      const grain = params.grain ?? 0.35;
      let c = color.rgb;
      // grano: ruido por px local (entero → hash PCG)
      const cell = floor(h.localPos);
      const n = hash(cell.x.toInt().mul(73856093).bitXor(cell.y.toInt().mul(19349663)).toUint()).sub(0.5).mul(0.15).add(0.9);
      c = c.mul(mix(float(1), n, grain));
      // viñeteado sepia (radial-gradient ellipse farthest-corner, transparente al 55%)
      const half = h.inner.mul(0.5);
      const e = length(h.localPos.sub(half).div(half.mul(Math.SQRT2)));
      const a = clamp(e.sub(0.55).div(0.45), 0, 1).mul(0.35);
      c = mix(c, vec3(90 / 255, 60 / 255, 20 / 255), a);
      return vec4(c, color.a);
    },
  },
  halftone: {
    // es una capa encima de la imagen (el modo print usa una copia SIN filtrar de la imagen: raw)
    overlay({ color, raw, params, h }) {
      const sample = raw;
      const size = params.size ?? 10;
      const op = params.opacity ?? 0.45;
      const mode = params.mode || 'print';
      const cellP = fract(h.localPos.div(size)).sub(0.5).mul(size);
      const d = length(cellP);
      if (mode === 'print') {
        // copia en gris desenfocada (5 muestras) + puntos en screen + contrast(20), en multiply
        const r = size / 5;
        const o1 = h.pageDeltaToUv(vec2(r, 0));
        const o2 = h.pageDeltaToUv(vec2(0, r));
        const g = lum(sample(h.uv).rgb).mul(2).add(lum(sample(h.uv.add(o1)).rgb)).add(lum(sample(h.uv.sub(o1)).rgb)).add(lum(sample(h.uv.add(o2)).rgb)).add(lum(sample(h.uv.sub(o2)).rgb)).div(6);
        const dots = clamp(d.sub(size * 0.28).div(size * (0.62 - 0.28)), 0, 1);
        const scr = float(1).sub(float(1).sub(g).mul(float(1).sub(dots)));
        const hc = clamp(scr.sub(0.5).mul(20).add(0.5), 0, 1);
        return vec4(color.rgb.mul(mix(float(1), hc, op)), color.a);
      }
      const R = size * Math.SQRT1_2;
      const m = float(1).sub(smoothstep(R * 0.28, R * 0.31, d));
      return vec4(color.rgb.mul(mix(vec3(1), hex(params.color || '#111111'), m.mul(op))), color.a);
    },
  },
};

