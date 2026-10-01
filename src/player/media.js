// Geometría de medios compartida por la viñeta DOM y la viñeta GPU (three).
// Una sola fuente de números: si cambia acá, cambian las dos.
import { easing, progress, mix, clamp } from './ease.js';

// cover + foco + zoom dentro de una caja de boxW×boxH (px de la caja interior de la viñeta).
// Devuelve dónde queda el asset ENTERO: { left, top, W, H, k } (k = px de caja por px de asset).
export function mediaLayout(asset, crop, boxW, boxH, zoom, fx, fy) {
  const [cx, cy, cw, ch] = crop || [0, 0, asset.w, asset.h];
  const k = Math.max(boxW / cw, boxH / ch) * zoom;
  let left = boxW / 2 - (cx + fx * cw) * k;
  let top = boxH / 2 - (cy + fy * ch) * k;
  // no dejar ver fuera del recorte
  left = clamp(boxW - (cx + cw) * k, -cx * k, left);
  top = clamp(boxH - (cy + ch) * k, -cy * k, top);
  return { left, top, W: asset.w * k, H: asset.h * k, k };
}

// Estado de cámara interna de la viñeta en el instante t (ken burns + empuje de profundidad).
export function panelView(p, asset, duration, t) {
  const focus = p.focus || asset?.focus || [0.5, 0.5];
  const kb = p.kenBurns;
  let zoom = 1;
  let fx = focus[0];
  let fy = focus[1];
  if (kb) {
    const e = easing(kb.ease || 'easeInOut', duration)(progress(t, 0, duration));
    zoom = mix(kb.from?.zoom ?? 1, kb.to?.zoom ?? 1.12, e);
    fx = mix(kb.from?.fx ?? fx, kb.to?.fx ?? fx, e);
    fy = mix(kb.from?.fy ?? fy, kb.to?.fy ?? fy, e);
  }
  const dp = (p.depth || 0) * easing('easeInOut', duration)(progress(t, 0, duration));
  return { zoom, fx, fy, dp };
}

// Layout de una capa de profundidad `depth` (0 = fondo fijo a la página, 1.1 = recorte del personaje).
export function layerLayout(asset, crop, boxW, boxH, view, depth) {
  return mediaLayout(asset, crop, boxW, boxH, view.zoom * (1 + view.dp * depth), view.fx, view.fy - (depth > 1 ? view.dp * 0.15 : 0));
}

// Profundidad de las capas de VFX (coherente con las capas del preset panel).
export const VFX_LAYER_DEPTH = { back: 0, mid: 0.5, front: 1.25 };

// Espera a que el cuadro de un <video> recién buscado (seek) esté PRESENTADO, es decir listo para copiarse a
// una textura GPU (copyExternalImageToTexture / texImage2D). `seeked` solo dice que el decoder llegó; el cuadro
// puede llegar al compositor un instante después. requestVideoFrameCallback lo garantiza. Hay que llamarla
// ANTES de que termine el seek (en la misma tarea que asigna currentTime), si no el callback no llega.
// Sin rVFC (o si no llega en `timeoutMs`) el player cae a un rAF después de `seeked`, como antes.
export function presentedFrame(video, timeoutMs = 250) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  let id = 0;
  const p = new Promise((res) => {
    id = video.requestVideoFrameCallback((_now, meta) => res({ via: 'rvfc', mediaTime: meta?.mediaTime }));
    setTimeout(() => res({ via: 'timeout' }), timeoutMs);
  });
  p.cancel = () => video.cancelVideoFrameCallback?.(id);
  return p;
}
