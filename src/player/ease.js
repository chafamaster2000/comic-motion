// Curvas de Motion evaluadas como funciones puras de p ∈ [0,1]: el render es buscable por cuadro.
import {
  spring,
  cubicBezier,
  easeIn,
  easeOut,
  easeInOut,
  backIn,
  backOut,
  backInOut,
  anticipate,
  circIn,
  circOut,
  circInOut,
  steps,
  mix,
  clamp,
} from 'motion';

const NAMED = {
  linear: (p) => p,
  easeIn,
  easeOut,
  easeInOut,
  backIn,
  backOut,
  backInOut,
  anticipate,
  circIn,
  circOut,
  circInOut,
};

export const EASES = [...Object.keys(NAMED), 'spring', 'springSoft', 'springHard', 'steps'];

const SPRINGS = {
  spring: { stiffness: 260, damping: 14 },
  springSoft: { stiffness: 120, damping: 16 },
  springHard: { stiffness: 520, damping: 18 },
};

const cache = new Map();

// spec: 'easeOut' | 'spring' | 'steps:6' | [x1,y1,x2,y2] | {type:'spring', stiffness, damping, mass}
// durationSec permite que un spring se resuelva en el tiempo real del clip.
export function easing(spec, durationSec = 1) {
  if (!spec) return easeInOut;
  if (Array.isArray(spec)) return cubicBezier(...spec);
  if (typeof spec === 'string') {
    if (NAMED[spec]) return NAMED[spec];
    if (spec.startsWith('steps')) {
      const n = parseInt(spec.split(':')[1] || '6', 10);
      return steps(n, 'end');
    }
    if (SPRINGS[spec]) return springEase(SPRINGS[spec], durationSec);
  }
  if (typeof spec === 'object' && spec.type === 'spring') return springEase(spec, durationSec);
  return easeInOut;
}

function springEase(opts, durationSec) {
  const key = JSON.stringify(opts) + '@' + durationSec;
  if (cache.has(key)) return cache.get(key);
  const gen = spring({ keyframes: [0, 1], stiffness: opts.stiffness, damping: opts.damping, mass: opts.mass || 1 });
  const ms = durationSec * 1000;
  const fn = (p) => (p >= 1 ? 1 : gen.next(clamp(0, 1, p) * ms).value);
  cache.set(key, fn);
  return fn;
}

// Progreso local 0..1 de un tramo [start, start+dur] en el instante t.
export function progress(t, start, dur) {
  if (dur <= 0) return t >= start ? 1 : 0;
  return clamp(0, 1, (t - start) / dur);
}

// Interpola entre keyframes [{at, ...valores}] (at en segundos locales). Cada keyframe
// puede traer su propio ease para el tramo que llega a él.
export function keyframes(frames, t, defaultEase = 'easeInOut') {
  if (!frames.length) return {};
  if (t <= frames[0].at) return frames[0];
  const last = frames[frames.length - 1];
  if (t >= last.at) return last;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (t <= b.at) {
      const span = b.at - a.at;
      const e = easing(b.ease || defaultEase, span)(progress(t, a.at, span));
      const out = {};
      for (const k of Object.keys(b)) {
        if (k === 'at' || k === 'ease') continue;
        out[k] = typeof b[k] === 'number' && typeof a[k] === 'number' ? mix(a[k], b[k], e) : e < 0.5 ? a[k] ?? b[k] : b[k];
      }
      for (const k of Object.keys(a)) if (!(k in out) && k !== 'at' && k !== 'ease') out[k] = a[k];
      return out;
    }
  }
  return last;
}

export { mix, clamp };
