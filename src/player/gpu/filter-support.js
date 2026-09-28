// Qué filtros tienen versión GPU (TSL). Módulo sin three: lo usa también `comic check` en Node.
export const GPU_FILTERS = ['css', 'posterize', 'chroma', 'paper', 'halftone'];

// Parsea un `filter:` CSS a una lista de operaciones soportadas. Devuelve { ops, unsupported: [...] }.
export function parseCssFilter(value) {
  const ops = [];
  const unsupported = [];
  const re = /([a-z-]+)\(([^)]*)\)/gi;
  let m;
  while ((m = re.exec(String(value || '')))) {
    const fn = m[1].toLowerCase();
    let raw = m[2].trim();
    let v = parseFloat(raw);
    if (/%$/.test(raw)) v /= 100;
    if (fn === 'hue-rotate') {
      v = parseFloat(raw);
      if (/rad$/.test(raw)) v = (v * 180) / Math.PI;
      else if (/turn$/.test(raw)) v *= 360;
    }
    if (['brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'invert', 'hue-rotate', 'opacity'].includes(fn)) ops.push([fn, Number.isFinite(v) ? v : 1]);
    else unsupported.push(fn);
  }
  return { ops, unsupported };
}


// Filtros (o funciones CSS) de una viñeta que no tienen versión GPU.
export function unsupportedGpuFilters(filters) {
  const out = [];
  for (const f of filters || []) {
    if (!GPU_FILTERS.includes(f.preset)) out.push(f.preset);
    else if (f.preset === 'css') for (const u of parseCssFilter(f.value ?? 'contrast(1.2) saturate(1.3)').unsupported) out.push('css ' + u + '()');
  }
  return out;
}
