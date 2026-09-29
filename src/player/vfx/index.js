// Catálogo de presets VFX built-in (kind 'vfx'). Contrato en references/scene-format.md, sección "VFX".
import { PARTICLES } from './particles.js';
import { DISTORT } from './distort.js';
import { SCREEN } from './screen.js';
import { FOG } from './fog.js';

export const VFX = [...PARTICLES, ...FOG, ...DISTORT, ...SCREEN];

// Qué necesita un clip VFX de su viñeta: 'full' (la dibuja three entera) u 'overlay' (canvas encima del DOM).
export function vfxNeeds(def, params) {
  if (!def || def.kind !== 'vfx') return null;
  if (def.distort || def.post) return 'full';
  const layer = params?.layer ?? def.params?.find((p) => p.key === 'layer')?.default ?? 'front';
  return layer === 'front' ? 'overlay' : 'full';
}
