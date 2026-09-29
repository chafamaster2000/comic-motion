// Motor GPU de comic-motion: viñetas dibujadas con three.js (WebGPU, con caída automática a WebGL2).
//
// Una viñeta GPU es la MISMA viñeta DOM (caja con borde, radio, sombra, tilt, entrada/salida: todo eso
// sigue siendo CSS sobre la caja) pero su contenido (`.cm-media`: fondo, recorte fg, depthLock y
// filtros) lo dibuja three en un <canvas> que vive dentro de la caja. El canvas mide lo mismo que el
// cuadro de salida y lleva la transformación CSS inversa de la cadena caja→página→cámara→escena, así
// cada píxel del canvas cae sobre un píxel del video: nada de reescalados, mismo antialiasing que el DOM.
// Las capas de VFX (back/mid/front/screen) se intercalan entre las capas de la imagen en el mismo canvas.
//
// Todo depende de t: el player llama a render() después de actualizar todos los clips del cuadro.
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { mulberry32 } from '../../shared/scene.js';
import { VFX_LAYER_DEPTH, layerLayout } from '../media.js';
import { TSL_FILTERS } from './filters.js';
import { LayersRig } from './layers.js';

// Trabajamos en el mismo espacio que el navegador: valores sRGB tal cual, sin linealizar.
// Así el filtrado de texturas, las mezclas y los colores hex coinciden con el DOM.
THREE.ColorManagement.enabled = false;

const { Fn, uniform, vec2, vec3, vec4, float, texture: textureNode, uv, screenUV, convertToTexture, select, hash, mx_noise_float, smoothstep, clamp, mix, fwidth, length, max, min, abs, exp, sin, cos, mod, fract, floor, dot, normalize, positionGeometry, attribute, varying } = TSL;

export const LAYER_ORDER = { back: 0, base: 1, mid: 2, fg: 3, lock: 4, front: 5, screen: 6 };

const blendPremul = (m) => {
  m.transparent = true;
  m.depthTest = false;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  return m;
};
const blendAdd = (m) => {
  blendPremul(m);
  m.blendDst = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneFactor;
  return m;
};

// Material de nodos listo para dibujar en premultiplicado: `fragment` devuelve vec4(rgb*a, a).
// blend 'add' → aditivo (el alfa que devuelva el shader debería ser 0 para que sume también sobre el DOM).
export function makeMaterial({ fragment, position, blend = 'normal' } = {}) {
  const m = new THREE.MeshBasicNodeMaterial();
  if (position) m.positionNode = position;
  if (fragment) m.fragmentNode = fragment;
  return blend === 'add' ? blendAdd(m) : blendPremul(m);
}

// Multiplica el alfa de un color CSS (hex, rgb, rgba) por k.
function withAlpha(css, k) {
  if (k >= 1) return css;
  const c = new THREE.Color();
  let a = 1;
  const m = /rgba?\(([^)]*)\)/.exec(css || '');
  if (m) {
    const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
    c.setRGB(parts[0] / 255, parts[1] / 255, parts[2] / 255);
    if (parts.length > 3) a = parts[3];
  } else c.set(css || '#000');
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a * k})`;
}

// Quad de w×h en coordenadas locales (y hacia abajo), uv (0,0) arriba a la izquierda.
export function rectsGeometry(rects, aw, ah) {
  const pos = [];
  const uvs = [];
  const idx = [];
  rects.forEach(([x, y, w, h], i) => {
    pos.push(x, y, 0, x + w, y, 0, x + w, y + h, 0, x, y + h, 0);
    uvs.push(x / aw, y / ah, (x + w) / aw, y / ah, (x + w) / aw, (y + h) / ah, x / aw, (y + h) / ah);
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// Matriz 2D (DOMMatrix) del padding-box de `el` al espacio del cuadro (px CSS del frame, sin zoom).
function matrixToFrame(el, frame) {
  const cs0 = getComputedStyle(el);
  let m = new DOMMatrix().translate(parseFloat(cs0.borderLeftWidth) || 0, parseFloat(cs0.borderTopWidth) || 0);
  let node = el;
  while (node && node !== frame) {
    const cs = node === el ? cs0 : getComputedStyle(node);
    let ox = 0;
    let oy = 0;
    if (cs.position === 'absolute' || cs.position === 'relative') {
      ox = parseFloat(cs.left) || 0;
      oy = parseFloat(cs.top) || 0;
    }
    if (cs.transform && cs.transform !== 'none') {
      const [tx, ty] = cs.transformOrigin.split(' ').map(parseFloat);
      m = new DOMMatrix().translate(ox + tx, oy + ty).multiply(new DOMMatrix(cs.transform)).translate(-tx, -ty).multiply(m);
    } else if (ox || oy) m = new DOMMatrix().translate(ox, oy).multiply(m);
    const parent = node.parentElement;
    if (parent && parent !== frame) {
      const pcs = getComputedStyle(parent);
      const bl = parseFloat(pcs.borderLeftWidth) || 0;
      const bt = parseFloat(pcs.borderTopWidth) || 0;
      if (bl || bt) m = new DOMMatrix().translate(bl, bt).multiply(m);
    }
    node = parent;
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Helpers TSL para presets (ctx.gpu.fx)
const fx = {
  // hash entero (PCG) → [0,1): mismo resultado en Metal, D3D y GL
  hash: (n) => hash(n),
  hash2: (a, b) => hash(TSL.uint(a).mul(TSL.uint(0x9e3779b1)).add(TSL.uint(b))),
  // ruido Perlin (MaterialX) en 2D/3D, rango ~[-1,1]
  noise: (p) => mx_noise_float(p),
  // balística con gravedad g (vec2) y drag lineal k (1/s), forma cerrada
  ballistic: Fn(([p0, v0, g, k, tau]) => {
    const kk = max(k, 1e-3);
    const vt = g.div(kk);
    const e = exp(kk.negate().mul(tau));
    const pos = p0.add(vt.mul(tau)).add(v0.sub(vt).mul(float(1).sub(e)).div(kk));
    const vel = vt.add(v0.sub(vt).mul(e));
    return vec4(pos, vel);
  }),
  // campana suave 0→1→0 entre a y b
  pulse: (x, a, b) => smoothstep(a, a.add(b.sub(a).mul(0.2)), x).mul(float(1).sub(smoothstep(a.add(b.sub(a).mul(0.6)), b, x))),
  // temperatura de color: 0 = blanco caliente → amarillo → naranja → rojo oscuro (u de 0 a 1)
  heat: Fn(([u]) => {
    const c0 = vec3(1, 1, 0.92);
    const c1 = vec3(1, 0.86, 0.35);
    const c2 = vec3(1, 0.45, 0.08);
    const c3 = vec3(0.55, 0.06, 0.02);
    const a = mix(c0, c1, smoothstep(0, 0.25, u));
    const b = mix(a, c2, smoothstep(0.25, 0.6, u));
    return mix(b, c3, smoothstep(0.6, 1, u));
  }),
};

// ---------------------------------------------------------------------------------------------
// Sistema de partículas analíticas: cada partícula es un quad instanciado. `motion` (TSL) devuelve
// posición y velocidad en px de página a partir de dos vec4 aleatorios por partícula (generados en JS
// con mulberry32, no en el shader) y del tiempo. Estiramiento por velocidad = desenfoque de movimiento.
function makeParticles(api, spec) {
  const { count, seed = 1, motion, mask = null, style = 'glow', blend = style === 'glow' ? 'add' : 'normal', shutter = 1 / 48, stretch = 1, soft = 0.35, outline = 2, outlineColor = '#111111', halo = 0.6 } = spec;
  const n = Math.max(1, Math.floor(count));
  const rnd = mulberry32(seed >>> 0);
  const r0 = new Float32Array(n * 4);
  const r1 = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) r0[i] = rnd();
  for (let i = 0; i < n * 4; i++) r1[i] = rnd();
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  geo.setAttribute('r0', new THREE.InstancedBufferAttribute(r0, 4));
  geo.setAttribute('r1', new THREE.InstancedBufferAttribute(r1, 4));
  geo.instanceCount = n;
  const group = new THREE.Group();
  group.userData.particles = { geo, n };
  const passes = style === 'ink' ? [{ ink: 'outline' }, { ink: 'fill' }] : [{}];
  passes.forEach((ps, pi) => {
    const R0 = attribute('r0', 'vec4');
    const R1 = attribute('r1', 'vec4');
    const m = motion({ r0: R0, r1: R1, t: api.time, idx: TSL.instanceIndex, fx });
    const size = float(m.size).max(0);
    const pxs = api.pxScale; // px de dispositivo por px de página
    // tamaño mínimo ~1.25 px de dispositivo: lo que queda más chico se atenúa en vez de titilar
    const minSize = float(1.25).div(pxs);
    const sEff = max(size, minSize);
    const aSmall = size.div(sEff).pow(2);
    const extra = ps.ink === 'outline' ? float(outline * 2).div(pxs) : float(0);
    const pad = float(1 + (style === 'glow' ? halo * 2 : 0) + soft);
    const vel = vec2(m.vel);
    const speed = length(vel);
    const L = sEff.add(speed.mul(shutter * stretch));
    const dir = select(speed.greaterThan(1e-3), vel.div(max(speed, 1e-3)), vec2(1, 0));
    const perp = vec2(dir.y.negate(), dir.x);
    const alive = float(m.alpha).greaterThan(0.0001);
    const q = positionGeometry.xy;
    const wq = vec2(q.x.mul(L.add(extra)).mul(pad), q.y.mul(sEff.add(extra)).mul(pad));
    const center = vec2(m.pos);
    const world = center.add(dir.mul(wq.x)).add(perp.mul(wq.y));
    const posNode = select(alive, vec3(world, 0), vec3(center, 0).mul(0).add(vec3(1e7, 1e7, 0)));
    // en el fragment: distancia a la cápsula en unidades de radio (1 = borde)
    const vP = varying(wq, 'vP');
    const vL = varying(L.add(extra), 'vL');
    const vS = varying(sEff.add(extra), 'vS');
    const vA = varying(float(m.alpha).mul(aSmall).mul(sEff.div(L).pow(0.6)), 'vA');
    const vC = varying(vec3(m.color ?? vec3(1, 1, 1)), 'vC');
    // máscara opcional por fragmento en px de página (ej. recortar a la forma dibujada de la viñeta)
    const vW = mask ? varying(world, 'vW') : null;
    const frag = Fn(() => {
      const fragCore = fragBody();
      return mask ? fragCore.mul(float(mask(vW))) : fragCore;
    });
    const fragBody = () => {
      const h = max(vL.sub(vS).mul(0.5), 0);
      const d = length(vec2(max(abs(vP.x).sub(h), 0), vP.y)).div(vS.mul(0.5));
      const aa = max(fwidth(d), 1e-4);
      let a;
      if (style === 'glow') {
        const core = clamp(float(1).sub(d).div(max(aa, soft)), 0, 1);
        const tail = exp(d.mul(d).mul(-2.2)).mul(halo);
        a = clamp(core.add(tail), 0, 1).mul(vA);
        return vec4(vC.mul(a), 0);
      }
      const edge = clamp(float(1).sub(d).div(max(aa, soft)), 0, 1);
      a = edge.mul(vA);
      if (ps.ink === 'outline') return vec4(vec3(new THREE.Color(outlineColor)).mul(a), a);
      return vec4(vC.mul(a), a);
    };
    const fragNode = frag();
    const mat = makeMaterial({ position: posNode, fragment: fragNode, blend: ps.ink ? 'normal' : blend });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = pi;
    group.add(mesh);
  });
  return group;
}

// ---------------------------------------------------------------------------------------------
export function createGpuSystem(opts) {
  const panels = new Map(); // clipId → GpuPanel
  let backend = null;
  let disposed = false;

  function createPanel(rt, clipId, mode, sceneRef) {
    const p = new GpuPanel(rt, clipId, mode, opts, sceneRef);
    panels.set(sceneRef.key + '/' + clipId, p);
    p.ready.then((b) => {
      if (b && !backend) backend = b;
    });
    return p;
  }

  return {
    createPanel,
    get backend() {
      return backend;
    },
    panels,
    // espera a que todos los renderers estén inicializados y sus texturas cargadas
    async whenReady() {
      await Promise.all([...panels.values()].map((p) => p.ready));
    },
    renderVisible(isVisible) {
      if (disposed) return;
      for (const p of panels.values()) if (isVisible(p)) p.render();
    },
    // espera a que la GPU haya terminado TODO lo enviado (export cuadro por cuadro)
    async finish() {
      await Promise.all([...panels.values()].map((p) => p.finish()));
    },
    dispose() {
      disposed = true;
      for (const p of panels.values()) p.dispose();
      panels.clear();
    },
  };
}

class GpuPanel {
  constructor(rt, clipId, mode, opts, sceneRef) {
    this.rt = rt; // runtime de la viñeta (rt.rt.gpu tiene capas, caja, etc.)
    this.info = rt.rt.gpu;
    this.clipId = clipId;
    this.mode = mode; // 'full' | 'overlay'
    this.opts = opts;
    this.sceneRef = sceneRef;
    this.frameEl = opts.frame;
    this.W = opts.W;
    this.H = opts.H;
    this.failed = false;
    this.active = false;
    this.posts = [];
    this.particleGeos = [];
    this.vfxRuntimes = [];
    this.texturesLoading = [];
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
    this.camera.matrixAutoUpdate = false;
    this.groups = {};
    for (const [name, order] of Object.entries(LAYER_ORDER)) {
      const g = new THREE.Group();
      g.renderOrder = order;
      g.matrixAutoUpdate = false;
      this.groups[name] = g;
      this.scene.add(g);
    }
    // uniforms compartidos por los VFX y los filtros de esta viñeta
    this.u = {
      frame: uniform(new THREE.Vector2(this.W, this.H)),
      inv0: uniform(new THREE.Vector3(1, 0, 0)), // local = inv · frame
      inv1: uniform(new THREE.Vector3(0, 1, 0)),
      fwd0: uniform(new THREE.Vector3(1, 0, 0)), // frame = fwd · local
      fwd1: uniform(new THREE.Vector3(0, 1, 0)),
      origin: uniform(new THREE.Vector2(...this.info.origin)),
      inner: uniform(new THREE.Vector2(...this.info.inner)),
      pxScale: uniform(1), // px de dispositivo por px local
      pixelScale: uniform(1), // px de dispositivo por px del cuadro
      clip: uniform(new THREE.Vector4(0, 0, this.info.inner[0], this.info.inner[1])), // x0,y0,x1,y1 local
      radius: uniform(0),
      opacity: uniform(1),
    };
    this.layerPx = { back: uniform(1), mid: uniform(1), front: uniform(1), screen: uniform(1) };
    // por capa: (k, dx, dy) para pasar de px de página de esa capa (con parallax) a px de página del fondo
    this.layerBase = { back: uniform(new THREE.Vector3(1, 0, 0)), mid: uniform(new THREE.Vector3(1, 0, 0)), front: uniform(new THREE.Vector3(1, 0, 0)), screen: uniform(new THREE.Vector3(1, 0, 0)) };
    // viñeta por capas: el rig existe desde ya (los VFX piden sus grupos antes de que el renderer inicialice)
    this.rig = mode === 'full' && this.info.layersMode ? new LayersRig(this, makeMaterial, rectsGeometry) : null;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'cm-gpu';
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', width: this.W + 'px', height: this.H + 'px', transformOrigin: '0 0', pointerEvents: 'none', display: 'none' });
    // El canvas va como HERMANO de la caja (no adentro): si lo recortara el overflow:hidden de una caja
    // rotada/escalada, Chrome lo compondría con una máscara en una superficie intermedia y lo
    // re-muestrearía (borroso). El recorte al padding-box (con radio y clip-path inset) lo hace el shader.
    this.info.box.after(this.canvas);
    this.ready = this.init().catch((e) => {
      console.error('[comic] GPU no disponible para la viñeta ' + clipId, e);
      this.failed = true;
      this.canvas.remove();
      return null;
    });
  }

  async init() {
    // viñeta por capas: buffers de 8 bits (el de salida y el de la escena) → cada capa se redondea a 8 bits al
    // mezclarse, igual que la composición de Photoshop; con half float los .5 se corren 1/255
    const exact8 = !!this.info.layersMode;
    const renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true, samples: 4, alpha: true, forceWebGL: !!this.opts.forceWebGL, powerPreference: 'high-performance', ...(exact8 ? { outputBufferType: THREE.UnsignedByteType } : {}) });
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    // fondo de la caja (#fff) en modo completo; transparente en modo overlay
    if (this.mode === 'full') renderer.setClearColor(0xffffff, 1);
    else renderer.setClearColor(0x000000, 0);
    await renderer.init();
    this.renderer = renderer;
    this.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
    this.camera.coordinateSystem = renderer.coordinateSystem;
    this.maxAniso = renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy() : 16;
    if (this.mode === 'full') {
      // viñeta por capas: planos 3D en perspectiva (gpu/layers.js); si no, la imagen con sus capas 2.5D
      if (this.rig) this.rig.build();
      else this.buildMedia();
    }
    await Promise.all(this.texturesLoading);
    this.resize();
    this.buildPipeline();
    // primer cuadro para compilar pipelines antes de mostrar
    return this.backend;
  }

  makeTexture(el) {
    const tex = new THREE.Texture(el);
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.premultiplyAlpha = true;
    tex.generateMipmaps = true;
    tex.minFilter = this.info.pixelated ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = this.info.pixelated ? THREE.NearestFilter : THREE.LinearFilter;
    tex.anisotropy = this.maxAniso;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  loadImageTexture(src) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    const tex = this.makeTexture(img);
    this.texturesLoading.push(
      img.decode().then(
        () => (tex.needsUpdate = true),
        (e) => console.warn('[comic] textura', src, e),
      ),
    );
    return tex;
  }

  buildMedia() {
    const { asset, layers } = this.info;
    if (!asset) return;
    this.mediaMeshes = [];
    for (const l of layers) {
      let tex;
      if (l.img.tagName === 'VIDEO') {
        tex = this.makeTexture(l.img);
        tex.isVideoLike = true;
        this.video = l.img;
      } else tex = this.loadImageTexture(l.src);
      const rects = l.kind === 'lock' ? l.rects : [[0, 0, asset.w, asset.h]];
      const geo = rectsGeometry(rects, asset.w, asset.h);
      const mat = makeMaterial({ fragment: textureNode(tex, uv()) });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.groups[l.kind === 'base' ? 'base' : l.kind].add(mesh);
      this.mediaMeshes.push({ mesh, layer: l, tex });
    }
    this.textures = this.mediaMeshes.map((m) => m.tex);
  }

  // ---- API para los VFX ----
  layerGroup(name, ctx) {
    if (!['back', 'mid', 'front', 'screen'].includes(name)) throw new Error(`capa desconocida "${name}" (back|mid|front|screen)`);
    // viñeta por capas: el grupo va a la profundidad de `between`/`z`/layer entre los planos del PSD
    if (this.rig) return this.rig.layerGroup(name, ctx);
    const g = new THREE.Group();
    this.groups[name].add(g);
    return g;
  }

  addPost(stage) {
    this.posts.push(stage);
    this.posts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (this.renderer) this.buildPipeline();
  }

  // nodos TSL de conversión (válidos en pases de post)
  postHelpers() {
    const u = this.u;
    const toLocal = (F) => vec2(dot(u.inv0.xy, F).add(u.inv0.z), dot(u.inv1.xy, F).add(u.inv1.z));
    const framePos = screenUV.mul(u.frame);
    const localPos = toLocal(framePos);
    const pagePos = localPos.add(u.origin);
    // desplazamiento en px de página → desplazamiento en uv de pantalla
    const pageDeltaToUv = (d) => vec2(dot(u.fwd0.xy, d), dot(u.fwd1.xy, d)).div(u.frame);
    const pageToUv = (P) => {
      const L = P.sub(u.origin);
      return vec2(dot(u.fwd0.xy, L).add(u.fwd0.z), dot(u.fwd1.xy, L).add(u.fwd1.z)).div(u.frame);
    };
    return { uv: screenUV, framePos, localPos, pagePos, pageDeltaToUv, pageToUv, pxScale: u.pxScale, pixelScale: u.pixelScale, inner: u.inner };
  }

  buildPipeline() {
    if (this.pipeline) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
    const filters = this.mode === 'full' ? (this.info.filters || []).filter((f) => TSL_FILTERS[f.preset]) : [];
    const scenePass = TSL.pass(this.scene, this.camera, { samples: 4, ...(this.rig ? { type: THREE.UnsignedByteType } : {}) });
    this.scenePass = scenePass;
    const H = this.postHelpers();
    let cur = scenePass.getTextureNode();
    let curIsTex = true;
    const asTex = () => {
      if (!curIsTex) {
        cur = convertToTexture(cur);
        curIsTex = true;
      }
      return cur;
    };
    // filtros como en el DOM: primero los CSS sobre la imagen (en orden), después las capas encima
    const raw = (uvN) => scenePass.getTextureNode().sample(uvN);
    const stages = [
      ...filters.filter((f) => TSL_FILTERS[f.preset].node).map((f) => ({ filter: f, fn: 'node' })),
      ...filters.filter((f) => TSL_FILTERS[f.preset].overlay).map((f) => ({ filter: f, fn: 'overlay' })),
      ...this.posts,
    ];
    for (const st of stages) {
      if (st.filter) {
        const def = TSL_FILTERS[st.filter.preset];
        const src = def.sample ? asTex() : cur;
        const sample = (uvN) => src.sample(uvN);
        const color = curIsTex ? src.sample(screenUV) : cur;
        cur = def[st.fn]({ color, sample, raw, params: st.filter, h: H });
        curIsTex = false;
        continue;
      }
      const src = st.sample || st.bloom ? asTex() : cur;
      const colorIn = curIsTex ? src.sample(screenUV) : cur;
      if (st.bloom) {
        const b = bloom(colorIn, st.bloom.strength, st.bloom.radius, st.bloom.threshold);
        b.setResolutionScale?.(0.5 / Math.max(0.25, this.pixelScale || 1));
        b.smoothWidth.value = 0.08;
        st.bloomNode = b;
        cur = colorIn.add(b.mul(st.enabled));
      } else {
        const out = st.fn({ ...H, color: colorIn, sample: (uvN) => src.sample(uvN), panelTexture: scenePass.getTextureNode() });
        cur = select(st.enabled.greaterThan(0.5), out, colorIn);
      }
      curIsTex = false;
    }
    // recorte al padding-box de la caja (rect redondeado), con cobertura antialias en px de dispositivo
    const u = this.u;
    const c0 = u.clip.xy;
    const c1 = u.clip.zw;
    const half = c1.sub(c0).mul(0.5);
    const q = abs(H.localPos.sub(c0.add(half))).sub(half.sub(u.radius));
    const sd = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(u.radius);
    const cov = clamp(float(0.5).sub(sd.mul(u.pxScale)), 0, 1).mul(u.opacity);
    const col = curIsTex ? cur.sample(screenUV) : cur;
    const pipe = new THREE.RenderPipeline(this.renderer, this.mode === 'full' ? vec4(col.rgb, 1).mul(cov) : col.mul(cov));
    pipe.outputColorTransform = false;
    this.pipeline = pipe;
  }

  resize() {
    const s = this.opts.pixelScale();
    if (s === this.pixelScale && this.bw) return;
    this.pixelScale = s;
    this.bw = Math.max(1, Math.round(this.W * s));
    this.bh = Math.max(1, Math.round(this.H * s));
    this.renderer.setSize(this.bw, this.bh, false);
    this.u.pixelScale.value = s;
    for (const st of this.posts) st.bloomNode?.setResolutionScale?.(0.5 / Math.max(0.25, s));
  }

  // matriz local (asset k, left/top) → Matrix4 para meshes de la imagen.
  // Chrome pinta un <img> en su caja de layout ajustada a píxeles (ancho y alto redondeados en el
  // espacio de layout = px CSS × zoom × devicePixelRatio); la transformación CSS no se redondea.
  // Copiamos ese redondeo para que la imagen GPU caiga exactamente donde la dibuja el DOM.
  static layoutMatrix(m, L, snap) {
    const aw = L.W / L.k;
    const ah = L.H / L.k;
    const kx = Math.round(L.W * snap) / snap / aw;
    const ky = Math.round(L.H * snap) / snap / ah;
    m.set(kx, 0, 0, L.left, 0, ky, 0, L.top, 0, 0, 1, 0, 0, 0, 0, 1);
  }

  // La opacidad de la caja (entrada/salida fade, pop…) sobre un canvas compuesto obliga a Chrome a
  // crear una superficie intermedia y re-muestrear todo (se ve borroso). La repartimos entre los
  // hijos de la caja, que no se pisan: borde y sombra con alfa, fondo transparente, cada hijo con su opacidad.
  distributeOpacity() {
    const box = this.info.box;
    const st = box.style;
    if (!this.boxOrig) this.boxOrig = { borderColor: st.borderColor, boxShadow: st.boxShadow, background: st.background };
    // la viñeta escribe style.opacity en cada update; si está vacío ya lo repartimos en este cuadro
    const op = st.opacity === '' ? (this.lastOp ?? 1) : parseFloat(st.opacity);
    st.opacity = '';
    st.background = 'transparent';
    const k = Number.isFinite(op) ? Math.max(0, Math.min(1, op)) : 1;
    if (k !== this.lastOp) {
      this.lastOp = k;
      st.borderColor = withAlpha(this.boxOrig.borderColor, k);
      st.boxShadow = this.boxOrig.boxShadow === 'none' ? 'none' : this.boxOrig.boxShadow.replace(/rgba?\([^)]*\)/g, (c) => withAlpha(c, k));
      for (const ch of box.children) ch.style.opacity = k === 1 ? '' : String(k);
      // el canvas NO lleva opacity CSS (bajo un recorte rotado Chrome lo re-muestrearía): va en el shader
      this.u.opacity.value = k;
    }
  }

  // clip-path: inset(t r b l) de la caja (entradas wipe) → rect local del padding-box
  updateClip() {
    const box = this.info.box;
    const [iw, ih] = this.info.inner;
    const b = (box.offsetWidth - iw) / 2 || 0;
    const bw = iw + 2 * b;
    const bh = ih + 2 * b;
    let [x0, y0, x1, y1] = [0, 0, iw, ih];
    const m = /inset\(([^)]*)\)/.exec(box.style.clipPath || '');
    if (m) {
      const v = m[1].trim().split(/\s+/).map((s) => ({ n: parseFloat(s) || 0, pct: s.endsWith('%') }));
      const [t, r, bo, l] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
      const px = (x, ref) => (x.pct ? (x.n / 100) * ref : x.n);
      x0 = Math.max(x0, px(l, bw) - b);
      y0 = Math.max(y0, px(t, bh) - b);
      x1 = Math.min(x1, bw - px(r, bw) - b);
      y1 = Math.min(y1, bh - px(bo, bh) - b);
    }
    this.u.clip.value.set(x0, y0, Math.max(x0, x1), Math.max(y0, y1));
    const rad = parseFloat(box.style.borderRadius) || 0;
    this.u.radius.value = Math.max(0, Math.min(rad - b, (x1 - x0) / 2, (y1 - y0) / 2));
  }

  render() {
    if (!this.renderer || !this.pipeline || this.failed) return;
    this.resize();
    const info = this.info;
    this.distributeOpacity();
    this.updateClip();
    const M = matrixToFrame(info.box, this.frameEl);
    const det = M.a * M.d - M.b * M.c;
    if (!(Math.abs(det) > 1e-8)) {
      this.canvas.style.display = 'none';
      return;
    }
    const inv = M.inverse();
    // el canvas vive en el holder de la viñeta: su transformación es la inversa de holder→cuadro
    const Mh = matrixToFrame(info.box.parentElement, this.frameEl);
    const invH = Mh.inverse();
    this.canvas.style.transform = `matrix(${invH.a},${invH.b},${invH.c},${invH.d},${invH.e},${invH.f})`;
    if (this.canvas.style.display) this.canvas.style.display = '';
    if (!this.active) {
      this.active = true;
      if (this.mode === 'full') {
        info.media.style.visibility = 'hidden';
        for (const o of info.overlays) o.style.display = 'none';
      }
    }
    // proyección: local → NDC (y hacia abajo); z constante dentro del rango de ambos backends
    const W = this.W;
    const H = this.H;
    const P = this.camera.projectionMatrix;
    P.set((2 * M.a) / W, (2 * M.c) / W, 0, (2 * M.e) / W - 1, (-2 * M.b) / H, (-2 * M.d) / H, 0, 1 - (2 * M.f) / H, 0, 0, 0, 0.5, 0, 0, 0, 1);
    this.camera.projectionMatrixInverse.copy(P).invert();
    const u = this.u;
    u.fwd0.value.set(M.a, M.c, M.e);
    u.fwd1.value.set(M.b, M.d, M.f);
    u.inv0.value.set(inv.a, inv.c, inv.e);
    u.inv1.value.set(inv.b, inv.d, inv.f);
    const lin = Math.sqrt(Math.abs(det));
    u.pxScale.value = lin * this.pixelScale;
    // viñeta por capas: proyección en perspectiva, planos y grupos de VFX los arma el rig
    if (this.rig) {
      this.rig.update(M);
      const draft = !!this.opts.draft?.();
      for (const pg of this.particleGeos) pg.geo.instanceCount = draft ? Math.max(1, Math.ceil(pg.n * 0.35)) : pg.n;
      this.scene.updateMatrixWorld(true);
      this.pipeline.render();
      this.submitted = true;
      return;
    }
    // capas de la imagen
    const view = info.view;
    for (const mm of this.mediaMeshes || []) {
      if (!mm.layer.layout) continue;
      GpuPanel.layoutMatrix(mm.mesh.matrix, mm.layer.layout, this.opts.layoutZoom());
      mm.mesh.matrixWorldNeedsUpdate = true;
      if (mm.tex.isVideoLike && this.video.readyState >= 2) mm.tex.needsUpdate = true;
    }
    // capas de VFX: coordenadas de página → local, con parallax según profundidad
    const [ox, oy] = info.origin;
    const asset = info.asset;
    const L0 = asset && view ? layerLayout(asset, info.crop, info.inner[0], info.inner[1], view, 0) : null;
    for (const name of ['back', 'mid', 'front', 'screen']) {
      const g = this.groups[name];
      let k = 1;
      let tx = -ox;
      let ty = -oy;
      if (L0 && name !== 'screen') {
        const Ld = layerLayout(asset, info.crop, info.inner[0], info.inner[1], view, VFX_LAYER_DEPTH[name]);
        k = Ld.k / L0.k;
        // local' = Ld.left + (page - origin - L0.left) * k
        tx = Ld.left - (ox + L0.left) * k;
        ty = Ld.top - (oy + L0.top) * k;
      }
      g.matrix.set(k, 0, 0, tx, 0, k, 0, ty, 0, 0, 1, 0, 0, 0, 0, 1);
      if (name === 'back') this._backT = [tx, ty];
      const bt = name === 'screen' ? [tx, ty] : this._backT;
      this.layerBase[name].value.set(k, tx - bt[0], ty - bt[1]);
      g.matrixWorldNeedsUpdate = true;
      this.layerPx[name].value = k * u.pxScale.value;
    }
    // orden de dibujo por capa: three toma el renderOrder del Group más cercano como groupOrder,
    // así que todo Group anidado dentro de una capa hereda el orden de la capa
    for (const [name, g] of Object.entries(this.groups)) {
      const ord = LAYER_ORDER[name];
      g.traverse((o) => {
        if (o.isGroup) o.renderOrder = ord;
      });
    }
    // modo borrador (solo preview): menos partículas
    const draft = !!this.opts.draft?.();
    for (const pg of this.particleGeos) pg.geo.instanceCount = draft ? Math.max(1, Math.ceil(pg.n * 0.35)) : pg.n;
    this.scene.updateMatrixWorld(true);
    this.pipeline.render();
    this.submitted = true;
  }

  async finish() {
    if (!this.renderer || this.failed || !this.submitted) return;
    this.submitted = false;
    const be = this.renderer.backend;
    if (be.isWebGPUBackend) await be.device.queue.onSubmittedWorkDone();
    else {
      const gl = be.gl;
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      await new Promise((res) => {
        const poll = () => {
          const r = gl.clientWaitSync(sync, 0, 0);
          if (r === gl.TIMEOUT_EXPIRED) setTimeout(poll, 1);
          else {
            gl.deleteSync(sync);
            res();
          }
        };
        poll();
      });
    }
  }

  dispose() {
    this.pipeline?.dispose();
    this.scene.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        o.material?.dispose();
      }
    });
    for (const t of this.textures || []) t.dispose();
    this.renderer?.dispose();
    this.canvas.remove();
  }

  // API ctx.gpu para un clip VFX que apunta a esta viñeta
  vfxApi(ctx, clipRuntime) {
    const panel = this;
    const time = uniform(0);
    const enabled = uniform(0);
    const own = [];
    // en una viñeta por capas cada clip tiene sus propias capas (profundidad por between/z)
    const key = (name) => (panel.rig ? panel.rig.slot(name, ctx).key : name);
    const api = {
      THREE,
      TSL,
      fx,
      backend: () => panel.backend || null,
      target: panel.clipId,
      mode: panel.mode,
      time,
      enabled,
      pxScale: panel.u.pxScale,
      uniform: (v) => uniform(v),
      layer(name = 'mid') {
        const g = panel.layerGroup(name, ctx);
        own.push(g);
        g.userData.layer = name;
        return g;
      },
      screen() {
        return api.layer('screen');
      },
      // tamaño mínimo/antialias: px de dispositivo por px de página en esa capa
      layerPx: (name) => panel.layerPx[key(name)],
      // (P) → P en px de página del fondo: para máscaras que tienen que quedar fijas al dibujo de la viñeta
      toBase: (name) => (P) => P.mul(panel.layerBase[key(name)].x).add(panel.layerBase[key(name)].yz),
      material: makeMaterial,
      particles(spec, layerName = 'mid') {
        const g = api.layer(layerName);
        const parts = makeParticles({ time, pxScale: panel.layerPx[key(layerName)] }, { seed: ctx.seed, ...spec });
        g.add(parts);
        panel.particleGeos.push(parts.userData.particles);
        return parts;
      },
      // pase de post sobre la viñeta. fn(io) → vec4. io: { color, sample(uv), uv, pagePos, localPos,
      // pageToUv(P), pageDeltaToUv(d), pxScale, panelTexture }. sample: true si muestrea en otro uv.
      post(fn, { sample = false, order = 0 } = {}) {
        if (panel.mode !== 'full') throw new Error('post necesita la viñeta en modo GPU completo');
        const st = { fn, sample, order, enabled };
        panel.addPost(st);
        return st;
      },
      bloom({ strength = 1, radius = 0.4, threshold = 0.8, order = 100 } = {}) {
        const st = { bloom: { strength: uniform(strength), radius: uniform(radius), threshold: uniform(threshold) }, order, enabled };
        panel.addPost(st);
        return st.bloom;
      },
      // textura de la viñeta ANTES de los pases de post (solo usable dentro de un post)
      panelTexture: () => panel.scenePass?.getTextureNode() || null,
      randoms(n, salt = 0) {
        const r = mulberry32((ctx.seed ^ Math.imul(salt + 1, 2654435761)) >>> 0);
        return Float32Array.from({ length: n }, () => r());
      },
    };
    clipRuntime.gpuOwn = own;
    clipRuntime.gpuTime = time;
    clipRuntime.gpuEnabled = enabled;
    return api;
  }
}
