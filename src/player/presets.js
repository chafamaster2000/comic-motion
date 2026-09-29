// Presets built-in. Contrato (igual para efectos custom en <proyecto>/effects/*.js):
//   clip:       { id, kind: 'camera'|'panel'|'fx'|'bubble'|'ono', label, params: [schema], build(ctx) -> { update(t) } }
//   transición: { id, kind: 'transition', label, params, apply({ inEl, outEl, overlay, p, params, ctx }) }
//   filtro:     { id, kind: 'filter', label, params, build(ctx) -> { css?, update?(t) } }
// Todo es función del tiempo local t (segundos): nada de relojes ni Math.random sueltos.
import { easing, progress, keyframes, mix, clamp } from './ease.js';
import { mediaLayout, panelView, layerLayout } from './media.js';
import { VFX } from './vfx/index.js';
import { resolveLayers, layerState, orbitAt } from './layers.js';
import { move3d } from './camera3d.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, style) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (style) Object.assign(e.style, style);
  return e;
};
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// ---------- entrada / salida compartida ----------
export const ENTERS = ['none', 'fade', 'pop', 'scale', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'wipeRight', 'wipeDown', 'slam', 'drop'];

function inOut(t, duration, enter, exit) {
  const out = { opacity: 1, transform: '', clipPath: '' };
  const apply = (spec, p, dir) => {
    if (!spec || spec.preset === 'none') return;
    const e = easing(spec.ease || (dir === 'in' ? defaultEnterEase(spec.preset) : 'easeIn'), spec.duration || 0.4)(dir === 'in' ? p : 1 - p);
    const k = dir === 'in' ? e : e; // e: 0 = oculto, 1 = en su lugar
    switch (spec.preset) {
      case 'fade':
        out.opacity *= clamp(0, 1, k);
        break;
      case 'pop':
        out.opacity *= clamp(0, 1, k * 3);
        out.transform += ` scale(${Math.max(0, k)})`;
        break;
      case 'scale':
        out.opacity *= clamp(0, 1, k);
        out.transform += ` scale(${mix(0.6, 1, k)})`;
        break;
      case 'slam':
        out.opacity *= clamp(0, 1, k * 4);
        out.transform += ` scale(${mix(3, 1, k)})`;
        break;
      case 'drop':
        out.opacity *= clamp(0, 1, k * 3);
        out.transform += ` translateY(${mix(-120, 0, k)}%)`;
        break;
      case 'slideLeft':
        out.transform += ` translateX(${mix(110, 0, k)}%)`;
        break;
      case 'slideRight':
        out.transform += ` translateX(${mix(-110, 0, k)}%)`;
        break;
      case 'slideUp':
        out.transform += ` translateY(${mix(110, 0, k)}%)`;
        break;
      case 'slideDown':
        out.transform += ` translateY(${mix(-110, 0, k)}%)`;
        break;
      case 'wipeRight':
        out.clipPath = `inset(0 ${mix(100, 0, clamp(0, 1, k))}% 0 0)`;
        break;
      case 'wipeDown':
        out.clipPath = `inset(0 0 ${mix(100, 0, clamp(0, 1, k))}% 0)`;
        break;
    }
  };
  if (enter && enter.preset !== 'none') {
    const d = enter.duration ?? 0.4;
    if (t < d) apply(enter, progress(t, 0, d), 'in');
  }
  if (exit && exit.preset !== 'none') {
    const d = exit.duration ?? 0.3;
    if (t > duration - d) apply(exit, progress(t, duration - d, d), 'out');
  }
  return out;
}

function defaultEnterEase(preset) {
  return { pop: 'spring', slam: 'springHard', drop: 'spring', scale: 'backOut' }[preset] || 'easeOut';
}

const ENTER_PARAM = { key: 'enter', label: 'Entrada', type: 'motion', options: ENTERS };
const EXIT_PARAM = { key: 'exit', label: 'Salida', type: 'motion', options: ENTERS };

// ---------- geometría de medios (cover + foco + zoom) ----------
// La matemática vive en media.js y la comparte la viñeta GPU.
function applyLayout(img, L) {
  img.style.width = L.W + 'px';
  img.style.height = L.H + 'px';
  img.style.transform = `translate(${L.left}px, ${L.top}px)`;
}

// ---------- CÁMARA ----------
const camera = {
  id: 'camera',
  kind: 'camera',
  label: 'Recorrido de cámara',
  params: [
    { key: 'keys', label: 'Keyframes [{at, panel|cx,cy,w, pad, rotate, ease}]', type: 'json', default: [{ at: 0, panel: null }] },
    { key: 'ease', label: 'Ease por defecto', type: 'ease', default: 'easeInOut' },
  ],
  build(ctx) {
    const keys = () =>
      (ctx.params.keys || []).map((k) => {
        const base = { at: k.at || 0, rotate: k.rotate || 0, ease: k.ease };
        if (k.panel || (k.cx == null && k.w == null)) {
          const r = k.panel ? ctx.panelRect(k.panel) : null;
          const rect = r || [0, 0, ctx.stage.w, ctx.stage.h];
          const pad = k.pad ?? 40;
          const aspect = ctx.frame.w / ctx.frame.h;
          const w = Math.max(rect[2] + pad * 2, (rect[3] + pad * 2) * aspect);
          return { ...base, cx: rect[0] + rect[2] / 2, cy: rect[1] + rect[3] / 2, w: w / (k.zoom || 1) };
        }
        return { ...base, cx: k.cx, cy: k.cy, w: k.w };
      });
    let resolved = null;
    return {
      update(t) {
        resolved = resolved || keys();
        return { view: keyframes(resolved, t, ctx.params.ease || 'easeInOut') };
      },
    };
  },
};

const shake = {
  id: 'shake',
  kind: 'camera',
  label: 'Sacudida',
  params: [
    { key: 'intensity', label: 'Intensidad (px)', type: 'number', min: 0, max: 80, default: 18 },
    { key: 'rate', label: 'Golpes por segundo', type: 'number', min: 2, max: 30, default: 16 },
    { key: 'decay', label: 'Se apaga', type: 'bool', default: true },
    { key: 'rotate', label: 'Rotación (°)', type: 'number', min: 0, max: 10, default: 1.5 },
  ],
  build(ctx) {
    const rnd = (i, j) => ctx.hashRand(i * 7919 + j) * 2 - 1;
    return {
      update(t) {
        const { intensity = 18, rate = 16, decay = true, rotate = 1.5 } = ctx.params;
        const step = Math.floor(t * rate);
        const env = decay ? Math.pow(1 - progress(t, 0, ctx.duration), 2) : 1;
        return { dx: rnd(step, 1) * intensity * env, dy: rnd(step, 2) * intensity * env, drot: rnd(step, 3) * rotate * env };
      },
    };
  },
};

const dutch = {
  id: 'dutch',
  kind: 'camera',
  label: 'Inclinación holandesa',
  params: [
    { key: 'angle', label: 'Ángulo (°)', type: 'number', min: -25, max: 25, default: -8 },
    { key: 'ease', label: 'Ease', type: 'ease', default: 'easeOut' },
    { key: 'inTime', label: 'Tiempo de entrada (s)', type: 'number', min: 0, max: 5, step: 0.05, default: 0.6 },
  ],
  build(ctx) {
    return {
      update(t) {
        const e = easing(ctx.params.ease, ctx.params.inTime)(progress(t, 0, ctx.params.inTime ?? 0.6));
        return { drot: (ctx.params.angle ?? -8) * e };
      },
    };
  },
};

const dolly = {
  id: 'dolly',
  kind: 'camera',
  label: 'Empuje / dolly zoom',
  params: [
    { key: 'from', label: 'Zoom inicial', type: 'number', min: 0.5, max: 3, step: 0.01, default: 1 },
    { key: 'to', label: 'Zoom final', type: 'number', min: 0.5, max: 3, step: 0.01, default: 1.15 },
    { key: 'ease', label: 'Ease', type: 'ease', default: 'easeInOut' },
  ],
  build(ctx) {
    return {
      update(t) {
        const e = easing(ctx.params.ease, ctx.duration)(progress(t, 0, ctx.duration));
        return { dzoom: mix(ctx.params.from ?? 1, ctx.params.to ?? 1.15, e) };
      },
    };
  },
};

// ---------- FILTROS (por viñeta) ----------
const halftone = {
  id: 'halftone',
  kind: 'filter',
  label: 'Tramado halftone',
  params: [
    { key: 'size', label: 'Tamaño de punto (px)', type: 'number', min: 3, max: 40, default: 10 },
    { key: 'opacity', label: 'Opacidad', type: 'number', min: 0, max: 1, step: 0.05, default: 0.45 },
    { key: 'mode', label: 'Modo', type: 'select', options: ['print', 'dots'], default: 'print' },
    { key: 'color', label: 'Color', type: 'color', default: '#111111' },
  ],
  build(ctx) {
    const { size = 10, opacity = 0.45, mode = 'print', color = '#111111' } = ctx.params;
    if (mode === 'print' && ctx.cloneMedia) {
      // halftone real: la luminancia define el tamaño del punto (truco contrast + screen)
      const wrap = el('div', 'cm-fx-halftone', { position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff', filter: 'contrast(20)', mixBlendMode: 'multiply', opacity, pointerEvents: 'none' });
      const copy = ctx.cloneMedia();
      copy.style.filter = `grayscale(1) blur(${Math.max(1, size / 5)}px)`;
      const dots = el('div', null, {
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(circle at center, #000 ${size * 0.28}px, #fff ${size * 0.62}px)`,
        backgroundSize: `${size}px ${size}px`,
        mixBlendMode: 'screen',
      });
      wrap.append(copy, dots);
      ctx.overlay(wrap);
      return {};
    }
    const dots = el('div', 'cm-fx-halftone', {
      position: 'absolute',
      inset: 0,
      backgroundImage: `radial-gradient(${color} 28%, transparent 31%)`,
      backgroundSize: `${size}px ${size}px`,
      mixBlendMode: 'multiply',
      opacity,
      pointerEvents: 'none',
    });
    ctx.overlay(dots);
    return {};
  },
};

const ink = {
  id: 'ink',
  kind: 'filter',
  label: 'Contorno de tinta',
  params: [
    { key: 'strength', label: 'Fuerza', type: 'number', min: 1, max: 12, step: 0.5, default: 5 },
    { key: 'threshold', label: 'Umbral', type: 'number', min: 0.05, max: 0.9, step: 0.05, default: 0.35 },
  ],
  build(ctx) {
    const { strength = 5, threshold = 0.35 } = ctx.params;
    const id = ctx.uid('ink');
    const f = svg('filter', { id, 'color-interpolation-filters': 'sRGB', x: '0', y: '0', width: '100%', height: '100%' });
    f.append(
      svg('feColorMatrix', { in: 'SourceGraphic', type: 'luminanceToAlpha', result: 'lum' }),
      svg('feColorMatrix', { in: 'SourceGraphic', type: 'matrix', values: '0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0', result: 'gray' }),
      svg('feConvolveMatrix', { in: 'gray', order: '3', kernelMatrix: `-1 -1 -1 -1 8 -1 -1 -1 -1`, divisor: '1', preserveAlpha: 'true', result: 'edges' }),
      Object.assign(svg('feComponentTransfer', { in: 'edges', result: 'lines' }), {}),
      svg('feBlend', { in: 'SourceGraphic', in2: 'lines', mode: 'multiply' }),
    );
    const ct = f.querySelector('feComponentTransfer');
    // bordes brillantes -> línea negra; resto blanco
    const table = (k) => {
      const n = 12;
      const vals = [];
      for (let i = 0; i < n; i++) vals.push(i / (n - 1) > threshold / k ? 0 : 1);
      return vals.join(' ');
    };
    for (const ch of ['feFuncR', 'feFuncG', 'feFuncB']) ct.append(svg(ch, { type: 'discrete', tableValues: table(strength / 5) }));
    ct.append(svg('feFuncA', { type: 'linear', slope: '0', intercept: '1' }));
    ctx.defs.append(f);
    return { css: `url(#${id})` };
  },
};

const posterize = {
  id: 'posterize',
  kind: 'filter',
  label: 'Colores planos',
  params: [
    { key: 'levels', label: 'Niveles', type: 'number', min: 2, max: 8, default: 4 },
    { key: 'saturate', label: 'Saturación', type: 'number', min: 0, max: 3, step: 0.1, default: 1.3 },
  ],
  build(ctx) {
    const { levels = 4, saturate = 1.3 } = ctx.params;
    const id = ctx.uid('post');
    const vals = Array.from({ length: levels }, (_, i) => (i / (levels - 1)).toFixed(3)).join(' ');
    const f = svg('filter', { id, 'color-interpolation-filters': 'sRGB' });
    const ct = svg('feComponentTransfer');
    for (const ch of ['feFuncR', 'feFuncG', 'feFuncB']) ct.append(svg(ch, { type: 'discrete', tableValues: vals }));
    f.append(ct);
    ctx.defs.append(f);
    return { css: `saturate(${saturate}) url(#${id})` };
  },
};

const paper = {
  id: 'paper',
  kind: 'filter',
  label: 'Papel envejecido',
  params: [
    { key: 'sepia', label: 'Sepia', type: 'number', min: 0, max: 1, step: 0.05, default: 0.35 },
    { key: 'grain', label: 'Grano', type: 'number', min: 0, max: 1, step: 0.05, default: 0.35 },
  ],
  build(ctx) {
    const { sepia = 0.35, grain = 0.35 } = ctx.params;
    const noise = `url("data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' seed='${ctx.seed % 1000}'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`,
    )}")`;
    ctx.overlay(el('div', 'cm-fx-paper', { position: 'absolute', inset: 0, backgroundImage: noise, mixBlendMode: 'multiply', opacity: grain, pointerEvents: 'none' }));
    ctx.overlay(el('div', null, { position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, transparent 55%, rgba(90,60,20,.35))', pointerEvents: 'none' }));
    return { css: `sepia(${sepia}) contrast(1.05)` };
  },
};

const chroma = {
  id: 'chroma',
  kind: 'filter',
  label: 'Aberración de color',
  params: [{ key: 'offset', label: 'Desplazamiento (px)', type: 'number', min: 0, max: 20, default: 3 }],
  build(ctx) {
    const o = ctx.params.offset ?? 3;
    const id = ctx.uid('chroma');
    const f = svg('filter', { id, 'color-interpolation-filters': 'sRGB' });
    f.innerHTML = `
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
      <feOffset in="r" dx="${o}" dy="0" result="r2"/>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
      <feOffset in="b" dx="${-o}" dy="0" result="b2"/>
      <feBlend in="r2" in2="g" mode="screen" result="rg"/>
      <feBlend in="rg" in2="b2" mode="screen"/>`;
    ctx.defs.append(f);
    return { css: `url(#${id})` };
  },
};

const cssFilter = {
  id: 'css',
  kind: 'filter',
  label: 'Filtro CSS libre',
  params: [{ key: 'value', label: 'filter:', type: 'text', default: 'contrast(1.2) saturate(1.3)' }],
  build(ctx) {
    return { css: ctx.params.value || '' };
  },
};

// ---------- VIÑETA ----------
const panel = {
  id: 'panel',
  kind: 'panel',
  label: 'Viñeta (imagen/video)',
  params: [
    { key: 'asset', label: 'Asset', type: 'asset' },
    { key: 'rect', label: 'Rect en la página [x,y,w,h]', type: 'json', default: null },
    { key: 'crop', label: 'Recorte del asset [x,y,w,h]', type: 'json', default: null },
    { key: 'focus', label: 'Foco [fx,fy] 0..1', type: 'json', default: null },
    { key: 'kenBurns', label: 'Ken Burns {from:{zoom,fx,fy}, to:{...}, ease}', type: 'json', default: null },
    { key: 'depth', label: 'Profundidad (usa el recorte del personaje)', type: 'number', min: 0, max: 0.3, step: 0.01, default: 0 },
    { key: 'depthLock', label: 'Zonas fijas con profundidad [[x,y,w,h],…] (px del asset: textos, carteles)', type: 'json', default: null },
    { key: 'border', label: 'Borde (px)', type: 'number', min: 0, max: 40, default: 8 },
    { key: 'borderColor', label: 'Color de borde', type: 'color', default: '#111111' },
    { key: 'radius', label: 'Radio', type: 'number', min: 0, max: 80, default: 0 },
    { key: 'tilt', label: 'Inclinación (°)', type: 'number', min: -20, max: 20, step: 0.5, default: 0 },
    { key: 'shadow', label: 'Sombra', type: 'bool', default: true },
    ENTER_PARAM,
    EXIT_PARAM,
    { key: 'filters', label: 'Filtros [{preset, ...params}]', type: 'filters', default: [] },
    { key: 'pixelated', label: 'Pixel art (escalado nítido)', type: 'bool', default: false },
    { key: 'videoIn', label: 'Video: segundo de entrada', type: 'number', min: 0, step: 0.04, default: 0 },
    { key: 'rate', label: 'Video: velocidad', type: 'number', min: 0.1, max: 4, step: 0.05, default: 1 },
    { key: 'loop', label: 'Video: loop', type: 'bool', default: false },
    { key: 'gpu', label: 'Dibujar con GPU (three) aunque no tenga VFX', type: 'bool', default: false },
    // viñeta por capas (asset type 'layers'): siempre GPU completa, planos 3D en perspectiva
    { key: 'layers', label: 'Capas: overrides por id {depth, role, hidden, at, dur, enter, exit, motion, clipTo}', type: 'layers', default: null },
    { key: 'depthScale', label: 'Capas: intensidad del 3D (0 = plano)', type: 'number', min: 0, max: 3, step: 0.05, default: 1 },
    { key: 'orbit', label: 'Capas: órbita de cámara {yaw, pitch} (°, de 0 a eso a lo largo del clip; from, ease)', type: 'orbit', default: null },
    { key: 'dof', label: 'Capas: desenfoque por distancia (0..1, o {amount, focus})', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
    { key: 'autoTiming', label: 'Capas: textos escalonados en orden de lectura (false = todo desde el inicio)', type: 'bool', default: true },
  ],
  build(ctx) {
    const p = ctx.params;
    const asset = ctx.asset(p.asset);
    const rect = p.rect || [0, 0, ctx.stage.w, ctx.stage.h];
    const [x, y, w, h] = rect;
    const box = el('div', 'cm-panel', {
      position: 'absolute',
      left: x + 'px',
      top: y + 'px',
      width: w + 'px',
      height: h + 'px',
      border: `${p.border ?? 8}px solid ${p.borderColor || '#111'}`,
      borderRadius: (p.radius || 0) + 'px',
      boxSizing: 'border-box',
      overflow: 'hidden',
      background: '#fff',
      boxShadow: p.shadow === false ? 'none' : '10px 12px 0 rgba(0,0,0,.28)',
      transformOrigin: '50% 50%',
    });
    const innerW = w - 2 * (p.border ?? 8);
    const innerH = h - 2 * (p.border ?? 8);
    const media = el('div', 'cm-media', { position: 'absolute', inset: 0, overflow: 'hidden', imageRendering: p.pixelated ? 'pixelated' : 'auto' });
    box.append(media);
    const layers = [];
    const makeMedia = (src) => {
      let m;
      if (asset?.type === 'video') {
        m = el('video', null, { position: 'absolute', left: 0, top: 0, maxWidth: 'none', transformOrigin: '0 0' });
        m.muted = true;
        m.playsInline = true;
        m.preload = 'auto';
        m.src = src;
        ctx.registerVideo(m, (t) => {
          const d = asset.duration || 0;
          let mt = (p.videoIn || 0) + t * (p.rate || 1);
          if (p.loop && d) mt = (p.videoIn || 0) + ((t * (p.rate || 1)) % Math.max(0.04, d - (p.videoIn || 0)));
          return d ? Math.min(mt, d - 0.04) : mt;
        });
      } else {
        m = el('img', null, { position: 'absolute', left: 0, top: 0, maxWidth: 'none', transformOrigin: '0 0' });
        m.decoding = 'sync';
        m.draggable = false;
        m.src = src;
        ctx.preload(m);
      }
      return m;
    };
    let lx = null;
    if (asset?.type === 'layers') {
      // viñeta por capas: la dibuja la GPU (gpu/layers.js). La preview compuesta queda como respaldo DOM.
      const base = makeMedia(ctx.fileUrl(asset.file));
      media.append(base);
      layers.push({ img: base, depth: 0, kind: 'base', src: base.src });
      const focus = p.focus || asset.focus || [0.5, 0.5];
      lx = {
        resolved: resolveLayers(asset, p, ctx.duration),
        params: p,
        rect,
        url: ctx.fileUrl,
        layout0: mediaLayout(asset, p.crop, innerW, innerH, 1, focus[0], focus[1]),
        layout: null,
        states: [],
        orbit: [0, 0],
      };
    } else if (!asset) {
      media.append(el('div', null, { position: 'absolute', inset: 0, background: 'repeating-linear-gradient(45deg,#eee 0 20px,#ddd 20px 40px)' }));
    } else {
      // con profundidad y fondo rellenado, el fondo va sin personajes: no quedan fantasmas
      const base = makeMedia(p.depth && asset.bgfill && asset.type !== 'video' ? ctx.fileUrl(asset.bgfill) : ctx.assetUrl(asset));
      media.append(base);
      // el fondo queda fijo a la página: lo que está pintado ahí (globos, carteles) no se desliza
      layers.push({ img: base, depth: 0, kind: 'base', src: base.src });
      if (p.depth && asset.cutout) {
        const fg = el('img', null, { position: 'absolute', left: 0, top: 0, maxWidth: 'none', transformOrigin: '0 0' });
        fg.src = ctx.fileUrl(asset.cutout);
        ctx.preload(fg);
        media.append(fg);
        layers.push({ img: fg, depth: 1.1, kind: 'fg', src: fg.src });
      }
      // zonas bloqueadas: la imagen original, fija a la página y por encima de todo
      if (p.depth && Array.isArray(p.depthLock) && p.depthLock.length) {
        const lock = makeMedia(ctx.assetUrl(asset));
        const rects = p.depthLock.map(([x, y, w, h]) => `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='white'/>`).join('');
        const m = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${asset.w}' height='${asset.h}' viewBox='0 0 ${asset.w} ${asset.h}' preserveAspectRatio='none'>${rects}</svg>`)}")`;
        Object.assign(lock.style, { maskImage: m, webkitMaskImage: m, maskSize: '100% 100%', webkitMaskSize: '100% 100%', maskRepeat: 'no-repeat', webkitMaskRepeat: 'no-repeat' });
        media.append(lock);
        layers.push({ img: lock, depth: 0, kind: 'lock', src: lock.src, rects: p.depthLock });
      }
    }
    // filtros: los que devuelven css van al contenedor, los que agregan capas usan overlay
    const filterCss = [];
    const overlays = [];
    for (const [i, spec] of (p.filters || []).entries()) {
      const def = ctx.presets[spec.preset];
      if (!def || def.kind !== 'filter') continue;
      const res = def.build({
        ...ctx,
        params: { ...defaultsOf(def), ...spec },
        overlay: (node) => {
          overlays.push(node);
          box.append(node);
        },
        cloneMedia: asset && asset.type !== 'video' ? () => {
          const c = makeMedia(ctx.assetUrl(asset));
          c.dataset.clone = '1';
          layers.push({ img: c, depth: 0, clone: true });
          return c;
        } : null,
        uid: (s) => ctx.uid(s + i),
      });
      if (res?.css) filterCss.push(res.css);
    }
    if (filterCss.length) media.style.filter = filterCss.join(' ');
    ctx.mount(box, 'page');
    // lo que necesita la viñeta GPU (src/player/gpu): mismas capas y mismos números
    const gpu = {
      asset,
      box,
      media,
      overlays,
      inner: [innerW, innerH],
      origin: [x + (p.border ?? 8), y + (p.border ?? 8)],
      layers: layers.filter((l) => !l.clone),
      filters: p.filters || [],
      crop: p.crop || null,
      pixelated: !!p.pixelated,
      view: null,
      layersMode: !!lx,
      lx,
    };
    return {
      gpu,
      update(t) {
        const view = panelView(p, asset, ctx.duration, t);
        gpu.view = view;
        if (lx) {
          // capas: layout del plano focal (cover + foco + ken burns), estado de cada capa y órbita
          const L = layerLayout(asset, p.crop, innerW, innerH, { ...view, dp: 0 }, 0);
          applyLayout(layers[0].img, L);
          lx.layout = L;
          lx.states = lx.resolved.map((r) => layerState(r, t, ctx.duration));
          lx.orbit = orbitAt(p.orbit, t, ctx.duration);
        } else if (asset) for (const l of layers) applyLayout(l.img, (l.layout = layerLayout(asset, p.crop, innerW, innerH, view, l.depth)));
        const io = inOut(t, ctx.duration, p.enter, p.exit);
        box.style.opacity = io.opacity;
        box.style.transform = `rotate(${p.tilt || 0}deg)` + io.transform;
        box.style.clipPath = io.clipPath;
      },
    };
  },
};

// ---------- GLOBOS ----------
function ellipsePath(cx, cy, rx, ry) {
  return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`;
}

const bubble = {
  id: 'bubble',
  kind: 'bubble',
  label: 'Globo de texto',
  params: [
    { key: 'text', label: 'Texto', type: 'textarea', default: '¡Hola!' },
    { key: 'shape', label: 'Tipo', type: 'select', options: ['speech', 'thought', 'shout', 'caption'], default: 'speech' },
    { key: 'box', label: 'Caja [x,y,w,h] en la página', type: 'json', default: [100, 100, 420, 200] },
    { key: 'tail', label: 'Cola apunta a [x,y] (o null)', type: 'json', default: null },
    { key: 'fontSize', label: 'Tamaño de letra', type: 'number', min: 12, max: 120, default: 38 },
    { key: 'font', label: 'Fuente', type: 'select', options: ['Comic Neue', 'Bangers'], default: 'Comic Neue' },
    { key: 'fill', label: 'Fondo', type: 'color', default: '#ffffff' },
    { key: 'color', label: 'Color de texto', type: 'color', default: '#111111' },
    { key: 'stroke', label: 'Borde (px)', type: 'number', min: 0, max: 16, default: 5 },
    { key: 'typewriter', label: 'Máquina de escribir (letras/s, 0 = no)', type: 'number', min: 0, max: 120, default: 0 },
    { ...ENTER_PARAM, default: { preset: 'pop', duration: 0.35 } },
    { ...EXIT_PARAM, default: { preset: 'fade', duration: 0.2 } },
  ],
  build(ctx) {
    const p = ctx.params;
    const [bx, by, bw, bh] = p.box || [100, 100, 420, 200];
    const tail = p.tail;
    const pad = 60;
    const minX = Math.min(bx, tail ? tail[0] : bx) - pad;
    const minY = Math.min(by, tail ? tail[1] : by) - pad;
    const maxX = Math.max(bx + bw, tail ? tail[0] : 0) + pad;
    const maxY = Math.max(by + bh, tail ? tail[1] : 0) + pad;
    const wrap = el('div', 'cm-bubble', { position: 'absolute', left: minX + 'px', top: minY + 'px', width: maxX - minX + 'px', height: maxY - minY + 'px', pointerEvents: 'none' });
    const s = svg('svg', { width: maxX - minX, height: maxY - minY, viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}` });
    s.style.position = 'absolute';
    s.style.left = '0';
    s.style.top = '0';
    s.style.overflow = 'visible';
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const rx = bw / 2;
    const ry = bh / 2;
    const stroke = p.stroke ?? 5;
    const shapes = [];
    const shape = p.shape || 'speech';
    const rand = ctx.rand;
    if (shape === 'caption') {
      shapes.push(svg('rect', { x: bx, y: by, width: bw, height: bh }));
    } else if (shape === 'thought') {
      const n = 11;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = Math.min(rx, ry) * (0.38 + rand() * 0.12);
        shapes.push(svg('circle', { cx: cx + Math.cos(a) * (rx - r * 0.55), cy: cy + Math.sin(a) * (ry - r * 0.55), r }));
      }
      shapes.push(svg('ellipse', { cx, cy, rx: rx * 0.82, ry: ry * 0.78 }));
      if (tail) {
        for (let i = 1; i <= 3; i++) {
          const k = 0.35 + i * 0.2;
          shapes.push(svg('circle', { cx: mix(cx, tail[0], k), cy: mix(cy, tail[1], k), r: Math.min(rx, ry) * (0.2 - i * 0.045) }));
        }
      }
    } else if (shape === 'shout') {
      const n = 22;
      let d = '';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const out = i % 2 === 0 ? 1.12 + rand() * 0.18 : 0.86 + rand() * 0.06;
        d += `${i ? 'L' : 'M'} ${cx + Math.cos(a) * rx * out} ${cy + Math.sin(a) * ry * out} `;
      }
      shapes.push(svg('path', { d: d + 'Z' }));
    } else {
      shapes.push(svg('path', { d: ellipsePath(cx, cy, rx, ry) }));
    }
    if (tail && shape !== 'thought' && shape !== 'caption') {
      const ang = Math.atan2(tail[1] - cy, tail[0] - cx);
      const perp = ang + Math.PI / 2;
      const baseW = Math.min(rx, ry) * 0.32;
      const bxp = cx + Math.cos(ang) * rx * 0.7;
      const byp = cy + Math.sin(ang) * ry * 0.7;
      const pts = [
        [bxp + Math.cos(perp) * baseW, byp + Math.sin(perp) * baseW],
        [tail[0], tail[1]],
        [bxp - Math.cos(perp) * baseW * 0.3, byp - Math.sin(perp) * baseW * 0.3],
      ];
      shapes.push(svg('path', { d: `M ${pts[0].join(' ')} Q ${mix(pts[0][0], tail[0], 0.6)} ${mix(pts[0][1], tail[1], 0.4)} ${pts[1].join(' ')} L ${pts[2].join(' ')} Z` }));
    }
    // trazo de todo primero, relleno encima: contorno unificado
    const g1 = svg('g', { fill: p.fill || '#fff', stroke: '#111', 'stroke-width': stroke * 2, 'stroke-linejoin': 'round' });
    const g2 = svg('g', { fill: p.fill || '#fff' });
    for (const sh of shapes) {
      g1.append(sh.cloneNode());
      g2.append(sh);
    }
    s.append(g1, g2);
    const txt = el('div', 'cm-bubble-text', {
      position: 'absolute',
      left: bx - minX + bw * 0.12 + 'px',
      top: by - minY + 'px',
      width: bw * 0.76 + 'px',
      height: bh + 'px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      fontFamily: `'${p.font || 'Comic Neue'}', 'Comic Neue', sans-serif`,
      fontWeight: 700,
      fontSize: (p.fontSize || 38) + 'px',
      lineHeight: 1.1,
      color: p.color || '#111',
      textTransform: shape === 'shout' ? 'uppercase' : 'none',
      whiteSpace: 'pre-wrap',
    });
    const shown = document.createElement('span');
    const hidden = document.createElement('span');
    hidden.style.color = 'transparent';
    txt.append(el('span', null, {}));
    txt.firstChild.append(shown, hidden);
    const text = String(p.text ?? '');
    shown.textContent = text;
    wrap.append(s, txt);
    wrap.style.transformOrigin = tail ? `${tail[0] - minX}px ${tail[1] - minY}px` : '50% 50%';
    ctx.mount(wrap, 'page');
    return {
      update(t) {
        const io = inOut(t, ctx.duration, p.enter, p.exit);
        wrap.style.opacity = io.opacity;
        wrap.style.transform = io.transform;
        wrap.style.clipPath = io.clipPath;
        if (p.typewriter > 0) {
          const start = p.enter?.duration ?? 0.3;
          const n = clamp(0, text.length, Math.floor((t - start) * p.typewriter));
          shown.textContent = text.slice(0, n);
          hidden.textContent = text.slice(n);
        }
      },
    };
  },
};

// ---------- ONOMATOPEYAS ----------
const ono = {
  id: 'ono',
  kind: 'ono',
  label: 'Onomatopeya',
  params: [
    { key: 'text', label: 'Texto', type: 'text', default: '¡BAM!' },
    { key: 'at', label: 'Centro [x,y] en la página', type: 'json', default: [960, 540] },
    { key: 'size', label: 'Tamaño', type: 'number', min: 20, max: 600, default: 200 },
    { key: 'rotate', label: 'Rotación (°)', type: 'number', min: -45, max: 45, default: -8 },
    { key: 'fill', label: 'Relleno', type: 'color', default: '#ffd400' },
    { key: 'fill2', label: 'Relleno 2 (degradé)', type: 'color', default: '#ff3b1f' },
    { key: 'stroke', label: 'Contorno', type: 'color', default: '#111111' },
    { key: 'strokeWidth', label: 'Grosor de contorno', type: 'number', min: 0, max: 40, default: 14 },
    { key: 'shadow', label: 'Sombra (px)', type: 'number', min: 0, max: 40, default: 10 },
    { key: 'anim', label: 'Animación', type: 'select', options: ['slam', 'pop', 'shake', 'stretch', 'none'], default: 'slam' },
    { key: 'jitter', label: 'Temblor continuo (px)', type: 'number', min: 0, max: 30, default: 3 },
    { key: 'font', label: 'Fuente', type: 'select', options: ['Bangers', 'Comic Neue'], default: 'Bangers' },
    { ...EXIT_PARAM, default: { preset: 'fade', duration: 0.2 } },
  ],
  build(ctx) {
    const p = ctx.params;
    const [x, y] = p.at || [960, 540];
    const wrap = el('div', 'cm-ono', { position: 'absolute', left: x + 'px', top: y + 'px', width: 0, height: 0, pointerEvents: 'none' });
    const t0 = el('div', null, {
      position: 'absolute',
      transform: 'translate(-50%,-50%)',
      whiteSpace: 'nowrap',
      fontFamily: `'${p.font || 'Bangers'}', Impact, sans-serif`,
      fontSize: (p.size || 200) + 'px',
      lineHeight: 1,
      letterSpacing: '0.02em',
    });
    const outline = t0.cloneNode();
    const fillEl = t0.cloneNode();
    outline.textContent = fillEl.textContent = p.text ?? '¡BAM!';
    const sw = p.strokeWidth ?? 14;
    Object.assign(outline.style, { color: p.stroke || '#111', WebkitTextStroke: `${sw * 2}px ${p.stroke || '#111'}`, textShadow: p.shadow ? `${p.shadow}px ${p.shadow}px 0 ${p.stroke || '#111'}` : 'none' });
    Object.assign(fillEl.style, {
      backgroundImage: `linear-gradient(180deg, ${p.fill || '#ffd400'} 35%, ${p.fill2 || p.fill || '#ff3b1f'})`,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
    });
    const inner = el('div', null, { position: 'absolute' });
    inner.append(outline, fillEl);
    wrap.append(inner);
    ctx.mount(wrap, 'page');
    return {
      update(t) {
        const anim = p.anim || 'slam';
        let scale = 1;
        let sx = 1;
        let op = 1;
        let jx = 0;
        let jy = 0;
        const d = 0.35;
        if (anim === 'slam') {
          const e = easing('springHard', 0.6)(progress(t, 0, 0.6));
          scale = mix(3.2, 1, e);
          op = clamp(0, 1, t / 0.08);
        } else if (anim === 'pop') {
          scale = easing('spring', 0.6)(progress(t, 0, 0.6));
        } else if (anim === 'stretch') {
          const e = easing('backOut', d)(progress(t, 0, d));
          sx = mix(0.3, 1.15, e) - 0.15 * progress(t, d, ctx.duration);
          op = clamp(0, 1, t / 0.1);
        } else if (anim === 'shake') {
          op = clamp(0, 1, t / 0.08);
        }
        const jit = anim === 'shake' ? Math.max(p.jitter || 0, 8) : p.jitter || 0;
        if (jit) {
          const step = Math.floor(t * 18);
          jx = (ctx.hashRand(step * 31 + 1) * 2 - 1) * jit;
          jy = (ctx.hashRand(step * 31 + 2) * 2 - 1) * jit;
        }
        const io = inOut(t, ctx.duration, null, p.exit);
        wrap.style.opacity = op * io.opacity;
        wrap.style.transform = `translate(${jx}px, ${jy}px) rotate(${p.rotate ?? -8}deg) scale(${scale * sx}, ${scale})`;
      },
    };
  },
};

// ---------- FX ----------
const speedLines = {
  id: 'speedLines',
  kind: 'fx',
  label: 'Líneas de velocidad',
  params: [
    { key: 'angle', label: 'Dirección (°)', type: 'number', min: -180, max: 180, default: 0 },
    { key: 'count', label: 'Cantidad', type: 'number', min: 5, max: 200, default: 60 },
    { key: 'speed', label: 'Velocidad (px/s)', type: 'number', min: 0, max: 8000, default: 3000 },
    { key: 'color', label: 'Color', type: 'color', default: '#111111' },
    { key: 'opacity', label: 'Opacidad', type: 'number', min: 0, max: 1, step: 0.05, default: 0.8 },
    { key: 'fps', label: 'Cuadros/s del efecto', type: 'number', min: 6, max: 60, default: 12 },
    { key: 'clearCenter', label: 'Centro despejado (0..1)', type: 'number', min: 0, max: 0.9, step: 0.05, default: 0.35 },
  ],
  build(ctx) {
    const p = ctx.params;
    const { w, h } = ctx.frame;
    const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    Object.assign(s.style, { position: 'absolute', inset: 0, pointerEvents: 'none' });
    const g = svg('g', { transform: `rotate(${p.angle || 0} ${w / 2} ${h / 2})` });
    s.append(g);
    const diag = Math.hypot(w, h);
    const lines = [];
    for (let i = 0; i < (p.count || 60); i++) {
      const yy = (w / 2 - diag / 2) * 0 + (i / (p.count || 60)) * diag + (h - diag) / 2 + (ctx.rand() - 0.5) * 20;
      const len = 200 + ctx.rand() * 900;
      const wdt = 2 + ctx.rand() * 7;
      const off = ctx.rand() * diag * 2;
      const r = svg('polygon', { fill: p.color || '#111' });
      g.append(r);
      lines.push({ yy, len, wdt, off, r });
    }
    ctx.mount(s, 'screen');
    return {
      update(t) {
        const tt = Math.floor(t * (p.fps || 12)) / (p.fps || 12);
        const cc = p.clearCenter ?? 0.35;
        for (const L of lines) {
          const x = ((L.off + tt * (p.speed ?? 3000)) % (diag * 2)) - diag + (w - diag) / 2;
          const dy = Math.abs(L.yy - h / 2) / (diag / 2);
          const vis = dy > cc ? 1 : 0;
          L.r.setAttribute('points', `${x},${L.yy} ${x + L.len},${L.yy - L.wdt / 2} ${x + L.len},${L.yy + L.wdt / 2}`);
          L.r.style.opacity = vis;
        }
        const io = inOut(t, ctx.duration, { preset: 'fade', duration: 0.15 }, { preset: 'fade', duration: 0.2 });
        s.style.opacity = io.opacity * (p.opacity ?? 0.8);
      },
    };
  },
};

const focusLines = {
  id: 'focusLines',
  kind: 'fx',
  label: 'Líneas de foco (radiales)',
  params: [
    { key: 'center', label: 'Centro [x,y] en pantalla', type: 'json', default: null },
    { key: 'count', label: 'Cantidad', type: 'number', min: 10, max: 300, default: 110 },
    { key: 'inner', label: 'Radio libre (0..1)', type: 'number', min: 0, max: 0.9, step: 0.05, default: 0.42 },
    { key: 'color', label: 'Color', type: 'color', default: '#111111' },
    { key: 'opacity', label: 'Opacidad', type: 'number', min: 0, max: 1, step: 0.05, default: 0.85 },
    { key: 'fps', label: 'Cuadros/s del efecto', type: 'number', min: 4, max: 30, default: 12 },
  ],
  build(ctx) {
    const p = ctx.params;
    const { w, h } = ctx.frame;
    const [cx, cy] = p.center || [w / 2, h / 2];
    const s = svg('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    Object.assign(s.style, { position: 'absolute', inset: 0, pointerEvents: 'none' });
    const R = Math.hypot(w, h);
    const polys = Array.from({ length: p.count || 110 }, () => {
      const r = svg('polygon', { fill: p.color || '#111' });
      s.append(r);
      return r;
    });
    ctx.mount(s, 'screen');
    let lastStep = -1;
    return {
      update(t) {
        const step = Math.floor(t * (p.fps || 12));
        if (step !== lastStep) {
          lastStep = step;
          const rr = (i, j) => ctx.hashRand(step * 1009 + i * 13 + j);
          polys.forEach((poly, i) => {
            const a = (i / polys.length) * Math.PI * 2 + rr(i, 0) * 0.05;
            const width = 0.004 + rr(i, 1) * 0.014;
            const r0 = R * ((p.inner ?? 0.42) * 0.5 + rr(i, 2) * 0.12) * 0.9;
            const pts = [
              [cx + Math.cos(a - width) * R, cy + Math.sin(a - width) * R],
              [cx + Math.cos(a) * r0, cy + Math.sin(a) * r0],
              [cx + Math.cos(a + width) * R, cy + Math.sin(a + width) * R],
            ];
            poly.setAttribute('points', pts.map((q) => q.join(',')).join(' '));
          });
        }
        const io = inOut(t, ctx.duration, { preset: 'fade', duration: 0.1 }, { preset: 'fade', duration: 0.2 });
        s.style.opacity = io.opacity * (p.opacity ?? 0.85);
      },
    };
  },
};

const flash = {
  id: 'flash',
  kind: 'fx',
  label: 'Flash',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    { key: 'peak', label: 'Pico (0..1 del clip)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.15 },
    { key: 'max', label: 'Opacidad máx', type: 'number', min: 0, max: 1, step: 0.05, default: 1 },
  ],
  build(ctx) {
    const d = el('div', 'cm-flash', { position: 'absolute', inset: 0, background: ctx.params.color || '#fff', pointerEvents: 'none' });
    ctx.mount(d, 'screen');
    return {
      update(t) {
        const pk = (ctx.params.peak ?? 0.15) * ctx.duration;
        const o = t < pk ? progress(t, 0, pk) : 1 - easing('easeOut', ctx.duration - pk)(progress(t, pk, ctx.duration - pk));
        d.style.opacity = o * (ctx.params.max ?? 1);
      },
    };
  },
};

const vignette = {
  id: 'vignette',
  kind: 'fx',
  label: 'Viñeteado / tinte',
  params: [
    { key: 'color', label: 'Color', type: 'color', default: '#000000' },
    { key: 'amount', label: 'Intensidad', type: 'number', min: 0, max: 1, step: 0.05, default: 0.55 },
  ],
  build(ctx) {
    const d = el('div', null, { position: 'absolute', inset: 0, pointerEvents: 'none' });
    ctx.mount(d, 'screen');
    return {
      update(t) {
        const io = inOut(t, ctx.duration, { preset: 'fade', duration: 0.3 }, { preset: 'fade', duration: 0.3 });
        d.style.background = `radial-gradient(ellipse at center, transparent 45%, ${ctx.params.color || '#000'})`;
        d.style.opacity = io.opacity * (ctx.params.amount ?? 0.55);
      },
    };
  },
};

// ---------- TRANSICIONES ----------
const T = (id, label, params, apply) => ({ id, kind: 'transition', label, params, apply });

const transitions = [
  T('cut', 'Corte seco', [], () => {}),
  T('fade', 'Fundido', [], ({ inEl, p }) => {
    inEl.style.opacity = p;
  }),
  T(
    'wipe',
    'Barrido',
    [
      { key: 'dir', label: 'Dirección', type: 'select', options: ['right', 'left', 'down', 'up'], default: 'right' },
      { key: 'bar', label: 'Borde de viñeta (px)', type: 'number', min: 0, max: 60, default: 16 },
    ],
    ({ inEl, overlay, p, params, ctx }) => {
      const k = (1 - p) * 100;
      const dir = params.dir || 'right';
      const ins = { right: `inset(0 ${k}% 0 0)`, left: `inset(0 0 0 ${k}%)`, down: `inset(0 0 ${k}% 0)`, up: `inset(${k}% 0 0 0)` }[dir];
      inEl.style.clipPath = ins;
      const bar = params.bar ?? 16;
      if (bar && p > 0 && p < 1) {
        const horiz = dir === 'right' || dir === 'left';
        const pos = dir === 'right' || dir === 'down' ? p : 1 - p;
        Object.assign(overlay.style, {
          display: 'block',
          background: '#111',
          left: horiz ? `calc(${pos * 100}% - ${bar / 2}px)` : '0',
          top: horiz ? '0' : `calc(${pos * 100}% - ${bar / 2}px)`,
          width: horiz ? bar + 'px' : '100%',
          height: horiz ? '100%' : bar + 'px',
        });
      }
    },
  ),
  T('zoomPunch', 'Zoom punch', [{ key: 'from', label: 'Escala inicial', type: 'number', min: 1, max: 4, step: 0.05, default: 1.8 }], ({ inEl, outEl, p, params }) => {
    inEl.style.transform = `scale(${mix(params.from ?? 1.8, 1, p)})`;
    inEl.style.opacity = clamp(0, 1, p * 2.5);
    if (outEl) outEl.style.transform = `scale(${mix(1, 0.85, p)})`;
  }),
  T('slide', 'Deslizar', [{ key: 'dir', label: 'Dirección', type: 'select', options: ['left', 'right', 'up', 'down'], default: 'left' }], ({ inEl, outEl, p, params }) => {
    const d = params.dir || 'left';
    const ax = d === 'left' || d === 'right' ? 'X' : 'Y';
    const sg = d === 'left' || d === 'up' ? 1 : -1;
    inEl.style.transform = `translate${ax}(${sg * (1 - p) * 100}%)`;
    if (outEl) outEl.style.transform = `translate${ax}(${-sg * p * 100}%)`;
  }),
  T(
    'slash',
    'Corte diagonal (split de página)',
    [
      { key: 'angle', label: 'Ángulo (°)', type: 'number', min: -80, max: 80, default: -20 },
      { key: 'gutter', label: 'Canaleta blanca (px)', type: 'number', min: 0, max: 60, default: 18 },
    ],
    ({ inEl, under, p, params, ctx }) => {
      const { w, h } = ctx.frame;
      const a = ((params.angle ?? -20) * Math.PI) / 180;
      const R = Math.hypot(w, h);
      const half = p * R * 0.6;
      const dx = Math.cos(a) * R;
      const dy = Math.sin(a) * R;
      const nx = -Math.sin(a) * half;
      const ny = Math.cos(a) * half;
      const cx = w / 2;
      const cy = h / 2;
      const pts = [
        [cx - dx + nx, cy - dy + ny],
        [cx + dx + nx, cy + dy + ny],
        [cx + dx - nx, cy + dy - ny],
        [cx - dx - nx, cy - dy - ny],
      ];
      inEl.style.clipPath = `polygon(${pts.map((q) => `${q[0]}px ${q[1]}px`).join(',')})`;
      const g = params.gutter ?? 18;
      if (g && p < 1) {
        const n2x = -Math.sin(a) * (half + g);
        const n2y = Math.cos(a) * (half + g);
        const pts2 = [
          [cx - dx + n2x, cy - dy + n2y],
          [cx + dx + n2x, cy + dy + n2y],
          [cx + dx - n2x, cy + dy - n2y],
          [cx - dx - n2x, cy - dy - n2y],
        ];
        Object.assign(under.style, { display: 'block', inset: '0', background: '#fff', clipPath: `polygon(${pts2.map((q) => `${q[0]}px ${q[1]}px`).join(',')})` });
      }
    },
  ),
  T('iris', 'Iris', [{ key: 'center', label: 'Centro [x%, y%]', type: 'json', default: [50, 50] }], ({ inEl, p, params, ctx }) => {
    const [x, y] = params.center || [50, 50];
    inEl.style.clipPath = `circle(${p * 75}% at ${x}% ${y}%)`;
  }),
  T('inkBlot', 'Mancha de tinta', [{ key: 'blobs', label: 'Manchas', type: 'number', min: 1, max: 12, default: 5 }], ({ inEl, p, params, ctx }) => {
    const { w, h } = ctx.frame;
    const R = Math.hypot(w, h);
    let circles = '';
    const n = params.blobs || 5;
    for (let i = 0; i < n; i++) {
      const bx = ctx.hashRand(i * 3 + 1) * w;
      const by = ctx.hashRand(i * 3 + 2) * h;
      const delay = ctx.hashRand(i * 3 + 3) * 0.35;
      const pr = clamp(0, 1, (p - delay) / (1 - delay));
      circles += `<circle cx='${bx.toFixed(0)}' cy='${by.toFixed(0)}' r='${(easing('circIn')(pr) * R * 0.9).toFixed(1)}'/>`;
    }
    const m = `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>${circles}</svg>`)}")`;
    inEl.style.webkitMaskImage = m;
    inEl.style.maskImage = m;
    inEl.style.maskSize = inEl.style.webkitMaskSize = '100% 100%';
  }),
  T('flashCut', 'Corte con flash', [{ key: 'color', label: 'Color', type: 'color', default: '#ffffff' }], ({ inEl, overlay, p, params }) => {
    inEl.style.opacity = p < 0.5 ? 0 : 1;
    Object.assign(overlay.style, { display: 'block', inset: '0', background: params.color || '#fff', opacity: 1 - Math.abs(p - 0.5) * 2 });
  }),
];

export function defaultsOf(def) {
  const o = {};
  for (const prm of def.params || []) if (prm.default !== undefined) o[prm.key] = structuredClone(prm.default);
  return o;
}

// meta.panelDefaults: params por defecto de TODAS las viñetas del proyecto, debajo de los de cada variante
// (merge superficial: la variante gana clave por clave). Se aplica al construir, así que no toca el
// contenido ni el approvedHash de las variantes.
export function withPanelDefaults(meta, params) {
  const d = meta?.panelDefaults;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return params || {};
  return { ...structuredClone(d), ...(params || {}) };
}

export const BUILTIN = [camera, shake, dutch, dolly, move3d, panel, bubble, ono, speedLines, focusLines, flash, vignette, halftone, ink, posterize, paper, chroma, cssFilter, ...transitions, ...VFX];

{
  const seen = new Set();
  for (const d of BUILTIN) {
    if (seen.has(d.id)) throw new Error('preset duplicado: ' + d.id);
    seen.add(d.id);
  }
}
