// Diálogo: la cámara se acerca suave al que habla y queda respirando; los textos entran solos en orden
// de lectura (autoTiming).
import { move3d } from './common.js';

export default {
  id: 'dialogue',
  label: 'Diálogo',
  mood: 'íntimo / conversación',
  description: 'push-in suave (move3d) a @hero o --target, respiración de cámara, autoTiming de textos',
  expand(ctx) {
    const { g, T0, D } = ctx;
    const target = ctx.target || '@hero';
    const push = Math.min(D, Math.max(1.5, D * 0.6));
    // un solo clip encadenado (shots): acercamiento y después respiración, sin saltos entre tramos
    const shots = [{ at: 0, dur: +push.toFixed(3), move: 'pushIn', amount: 0.25, ease: 'easeInOut' }];
    if (D - push > 0.3) shots.push({ at: +push.toFixed(3), move: 'breathe', amount: 0.2, ease: 'easeInOut' });
    const clips = [move3d('cam', 'Diálogo (push-in + respiración)', T0, D, { move: 'pushIn', target, amount: 0.25, ease: 'easeInOut', shots })];
    return { summary: `dialogue: push-in a ${target}${shots.length > 1 ? ' + respiración' : ''}, textos con autoTiming`, clips, panel: { autoTiming: true } };
  },
};
