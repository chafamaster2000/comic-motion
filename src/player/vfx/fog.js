// VFX de niebla: bancos de niebla procedurales (fbm de ruido Perlin con deformación de dominio),
// varias láminas con parallax propio (las cercanas más grandes, más bajas y más rápidas), en una banda
// baja con gradiente. Todo es función pura de t (sin estado ni Math.random): el export coincide con el preview.
import { common, targetInfo, envelope, regionParams, toPolygon, polygonMask } from './common.js';

export const fog = {
  id: 'fog',
  kind: 'vfx',
  gpu: true,
  label: 'Niebla',
  params: [
    ...common({ layer: 'mid', style: true }),
    { key: 'density', label: 'Densidad (0..1)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.5 },
    { key: 'color', label: 'Color', type: 'color', default: '#c9d6e8' },
    { key: 'height', label: 'Alto de la banda (0..1 de la viñeta, desde abajo)', type: 'number', min: 0.05, max: 1, step: 0.05, default: 0.45 },
    { key: 'speed', label: 'Viento (px/s, negativo = hacia la izquierda)', type: 'number', min: -600, max: 600, default: 35 },
    { key: 'scale', label: 'Tamaño de los bancos (px)', type: 'number', min: 40, max: 3000, default: 420 },
    { key: 'softness', label: 'Suavidad (0..1)', type: 'number', min: 0, max: 1, step: 0.05, default: 0.6 },
    { key: 'layers', label: 'Láminas de profundidad (1..4)', type: 'number', min: 1, max: 4, step: 1, default: 3 },
    { key: 'evolve', label: 'Turbulencia (cambio de forma por segundo)', type: 'number', min: 0, max: 1, step: 0.01, default: 0.08 },
    { key: 'inkLevels', label: 'Bandas del estilo ink (2..6)', type: 'number', min: 2, max: 6, step: 1, default: 3 },
    { key: 'fade', label: 'Fundido de entrada/salida (s)', type: 'number', min: 0, max: 5, step: 0.05, default: 0 },
    { key: 'avoid', label: 'Zonas despejadas [[x,y,w,h],…] en la página (caras, textos)', type: 'json', default: null },
    { key: 'avoidFeather', label: 'Borde suave de las zonas despejadas (px)', type: 'number', min: 0, max: 600, default: 90 },
    ...regionParams('la niebla'),
  ],
  build(ctx) {
    const g = ctx.gpu;
    const T = g.THREE;
    const { vec2, vec3, vec4, float, uv, clamp, smoothstep, mix, max, abs, length, floor, fract, fwidth, pow } = g.TSL;
    const p = ctx.params;
    const { rect } = targetInfo(ctx);
    const layer = p.layer || 'mid';
    const L = Math.max(1, Math.min(4, Math.round(p.layers ?? 3)));
    const scale = Math.max(40, p.scale ?? 420);
    const speed = p.speed ?? 35;
    const dens = Math.max(0, Math.min(1, p.density ?? 0.5));
    const soft = Math.max(0, Math.min(1, p.softness ?? 0.6));
    const height = Math.max(0.05, Math.min(1, p.height ?? 0.45));
    const evolve = p.evolve ?? 0.08;
    const col = new T.Color(p.color || '#c9d6e8');
    const env = g.uniform(1);
    const t = g.time;
    // offsets fijos por lámina desde la semilla del clip (no Math.random)
    const rnd = g.randoms(L * 2, 7);

    // quad en px de página: la viñeta + margen para cubrir el empuje del parallax
    const m = Math.max(rect[2], rect[3]) * 0.15;
    const X0 = rect[0] - m;
    const Y0 = rect[1] - m;
    const W = rect[2] + 2 * m;
    const H = rect[3] + 2 * m;
    const P = vec2(X0, Y0).add(uv().mul(vec2(W, H)));
    const Pb = g.toBase(layer)(P); // la misma posición en px de página del fondo (sin el empuje de la capa)
    const yy = Pb.y.sub(rect[1]).div(rect[3]); // 0 arriba .. 1 abajo de la viñeta

    const fbm = (q, z) => {
      let s = float(0);
      let a = 0.5;
      let f = 1;
      let norm = 0;
      for (let o = 0; o < 4; o++) {
        s = s.add(g.fx.noise(vec3(q.mul(f), z.add(o * 3.7))).mul(a));
        norm += a;
        a *= 0.5;
        f *= 2.03;
      }
      return s.div(norm);
    };

    let clear = float(1); // producto de (1 - alfa de cada lámina)
    let light = float(0);
    for (let i = 0; i < L; i++) {
      const k = L === 1 ? 1 : i / (L - 1); // 0 = lejos, 1 = cerca
      const sc = scale * (0.55 + 0.9 * k);
      const wind = speed * (0.4 + 1.0 * k);
      const off = vec2(rnd[i * 2] * 1000, rnd[i * 2 + 1] * 1000);
      const q = P.sub(vec2(t.mul(wind), 0)).div(vec2(sc, sc * 0.55)).add(off); // bancos más anchos que altos
      const z = t.mul(evolve).add(i * 11.3);
      // deformación de dominio: jirones en vez de manchas redondas
      const w = vec2(g.fx.noise(vec3(q.mul(0.5), z)), g.fx.noise(vec3(q.mul(0.5).add(5.2), z.add(1.9))));
      const n = fbm(q.add(w.mul(0.75)), z.mul(1.3)).mul(0.5).add(0.5); // ~0..1
      // banda baja: las láminas lejanas suben más (horizonte), las cercanas abrazan el piso
      const top = 1 - height * (1.0 - 0.3 * k);
      const bw = height * (0.18 + 0.55 * soft);
      const band = smoothstep(top - bw, top + bw, yy.add(n.sub(0.5).mul(height * 0.35)));
      const thr = 0.66 - 0.42 * dens;
      const c = smoothstep(thr - 0.05 - 0.2 * soft, thr + 0.1 + 0.3 * soft, n);
      const a = c.mul(band).mul(0.35 + 0.55 * dens).mul(0.75 + 0.25 * k);
      clear = clear.mul(float(1).sub(a));
      light = light.add(n.mul(a));
    }
    let A = float(1).sub(clear);
    const tone = clamp(light.div(max(A, 1e-3)), 0, 1); // brillo interno: núcleos más densos, más claros
    let rgb = vec3(col.r, col.g, col.b).mul(tone.mul(0.25).add(0.85));

    // zonas despejadas (caras, textos) y zona visible (forma dibujada de la viñeta)
    let mask = float(1);
    const feather = Math.max(1, p.avoidFeather ?? 90);
    for (const r of Array.isArray(p.avoid) ? p.avoid : []) {
      if (!Array.isArray(r) || r.length < 4) continue;
      const [x, y, w, h] = r;
      const d = length(max(abs(Pb.sub(vec2(x + w / 2, y + h / 2))).sub(vec2(w / 2, h / 2)), 0));
      mask = mask.mul(smoothstep(0, feather, d));
    }
    const poly = toPolygon(p.region);
    if (poly) mask = mask.mul(polygonMask(g.TSL, Pb, poly, p.regionFeather ?? 4));

    const inten = p.intensity ?? 1;
    A = clamp(A.mul(inten), 0, 0.95).mul(mask).mul(env).mul(g.enabled);

    let frag;
    if (p.style === 'ink') {
      // bandas posterizadas con filete de tinta en cada salto
      const lv = Math.max(2, Math.min(6, Math.round(p.inkLevels ?? 3)));
      const x = A.mul(lv / 0.95);
      const fl = floor(x);
      const fr = fract(x);
      const aw = max(fwidth(x), 1e-4);
      const q = fl.add(smoothstep(float(0.5).sub(aw), float(0.5).add(aw), fr)).div(lv);
      const edge = float(1).sub(smoothstep(0.6, 1.6, abs(fr.sub(0.5)).div(aw))).mul(smoothstep(0.3, 0.8, x));
      const aFill = q.mul(0.8);
      const lineRgb = rgb.mul(0.55);
      const a = max(aFill, edge.mul(0.9));
      const outRgb = mix(rgb.mul(aFill), lineRgb.mul(a), edge);
      frag = vec4(outRgb, a);
    } else {
      // glow: normal con un 25% aditivo (la niebla "ilumina" un poco lo que cubre, como luz dispersa)
      frag = vec4(rgb.mul(A), A.mul(0.75));
    }
    const mesh = new T.Mesh(new T.PlaneGeometry(W, H), g.material({ fragment: frag }));
    mesh.position.set(X0 + W / 2, Y0 + H / 2, 0);
    // en px de página y crece hacia abajo, así que el uv (0,0) del plano queda arriba a la izquierda
    mesh.renderOrder = 1;
    g.layer(layer).add(mesh);
    return {
      update(tt) {
        env.value = envelope(tt, ctx.duration, p.fade ?? 0, p.fade ?? 0);
      },
    };
  },
};

export const FOG = [fog];
