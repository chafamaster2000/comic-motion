// Params y utilidades comunes de los presets VFX (sin three: este módulo también lo lee Node).
export const LAYERS = ['back', 'mid', 'front'];

// Params comunes. `layer` solo para los que dibujan geometría; `anchor` para los que nacen en un punto.
export function common({ layer = 'mid', anchor = false, style = false } = {}) {
  const out = [{ key: 'target', label: 'Viñeta (clip id; vacío = la primera de la escena)', type: 'clipRef', default: null }];
  if (anchor) out.push({ key: 'anchor', label: 'Punto [x,y] en la página (vacío = centro de la viñeta)', type: 'anchor', default: null });
  if (layer) out.push({ key: 'layer', label: 'Capa', type: 'select', options: LAYERS, default: layer });
  if (style) out.push({ key: 'style', label: 'Estilo', type: 'select', options: ['glow', 'ink'], default: 'glow' });
  out.push(
    { key: 'intensity', label: 'Intensidad', type: 'number', min: 0, max: 3, step: 0.05, default: 1 },
    { key: 'stepFps', label: 'Cuadros/s del efecto (0 = continuo, 12 = de a dos)', type: 'number', min: 0, max: 30, step: 1, default: 0 },
  );
  return out;
}

// Rect de la viñeta destino y ancla por defecto (centro).
export function targetInfo(ctx) {
  const rect = ctx.panelRect(ctx.gpu.target) || [0, 0, ctx.stage.w, ctx.stage.h];
  const anchor = ctx.params.anchor || [rect[0] + rect[2] / 2, rect[1] + rect[3] / 2];
  return { rect, anchor };
}

// Envolvente de entrada/salida (0..1) del clip en t.
export function envelope(t, duration, fadeIn = 0.2, fadeOut = 0.3) {
  const a = fadeIn > 0 ? Math.min(1, Math.max(0, t / fadeIn)) : 1;
  const b = fadeOut > 0 ? Math.min(1, Math.max(0, (duration - t) / fadeOut)) : 1;
  return Math.min(a, b);
}
