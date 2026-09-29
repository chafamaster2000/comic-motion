// Tensión: dolly zoom (vértigo) sobre el personaje y un leve dutch que entra despacio.
import { clip, move3d } from './common.js';

export default {
  id: 'tension',
  label: 'Tensión',
  mood: 'tenso / inquietante',
  description: 'dollyZoom (move3d) a @hero o --target + dutch de -6° que entra en 1.2 s',
  expand(ctx) {
    const { T0, D } = ctx;
    const target = ctx.target || '@hero';
    return {
      summary: `tension: dolly zoom a ${target} + dutch`,
      clips: [move3d('cam', 'Tensión (dolly zoom)', T0, D, { move: 'dollyZoom', target, amount: 0.35, ease: 'easeInOut' }), clip('dutch', 'camera', 'Dutch', 'dutch', T0, D, { angle: -6, inTime: Math.min(1.2, D / 2), ease: 'easeInOut' })],
    };
  },
};
