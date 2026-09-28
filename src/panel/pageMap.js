// Conversión pantalla <-> coordenadas de página de una escena del preview.
// En vez de recomponer a mano la cadena de transforms (escala del preview, cámara, transición
// de escena, zoom), se meten tres sondas de tamaño 0 en el .cm-page y se mide dónde caen:
// eso da la transformación afín exacta vigente en este cuadro, con todo incluido.

export function scenePage(frame, index) {
  if (!frame || index < 0) return null;
  const el = frame.querySelectorAll(':scope > .cm-scene')[index];
  if (!el || el.style.display === 'none') return null;
  return el.querySelector(':scope > .cm-cam > .cm-page') || el.querySelector('.cm-page');
}

export function pageMapping(page) {
  if (!page) return null;
  const S = 1000;
  const probes = [
    [0, 0],
    [S, 0],
    [0, S],
  ].map(([x, y]) => {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;padding:0;border:0;margin:0;pointer-events:none;visibility:hidden`;
    page.append(d);
    return d;
  });
  const q = probes.map((d) => {
    const r = d.getBoundingClientRect();
    return [r.left, r.top];
  });
  for (const d of probes) d.remove();
  const ax = (q[1][0] - q[0][0]) / S;
  const ay = (q[1][1] - q[0][1]) / S;
  const bx = (q[2][0] - q[0][0]) / S;
  const by = (q[2][1] - q[0][1]) / S;
  const det = ax * by - bx * ay;
  if (!det) return null;
  return {
    toScreen: ([x, y]) => [q[0][0] + x * ax + y * bx, q[0][1] + x * ay + y * by],
    toPage: (cx, cy) => {
      const dx = cx - q[0][0];
      const dy = cy - q[0][1];
      return [(dx * by - bx * dy) / det, (ax * dy - ay * dx) / det];
    },
    scale: Math.hypot(ax, ay),
  };
}
