// Golpe: sacudida, flash, líneas de velocidad y un estallido de chispas en el punto de impacto
// (centro de --target o de @hero). No toca la cámara principal.
import { clip, center } from './common.js';

export default {
  id: 'impact',
  label: 'Golpe',
  mood: 'acción / impacto',
  description: 'en --at: shake + flash + speedLines + burst (vfx) anclado en --target o @hero',
  expand(ctx) {
    const { g, T0, D } = ctx;
    const ref = ctx.target || '@hero';
    const l = g.ref(ref);
    const anchor = l ? center(g.box(l)) : null;
    const clips = [
      clip('golpe', 'camera', 'Golpe (shake)', 'shake', T0, Math.min(0.5, D), { intensity: 22, rate: 16 }),
      clip('flash', 'fx', 'Flash', 'flash', T0, Math.min(0.25, D), { max: 0.7, peak: 0.1 }),
      clip('vel', 'fx', 'Líneas de velocidad', 'speedLines', T0, Math.min(1.5, D), { color: '#ffffff', opacity: 0.35, clearCenter: 0.45, count: 40 }),
    ];
    if (g.clip) clips.push(clip('chispas', 'vfx', 'Estallido', 'burst', T0, Math.min(1.2, D), { target: g.clip.id, anchor, layer: 'front', count: 180 }));
    return { summary: `impact: golpe a ${+T0.toFixed(2)}s en ${l ? l.id : 'el centro'}`, clips };
  },
};
