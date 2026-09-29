// Plano de ubicación: la cámara se abre despacio mostrando el lugar, el fondo deriva apenas y los textos
// entran con pop en orden de lectura cuando la cámara ya se asentó.
import { move3d, readingTimes, round } from './common.js';

export default {
  id: 'establishing',
  label: 'Plano de ubicación',
  mood: 'épico / abrir escena',
  description: 'pull-out lento (move3d) hacia @bg-main, deriva suave del fondo, textos con pop en orden de lectura',
  expand(ctx) {
    const { g, T0, D } = ctx;
    const target = ctx.target || (g.ref('@bg-main') ? '@bg-main' : null);
    const clips = [move3d('cam', 'Ubicación (pull-out)', T0, D, { move: 'pullOut', target, amount: 0.4, ease: 'easeInOut' })];
    const layers = {};
    const notes = [];
    // deriva del fondo solo si no rompe nada: un único fondo local, sin divisores ni personajes recortados contra él
    const bg = g.ref('@bg-main');
    const localBgs = g.layers.filter((l) => l.role === 'background' && !l.global);
    const risky = !bg || localBgs.length !== 1 || g.layers.some((l) => l.role === 'divider' || l.clipTo === bg.id);
    if (!risky) layers[bg.id] = { motion: { dx: round(-0.012 * bg.w, 0), scale: 1.03, ease: 'easeInOut' } };
    else if (bg) notes.push('sin deriva del fondo: la viñeta tiene cortes/divisores que se desalinearían');
    for (const { layer, at } of readingTimes(g, T0 + Math.min(1.2, D * 0.3), T0 + D * 0.8)) layers[layer.id] = { at: round(at - ctx.panelStart), enter: { preset: 'pop', duration: 0.35 } };
    return { summary: `establishing: pull-out lento${risky ? '' : ' + deriva del fondo'} y ${g.texts.length} texto(s) en orden de lectura`, clips, layers, notes };
  },
};
