// Viñeta por capas en GPU: cada capa del PSD es un plano real a distancia Z, visto por una cámara en
// perspectiva. Ver "Viñetas por capas" en references/scene-format.md.
//
// Espacio del mundo: px del lienzo del asset (x a la derecha, y hacia abajo) y z hacia adentro de la escena.
// El plano focal (z = 0) es la página: lo que está ahí se ve EXACTAMENTE como en 2D (globos, textos, y la
// recomposición del PSD en reposo). Cada plano a distancia Z se agranda (D0+Z)/D0 alrededor del centro de la
// cámara en reposo C0, así en reposo proyecta justo a su posición y tamaño en píxeles.
//
// Cámara: la cámara 2D del player (clips camera/dolly/shake…, y el ken burns de la viñeta) sigue siendo la
// del DOM —la caja, los globos y las onomatopeyas se mueven igual que siempre— y de ella se deriva el
// centro de proyección 3D: el punto del lienzo que cae en el centro del cuadro es el eje óptico y el zoom se
// vuelve distancia (D = D0 · s0/s, dolly real). Proyectar desde ese centro sobre el plano focal y después
// aplicar la transformación 2D es exactamente una cámara estenopeica paralela al plano: el plano focal queda
// igual que con la cámara 2D y los demás tienen parallax real (el fondo se mueve menos, lo cercano más).
// La entrada/salida y el tilt de la caja NO mueven la cámara 3D (son de la tarjeta, no del ojo).
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { layerState, vfxPlacement, dofOf, depthToZ } from '../layers.js';

const { Fn, uniform, vec2, vec4, float, texture: textureNode, uv, positionWorld, select, clamp, max, step } = TSL;

// campo visual vertical de la cámara en reposo (solo importa para la órbita: el parallax por paneo y
// dolly depende de Z/D0, que ya es adimensional)
export const FOV_DEG = 30;
const FOCAL_K = 1 / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
const RO_BASE = 100;
// span de la escala depth que usa el DOF para normalizar (0..2 → Z de 0.6 a −0.6)
const DEPTHSPAN = 1.2;
const RO_STEP = 10;

// afín 2D (DOMMatrix) → aplica a un punto
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

export class LayersRig {
  constructor(panel, makeMaterial, rectsGeometry) {
    this.panel = panel;
    this.info = panel.info;
    this.lx = panel.info.lx;
    this.makeMaterial = makeMaterial;
    this.rectsGeometry = rectsGeometry;
    this.items = [];
    this.slots = new Map(); // key → { group, placement, screen }
    this.u = {
      cam: uniform(new THREE.Vector3(0, 0, -1000)), // centro de proyección (x, y, -D)
      c0: uniform(new THREE.Vector2(0, 0)),
      d0: uniform(1000),
    };
    this.rest = null;
  }

  // ---- reposo: cámara que encuadra la viñeta entera (sin ken burns) ----
  restCamera() {
    if (this.rest) return this.rest;
    const { W, H } = this.panel;
    const [rx, ry, rw, rh] = this.lx.rect;
    const vw = Math.max(rw, rh * (W / H));
    const sc = W / vw;
    const cam0 = new DOMMatrix().translate(W / 2, H / 2).scale(sc).translate(-(rx + rw / 2), -(ry + rh / 2));
    const L0 = this.lx.layout0;
    const [ox, oy] = this.info.origin;
    const G0 = cam0.multiply(new DOMMatrix([L0.k, 0, 0, L0.k, ox + L0.left, oy + L0.top]));
    const s0 = Math.sqrt(Math.abs(G0.a * G0.d - G0.b * G0.c));
    const c0 = apply(G0.inverse(), W / 2, H / 2);
    const D0 = (FOCAL_K * H) / s0; // px del lienzo
    this.rest = { cam0, G0, s0, c0, D0 };
    this.u.c0.value.set(c0[0], c0[1]);
    this.u.d0.value = D0;
    return this.rest;
  }

  // textura sin premultiplicar y sin conversión de color, lista cuando termina de decodificar
  loadExact(url) {
    const panel = this.panel;
    const tex = new THREE.Texture();
    tex.flipY = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.premultiplyAlpha = false;
    tex.generateMipmaps = true;
    tex.minFilter = this.info.pixelated ? THREE.NearestMipmapNearestFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = this.info.pixelated ? THREE.NearestFilter : THREE.LinearFilter;
    tex.anisotropy = panel.maxAniso;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    panel.texturesLoading.push(
      fetch(url)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' }))
        .then(
          (bmp) => {
            tex.image = bmp;
            tex.needsUpdate = true;
          },
          (e) => console.warn('[comic] capa', url, e),
        ),
    );
    return tex;
  }

  build() {
    const panel = this.panel;
    const resolved = this.lx.resolved;
    const byId = Object.fromEntries(resolved.map((r) => [r.id, r]));
    const dof = dofOf(this.lx.params.dof);
    const texOf = new Map();
    // Las capas se decodifican SIN premultiplicar (createImageBitmap premultiplyAlpha 'none'): un <img> de
    // Chrome guarda el alfa premultiplicado y truncado, y en los bordes suaves eso corre el color 1/255.
    // El shader premultiplica en float; con el destino de 8 bits cada capa se redondea como en Photoshop.
    const tex = (url) => {
      if (!texOf.has(url)) texOf.set(url, this.loadExact(url));
      return texOf.get(url);
    };
    const sampleP = (t, q) => {
      const c = textureNode(t, q);
      return vec4(c.rgb.mul(c.a), c.a);
    };
    for (const r of resolved) {
      if (r.hidden) continue;
      const t = tex(this.lx.url(r.file));
      const u = {
        opacity: uniform(1),
        inset: uniform(new THREE.Vector4(0, 0, 0, 0)),
        blur: uniform(new THREE.Vector2(0, 0)),
        rect: uniform(new THREE.Vector4(r.x, r.y, r.w, r.h)),
      };
      // recorte a la ventana de su viñeta (clipTo): máscara en el plano del fondo
      let clip = null;
      const bg = r.clipTo ? byId[r.clipTo] : null;
      if (bg && bg !== r) {
        const cm = r.clipMask;
        clip = {
          tex: cm ? tex(this.lx.url(cm.file)) : tex(this.lx.url(bg.file)),
          channel: cm ? 'r' : 'a',
          rect: uniform(cm ? new THREE.Vector4(cm.x, cm.y, cm.w, cm.h) : new THREE.Vector4(bg.x, bg.y, bg.w, bg.h)),
          zbg: uniform(0),
          bg,
        };
      }
      const blurTaps = dof.amount > 0 && r.role !== 'text';
      const frag = Fn(() => {
        const q = uv();
        let col;
        if (blurTaps) {
          // disco de 13 muestras (centro + 2 anillos); radio en uv por uniform
          const offs = [[0, 0]];
          for (let i = 0; i < 8; i++) offs.push([Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);
          for (let i = 0; i < 4; i++) offs.push([0.5 * Math.cos(((i + 0.5) * Math.PI) / 2), 0.5 * Math.sin(((i + 0.5) * Math.PI) / 2)]);
          col = vec4(0);
          for (const [ox, oy] of offs) col = col.add(sampleP(t, q.add(vec2(ox, oy).mul(u.blur))));
          col = col.div(offs.length);
        } else col = sampleP(t, q);
        const ins = u.inset;
        const inside = step(ins.x, q.x).mul(step(q.x, float(1).sub(ins.z))).mul(step(ins.y, q.y)).mul(step(q.y, float(1).sub(ins.w)));
        let k = u.opacity.mul(inside);
        if (clip) {
          const C = this.u.cam;
          const c0 = this.u.c0;
          const d0 = this.u.d0;
          const Pw = positionWorld;
          const tt = clip.zbg.sub(C.z).div(Pw.z.sub(C.z));
          const Q = C.xy.add(Pw.xy.sub(C.xy).mul(tt));
          const a = c0.add(Q.sub(c0).mul(d0.div(d0.add(clip.zbg))));
          const mr = clip.rect;
          const win = (P) => {
            const m = P.sub(mr.xy).div(mr.zw);
            const inM = step(0, m.x).mul(step(m.x, 1)).mul(step(0, m.y)).mul(step(m.y, 1));
            return textureNode(clip.tex, m)[clip.channel].mul(inM);
          };
          const wRay = win(a);
          const wRest = win(u.rect.xy.add(q.mul(u.rect.zw)));
          // en reposo wRay = wRest → 1 (paridad exacta); lo que en reposo ya estaba fuera de la ventana queda libre
          const m = select(wRest.lessThan(0.004), float(1), clamp(wRay.div(max(wRest, 1e-4)), 0, 1));
          k = k.mul(m);
        }
        return col.mul(k);
      })();
      const mat = this.makeMaterial({ fragment: frag });
      const mesh = new THREE.Mesh(this.rectsGeometry([[0, 0, r.w, r.h]], r.w, r.h), mat);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.renderOrder = RO_BASE + RO_STEP * r.index;
      group.add(mesh);
      panel.scene.add(group);
      this.items.push({ r, mesh, group, u, clip, tex: t });
    }
    panel.textures = [...texOf.values()];
  }

  // ---- VFX dentro de la viñeta de capas: grupo a la profundidad pedida (layer, between o z) ----
  slotKey(name, ctx) {
    return `${ctx?.clip?.id || '_'}|${name}`;
  }

  slot(name, ctx) {
    const key = this.slotKey(name, ctx);
    if (this.slots.has(key)) return { key, ...this.slots.get(key) };
    const params = ctx?.params || {};
    const placement = vfxPlacement(this.lx.resolved, { layer: name, between: params.between, z: typeof params.z === 'number' ? params.z : null }, this.lx.params.depthScale ?? 1);
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.renderOrder = placement.screen ? 1e6 : RO_BASE + RO_STEP * placement.order;
    this.panel.scene.add(group);
    this.panel.layerPx[key] = uniform(1);
    this.panel.layerBase[key] = uniform(new THREE.Vector3(1, 0, 0));
    const s = { group, placement };
    this.slots.set(key, s);
    return { key, ...s };
  }

  layerGroup(name, ctx) {
    const g = new THREE.Group();
    this.slot(name, ctx).group.add(g);
    return g;
  }

  // ---- por cuadro ----
  // M: DOMMatrix padding-box de la caja → cuadro (incluye cámara 2D, tilt y entrada de la caja)
  update(M) {
    const panel = this.panel;
    const { W, H } = panel;
    const lx = this.lx;
    const rest = this.restCamera();
    const { c0, D0, s0 } = rest;
    const L = lx.layout;
    const [ox, oy] = this.info.origin;
    const Lm = new DOMMatrix([L.k, 0, 0, L.k, L.left, L.top]);
    const A = M.multiply(Lm); // lienzo (plano focal) → cuadro
    // cámara 3D a partir de la cámara 2D (sin la caja): G = cámara · origen · ken burns
    const cam = panel.sceneRef.cam || rest.cam0;
    const G = cam.multiply(new DOMMatrix([L.k, 0, 0, L.k, ox + L.left, oy + L.top]));
    const detG = G.a * G.d - G.b * G.c;
    const s = Math.sqrt(Math.abs(detG)) || s0;
    const C = Math.abs(detG) > 1e-12 ? apply(G.inverse(), W / 2, H / 2) : c0;
    const ds = lx.params.depthScale ?? 1;
    const vis = this.items.filter((it) => !it.r.hidden);
    const zmin = Math.min(0, ...vis.map((it) => it.r.Z), ...[...this.slots.values()].map((sl) => sl.placement.Z || 0));
    let D = (D0 * s0) / s;
    D = Math.max(D, D0 * (-zmin + 0.15));
    // órbita: la cámara se corre sobre un arco alrededor del punto enfocado (el plano focal no se mueve)
    const [yaw, pitch] = lx.orbit || [0, 0];
    const Cx = C[0] + D * Math.tan((yaw * Math.PI) / 180);
    const Cy = C[1] + D * Math.tan((pitch * Math.PI) / 180);
    this.u.cam.value.set(Cx, Cy, -D);
    // proyección: (X,Y,Z) → centro (Cx,Cy,−D) sobre z=0 → A → NDC
    const x = [1, 0, Cx / D, 0];
    const y = [0, 1, Cy / D, 0];
    const w = [0, 0, 1 / D, 1];
    const comb = (ka, kb, kc) => x.map((_, i) => ka * x[i] + kb * y[i] + kc * w[i]);
    const rX = comb((2 * A.a) / W, (2 * A.c) / W, (2 * A.e) / W - 1);
    const rY = comb((-2 * A.b) / H, (-2 * A.d) / H, 1 - (2 * A.f) / H);
    const rZ = w.map((v) => 0.5 * v);
    const P = panel.camera.projectionMatrix;
    P.set(...rX, ...rY, ...rZ, ...w);
    panel.camera.projectionMatrixInverse.copy(P).invert();
    // capas
    const dof = dofOf(lx.params.dof);
    const pxs = panel.u.pxScale.value; // px de dispositivo por px local
    const devPerAsset = pxs * L.k;
    const states = lx.states || [];
    for (const it of this.items) {
      const r = it.r;
      const st = states[r.index] || { visible: true, opacity: 1, m: [1, 0, 0, 1, 0, 0], clip: [0, 0, 0, 0] };
      it.group.visible = !!st.visible;
      if (!st.visible) continue;
      it.u.opacity.value = st.opacity;
      it.u.inset.value.set(...st.clip);
      const g = 1 + r.Z;
      const Zw = r.Z * D0;
      const [a, b, c, d, e, f] = st.m;
      // geometría local (0..w, 0..h) → lienzo: m · T(x, y); después el agrandado por profundidad alrededor de C0
      const E = a * r.x + c * r.y + e;
      const F = b * r.x + d * r.y + f;
      it.mesh.matrix.set(g * a, g * c, 0, g * E + c0[0] * (1 - g), g * b, g * d, 0, g * F + c0[1] * (1 - g), 0, 0, 1, Zw, 0, 0, 0, 1);
      it.mesh.matrixWorldNeedsUpdate = true;
      if (it.clip) it.clip.zbg.value = it.clip.bg.Z * D0;
      if (dof.amount > 0 && r.role !== 'text') {
        // radio en px del cuadro ∝ distancia (en la escala depth) al plano de foco
        const focusZ = depthToZ(dof.focus, ds);
        const rpx = dof.amount * 18 * Math.abs(r.Z - focusZ) / Math.max(0.05, DEPTHSPAN);
        const devPerTex = devPerAsset * g * (D / (D + Zw));
        const texPx = (rpx * panel.pixelScale) / Math.max(1e-6, devPerTex);
        it.u.blur.value.set(texPx / r.w, texPx / r.h);
      }
    }
    // VFX: grupos en px de página → mundo a su profundidad
    const L0 = lx.layout0;
    const bgMain = lx.resolved.find((r) => r.role === 'background' && !r.global && !r.hidden) || null;
    const Zb = bgMain ? bgMain.Z * D0 : 0;
    for (const [key, sl] of this.slots) {
      const m = sl.group.matrix;
      if (sl.placement.screen) {
        // encima de todo, sin parallax: página → lienzo con el layout actual, en el plano focal
        m.set(1 / L.k, 0, 0, -(ox + L.left) / L.k, 0, 1 / L.k, 0, -(oy + L.top) / L.k, 0, 0, 1, 0, 0, 0, 0, 1);
        panel.layerPx[key].value = pxs;
        panel.layerBase[key].value.set(1, 0, 0);
      } else {
        const Zu = sl.placement.Z;
        const g = 1 + Zu;
        const Zw = Zu * D0;
        const kk = g / L0.k;
        const tx = c0[0] * (1 - g) - (ox + L0.left) * kk;
        const ty = c0[1] * (1 - g) - (oy + L0.top) * kk;
        m.set(kk, 0, 0, tx, 0, kk, 0, ty, 0, 0, 1, Zw, 0, 0, 0, 1);
        panel.layerPx[key].value = pxs * (L.k / L0.k) * g * (D / (D + Zw));
        // toBase: px de página de este grupo → px de página del plano del fondo principal (fijo al dibujo)
        const toBg = (Px, Py) => {
          const Xw = kk * Px + tx;
          const Yw = kk * Py + ty;
          const t = (Zb + D) / (Zw + D);
          const Qx = Cx + (Xw - Cx) * t;
          const Qy = Cy + (Yw - Cy) * t;
          const ab = D0 / (D0 + Zb);
          return [ox + L0.left + L0.k * (c0[0] + (Qx - c0[0]) * ab), oy + L0.top + L0.k * (c0[1] + (Qy - c0[1]) * ab)];
        };
        const p0 = toBg(0, 0);
        const p1 = toBg(1, 0);
        panel.layerBase[key].value.set(p1[0] - p0[0], p0[0], p0[1]);
      }
      sl.group.matrixWorldNeedsUpdate = true;
      const ord = sl.group.renderOrder;
      sl.group.traverse((o) => {
        if (o.isGroup) o.renderOrder = ord;
      });
    }
  }
}
