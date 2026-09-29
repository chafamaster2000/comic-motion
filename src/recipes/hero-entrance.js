// Entrada del héroe: el personaje entra en z (slam desde la cámara), y en el impacto sacudida, flash y
// onomatopeya donde menos pisa textos y personajes, cerca del héroe. La cámara se acerca un poco después del golpe.
import { clip, move3d, onoSpot, round } from './common.js';

export default {
  id: 'hero-entrance',
  label: 'Entrada del héroe',
  mood: 'acción / presentación',
  description: 'personaje (@hero o --target) entra con slam en z; en el impacto shake + flash + ono; push-in corto',
  expand(ctx) {
    const { g, T0, D } = ctx;
    const ref = ctx.target || '@hero';
    const hero = g.ref(ref);
    if (!hero) throw new Error(`hero-entrance: "${ref}" no resuelve a ninguna capa (mirá comic tags)`);
    const slam = 0.35;
    const ti = T0 + slam;
    const box = g.box(hero);
    const size = Math.round(Math.min(320, Math.max(140, Math.min(box[2], box[3]) * 0.3)));
    const clips = [
      clip('golpe', 'camera', 'Impacto (shake)', 'shake', ti, Math.min(0.45, D), { intensity: 20, rate: 16 }),
      clip('flash', 'fx', 'Flash', 'flash', Math.max(0, ti - 0.03), 0.3, { max: 0.6, peak: 0.1 }),
      clip('ono', 'ono', ctx.opts.text || '¡BAM!', 'ono', ti, Math.min(1.4, D - slam), { text: ctx.opts.text || '¡BAM!', at: onoSpot(g, box, size), size, rotate: -10, anim: 'slam' }),
    ];
    if (ctx.replaceCamera || !ctx.hasViewCamera) clips.push(move3d('cam', 'Tras el impacto (push-in)', ti, Math.max(0.5, D - slam), { move: 'pushIn', target: ref, amount: 0.2, ease: 'easeOut' }));
    const layers = { [hero.id]: { at: round(T0 - ctx.panelStart), enter: { preset: 'slam', duration: slam, ease: 'springHard' } } };
    return { summary: `hero-entrance: ${hero.id} entra con slam a ${round(T0, 2)}s, impacto a ${round(ti, 2)}s (shake + flash + ono)`, clips, layers };
  },
};
