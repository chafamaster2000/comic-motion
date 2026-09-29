// Revelación: travelling lateral que descubre la viñeta; los textos con autoTiming.
import { move3d } from './common.js';

export default {
  id: 'reveal',
  label: 'Revelación (truck)',
  mood: 'descubrir / sorpresa tranquila',
  description: 'truck lateral (move3d, --direction left|right) sobre @bg-main o --target, textos con autoTiming',
  expand(ctx) {
    const { g, T0, D } = ctx;
    const target = ctx.target || (g.ref('@bg-main') ? '@bg-main' : null);
    const direction = ctx.opts.direction || 'right';
    return { summary: `reveal: truck hacia ${direction}`, clips: [move3d('cam', 'Revelación (truck)', T0, D, { move: 'truck', target, amount: 0.4, direction, ease: 'easeInOut' })], panel: { autoTiming: true } };
  },
};
