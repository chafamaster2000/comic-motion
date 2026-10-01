// Texturas de capas SIN premultiplicar con mipmaps correctos.
//
// Las capas de una viñeta por capas se suben sin premultiplicar (paridad exacta con el PSD) y el shader
// premultiplica después de filtrar. Con mipmaps generados por la GPU eso promedia el RGB de los píxeles
// transparentes (negro o basura del PNG) con el de los visibles: al achicar, los bordes se oscurecen o
// toman colores raros. Acá armamos la pirámide en JS:
//   - cada nivel es el promedio PONDERADO POR ALFA (= promedio premultiplicado, guardado sin premultiplicar)
//     y el alfa promedio;
//   - los píxeles con alfa 0 (en todos los niveles) toman el color de su celda más cercana con dibujo
//     ("alpha bleeding"), así el filtrado bilineal tampoco trae color de afuera.
// Los píxeles con alfa > 0 del nivel 0 quedan intactos: en reposo (1:1, sin mips) el render no cambia.

// RGBA crudo (sin premultiplicar, sin conversión de color) de un ImageBitmap decodificado con
// premultiplyAlpha 'none'. Un canvas 2D premultiplica (pierde precisión en bordes suaves): usamos WebGL2.
export function rawRGBA(bmp) {
  const w = bmp.width;
  const h = bmp.height;
  // contexto compartido (en globalThis: estas funciones también corren dentro de un Worker, ver más abajo)
  if (!globalThis.__cmTexGl) globalThis.__cmTexGl = new OffscreenCanvas(1, 1).getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  const gl = globalThis.__cmTexGl;
  if (!gl) throw new Error('sin WebGL2 para leer la capa');
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const out = new Uint8Array(w * h * 4);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(t);
  return out;
}

// Pirámide de mipmaps [{ data, width, height }, …] (nivel 0 = la imagen, con bleeding en alfa 0).
export function premultipliedMips(data, w, h) {
  // niveles en float premultiplicado: [r·a, g·a, b·a, a] (0..1), promedio de 2×2 (con borde repetido si es impar)
  const levels = [{ w, h, p: null }];
  {
    // nivel 1 directo desde los bytes (no guardamos el nivel 0 en float)
    let pw = w;
    let ph = h;
    let src = null; // Float32Array del nivel anterior (null = bytes del nivel 0)
    while (pw > 1 || ph > 1) {
      const nw = Math.max(1, pw >> 1);
      const nh = Math.max(1, ph >> 1);
      const p = new Float32Array(nw * nh * 4);
      for (let y = 0; y < nh; y++) {
        const y0 = Math.min(ph - 1, 2 * y);
        const y1 = Math.min(ph - 1, 2 * y + 1);
        for (let x = 0; x < nw; x++) {
          const x0 = Math.min(pw - 1, 2 * x);
          const x1 = Math.min(pw - 1, 2 * x + 1);
          const i0 = (y0 * pw + x0) * 4;
          const i1 = (y0 * pw + x1) * 4;
          const i2 = (y1 * pw + x0) * 4;
          const i3 = (y1 * pw + x1) * 4;
          let r;
          let g;
          let b;
          let a;
          if (src) {
            r = src[i0] + src[i1] + src[i2] + src[i3];
            g = src[i0 + 1] + src[i1 + 1] + src[i2 + 1] + src[i3 + 1];
            b = src[i0 + 2] + src[i1 + 2] + src[i2 + 2] + src[i3 + 2];
            a = src[i0 + 3] + src[i1 + 3] + src[i2 + 3] + src[i3 + 3];
          } else {
            const a0 = data[i0 + 3];
            const a1 = data[i1 + 3];
            const a2 = data[i2 + 3];
            const a3 = data[i3 + 3];
            const k = 1 / (255 * 255);
            r = (data[i0] * a0 + data[i1] * a1 + data[i2] * a2 + data[i3] * a3) * k;
            g = (data[i0 + 1] * a0 + data[i1 + 1] * a1 + data[i2 + 1] * a2 + data[i3 + 1] * a3) * k;
            b = (data[i0 + 2] * a0 + data[i1 + 2] * a1 + data[i2 + 2] * a2 + data[i3 + 2] * a3) * k;
            a = (a0 + a1 + a2 + a3) / 255;
          }
          const o = (y * nw + x) * 4;
          p[o] = r / 4;
          p[o + 1] = g / 4;
          p[o + 2] = b / 4;
          p[o + 3] = a / 4;
        }
      }
      levels.push({ w: nw, h: nh, p });
      src = p;
      pw = nw;
      ph = nh;
    }
  }
  // de arriba hacia abajo: color sin premultiplicar de cada celda; las vacías heredan el de su padre
  const n = levels.length;
  const cols = new Array(n); // Float32Array rgb por celda (niveles ≥ 1)
  for (let k = n - 1; k >= 1; k--) {
    const { w: lw, h: lh, p } = levels[k];
    const c = new Float32Array(lw * lh * 3);
    const par = k < n - 1 ? cols[k + 1] : null;
    const pw = k < n - 1 ? levels[k + 1].w : 1;
    const ph = k < n - 1 ? levels[k + 1].h : 1;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const i = y * lw + x;
        const a = p[i * 4 + 3];
        if (a > 1e-6) {
          c[i * 3] = p[i * 4] / a;
          c[i * 3 + 1] = p[i * 4 + 1] / a;
          c[i * 3 + 2] = p[i * 4 + 2] / a;
        } else if (par) {
          const j = Math.min(ph - 1, y >> 1) * pw + Math.min(pw - 1, x >> 1);
          c[i * 3] = par[j * 3];
          c[i * 3 + 1] = par[j * 3 + 1];
          c[i * 3 + 2] = par[j * 3 + 2];
        }
      }
    }
    cols[k] = c;
  }
  const to8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const out = [];
  // nivel 0: intacto donde hay alfa; bleeding en alfa 0
  const d0 = new Uint8Array(data);
  if (n > 1) {
    const c1 = cols[1];
    const w1 = levels[1].w;
    const h1 = levels[1].h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d0[i + 3] !== 0) continue;
        const j = (Math.min(h1 - 1, y >> 1) * w1 + Math.min(w1 - 1, x >> 1)) * 3;
        d0[i] = to8(c1[j]);
        d0[i + 1] = to8(c1[j + 1]);
        d0[i + 2] = to8(c1[j + 2]);
      }
    }
  }
  out.push({ data: d0, width: w, height: h });
  for (let k = 1; k < n; k++) {
    const { w: lw, h: lh, p } = levels[k];
    const c = cols[k];
    const d = new Uint8Array(lw * lh * 4);
    for (let i = 0; i < lw * lh; i++) {
      d[i * 4] = to8(c[i * 3]);
      d[i * 4 + 1] = to8(c[i * 3 + 1]);
      d[i * 4 + 2] = to8(c[i * 3 + 2]);
      d[i * 4 + 3] = to8(p[i * 4 + 3]);
    }
    out.push({ data: d, width: lw, height: lh });
  }
  return out;
}

// ---- en paralelo: un pool chico de Workers (las funciones de arriba son autocontenidas y se copian al
// Worker como texto). Si no hay Workers, se hace en el hilo principal.
let pool = null;
let seq = 0;
const waiting = new Map();
function getPool() {
  if (pool) return pool;
  pool = [];
  try {
    const src = `const rawRGBA = ${rawRGBA.toString()};
const premultipliedMips = ${premultipliedMips.toString()};
onmessage = (e) => {
  const { id, bmp, mips } = e.data;
  try {
    const data = rawRGBA(bmp);
    const levels = mips ? premultipliedMips(data, bmp.width, bmp.height) : [{ data, width: bmp.width, height: bmp.height }];
    bmp.close();
    postMessage({ id, levels }, levels.map((l) => l.data.buffer));
  } catch (err) {
    postMessage({ id, error: String(err && err.message || err) });
  }
};`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(url);
      w.onmessage = (e) => {
        const job = waiting.get(e.data.id);
        if (!job) return;
        waiting.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.levels);
      };
      pool.push(w);
    }
  } catch (e) {
    pool = [];
  }
  return pool;
}

// ImageBitmap (premultiplyAlpha 'none') → niveles [{ data, width, height }] (solo el 0 si mips = false).
// El bitmap se transfiere (queda inutilizable).
export function prepareLayerTexture(bmp, mips = true) {
  const p = getPool();
  if (!p.length) {
    const data = rawRGBA(bmp);
    const levels = mips ? premultipliedMips(data, bmp.width, bmp.height) : [{ data, width: bmp.width, height: bmp.height }];
    bmp.close?.();
    return Promise.resolve(levels);
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    p[id % p.length].postMessage({ id, bmp, mips }, [bmp]);
  });
}
