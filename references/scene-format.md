# Formato de `scene.json`

Es la única fuente de verdad. El panel, el export y el generador leen y escriben este archivo. El catálogo de presets con todos sus params sale de `comic presets` (o de `.comic/catalog.json`).

## Estructura

```
meta     { title, width: 1920, height: 1080, fps: 24, background, generatorModel: "sonnet", maxVariants: 3, generatorConcurrency: 3,
           guideModel?: "sonnet", direction?: { destino, duracion, tono, textos, camara, transiciones, profundidad, vfx, look, final, … } }
         direction: decisiones del modo guiado (claves libres, valores en texto, con las palabras del usuario).
         Cada escena puede tener también su propio `direction` (mismo formato) al lado de `variants`.
         Cambiar la dirección no desactualiza aprobaciones: guía las variantes que se generen después.
assets   { <assetId>: Asset }
scenes   [ Scene ]           ← en orden de reproducción
```

**Asset** (lo crea `comic ingest`, vos agregás lo semántico):

```json
{ "file": "assets/pelea.mp4", "type": "video", "w": 640, "h": 448, "duration": 40.5, "fps": 30,
  "proxy": "assets/pelea.proxy.webm", "contactSheet": ".comic/frames/pelea_sheet.jpg", "contactTimes": [1.27, 3.8],
  "description": "El robot patea al ninja; impacto a 3.8s, K.O. a 28.9s",
  "focus": [0.6, 0.45], "panels": [[0,56,960,640]], "cutout": "assets/x.cutout.png" }
```

- `description`: lo que ves en el material, más los tiempos clave en los videos. Los generadores headless dependen de esto.
- `focus`: punto de interés `[fx, fy]` de 0 a 1. Las viñetas lo usan para centrar el cover.
- `panels`: recortes `[x,y,w,h]` en píxeles del asset, para páginas de cómic con varias viñetas (salen de `comic panels`, corregidos a ojo).

**Scene** (un holder con variantes):

```json
{ "id": "s3", "title": "La patada", "active": "v2",
  "variants": [ SceneVariant ] }
```

**SceneVariant**:

```json
{ "id": "v1", "status": "draft", "summary": "…", "parent": null, "instruction": null, "note": null, "rejection": null,
  "duration": 4, "stage": { "w": 1920, "h": 1080, "background": "#f4efe3" },
  "transition": { "preset": "slash", "duration": 0.4, "ease": "easeOut", "params": {} },
  "clips": [ Clip ] }
```

- `stage` es la **página** donde se ubican viñetas, globos y onomatopeyas, en píxeles. Por defecto mide lo mismo que el cuadro. Si hacés una página más grande (por ejemplo 1920×2400), la cámara la recorre.
- `transition` es la entrada desde la escena anterior y se **solapa** con su cola. En la primera escena se ignora.

**Clip** (holder con variantes) y **ClipVariant**:

```json
{ "id": "paf", "track": "ono", "label": "¡PAF!", "active": "v1",
  "variants": [ { "id": "v1", "status": "draft", "preset": "ono", "start": 1.2, "duration": 1.8, "ease": null, "params": { … } } ] }
```

- `track` puede ser `camera`, `panel`, `vfx`, `fx`, `bubble` u `ono`. El preset tiene que ser del mismo kind.
- `start` y `duration` son segundos relativos a la escena.

**Estados:** `draft`, `approved` (una por holder como máximo), `rejected` (con `rejection` obligatorio desde el panel) y `hidden`. `active` es lo que se ve y se exporta. `approvedHash` marca una aprobación como **desactualizada** si después cambió el contenido. Las acciones de revisión se hacen desde el panel o se editan a mano respetando estas reglas. El historial queda en `history.jsonl`.

## Coordenadas

| Qué | Espacio |
|---|---|
| `panel.rect`, `bubble.box`, `bubble.tail`, `ono.at`, `camera.keys[].cx/cy/w` | página (`stage`), en px |
| `panel.crop` | px del asset original |
| `panel.focus`, `kenBurns.fx/fy` | 0 a 1 dentro del recorte |
| `speedLines`, `focusLines.center`, `flash`, `vignette` | pantalla (cuadro de salida), en px |
| VFX `anchor`, `ctx.gpu.layer()` | página (`stage`), en px — las mismas que `panel.rect` |

## Efectos custom

Un archivo `effects/<id>.js` en el proyecto, con el mismo contrato que los built-in (ver `src/player/presets.js`):

```js
export default {
  id: 'miEfecto',            // tiene que coincidir con el nombre del archivo
  kind: 'fx',                // camera | panel | fx | bubble | ono | transition | filter
  label: 'Mi efecto',
  params: [{ key: 'color', label: 'Color', type: 'color', default: '#fff' }],
  build(ctx) {
    // ctx: params, duration, stage, frame, rand() con semilla, hashRand(n), easing(spec, dur), mix,
    //      mount(el, 'page'|'screen'), asset(id), assetUrl(a), panelRect(clipId), defs (<defs> SVG), uid(s)
    const el = document.createElement('div');
    ctx.mount(el, 'screen');
    return { update(t) { /* t = segundos locales del clip; SOLO función de t */ } };
  },
};
```

Regla de oro: `update(t)` depende **solo** de `t`, de `params` y de `ctx.rand`/`ctx.hashRand` con semilla. Nada de `Math.random()`, `Date.now()`, animaciones CSS ni `setTimeout`. Si no, el export no coincide con el preview.

## VFX (pista `vfx`, GPU)

Efectos con three.js (`WebGPURenderer`, cae solo a WebGL2) dibujados **dentro de una viñeta**. Presets built-in: `snow`, `sparks`, `burst` (partículas), `fog` (niebla), `shockwave`, `heat` (deformación), `impactFlash`, `glow` (pases de pantalla). Params comunes:

| param | tipo | qué hace |
|---|---|---|
| `target` | `clipRef` | clip id de la viñeta; vacío = la primera viñeta de la escena |
| `anchor` | `anchor` `[x, y]` | punto en px de página (como `rect`); vacío = centro de la viñeta |
| `layer` | `back` \| `mid` \| `front` | back = detrás del fondo, mid = entre el fondo (`bgfill`) y el recorte fg, front = delante de todo (incluso depthLock) |
| `style` | `glow` \| `ink` | glow = aditivo con halo; ink = contorno de tinta (dos pasadas) y relleno plano |
| `stepFps` | número | 0 = continuo; 12 = animado "de a dos" (t cuantizado) |
| `intensity` | número | multiplicador general |
| `region` | `[[x,y],…]` o `[x,y,w,h]` | (`snow`, `fog`) polígono en px de página fuera del cual el efecto no se dibuja, con borde suave `regionFeather`. Va fijo al dibujo de la viñeta aunque la capa tenga parallax: sirve para que la nieve o la niebla no pisen el borde negro o la canaleta de una página a sangre |

**Niebla (`fog`).** Bancos de niebla procedurales: fbm de ruido Perlin (4 octavas) con deformación de dominio, en `layers` láminas (1..4) con parallax propio: las lejanas más chicas, más altas y lentas; las cercanas más grandes, pegadas al piso y rápidas. Ocupa una banda baja de la viñeta (`height`, 0..1 desde abajo) con borde ondulado. Params: `density` (0..1), `color`, `height`, `speed` (viento en px/s, negativo = izquierda), `scale` (px de los bancos), `softness`, `evolve` (cuánto cambia la forma por segundo), `fade`, `avoid` (`[[x,y,w,h],…]` zonas despejadas: caras, globos), `avoidFeather`, `region`. `style: glow` = normal con un 25 % aditivo (luz dispersa); `style: ink` = `inkLevels` bandas posterizadas con filete de tinta. En `mid` queda detrás del recorte 2.5D y del depthLock; en `front` tapa todo, así que ahí usá `avoid`. Es función pura de `t` (y de la semilla del clip).

**Modo GPU de la viñeta.** Si una viñeta tiene un VFX en capa `mid`/`back`, un VFX de deformación o de pantalla (`shockwave`, `heat`, `impactFlash`, `glow`) o `params.gpu: true`, three dibuja su contenido completo (fondo, recorte, depthLock, ken burns, filtros) con los mismos números que el DOM (`src/player/media.js`); la caja (borde, radio, sombra, tilt, entrada/salida) sigue siendo CSS. Si solo tiene VFX `front`, el canvas va encima de la imagen DOM. Las viñetas sin VFX no cambian. Filtros soportados en GPU: `css` (brightness, contrast, saturate, grayscale, sepia, invert, hue-rotate), `posterize`, `chroma`, `paper`, `halftone`; `ink` y los custom se ignoran (lo avisa `comic check`). En la GPU los filtros se aplican también a las partículas mid/back/front.

Capas y parallax: los grupos de `ctx.gpu.layer()` están en px de página y se escalan con el empuje 2.5D según su profundidad (back 0, mid 0.5, front 1.25; el recorte fg es 1.1). La cámara y las transiciones son las del DOM.

**Export:** `seek(t)` espera a la GPU (`onSubmittedWorkDone` / fence de WebGL) antes de capturar y `render` verifica con ffprobe que el archivo tiene exactamente los cuadros pedidos. Si three cae a WebGL2 el export avisa "VFX con WebGL2 (sin WebGPU)". `node test/gpu-parity.mjs` compara la misma viñeta en DOM y en GPU a 1080p y 4K.

### Contrato de un VFX

Built-in en `src/player/vfx/`, o custom en `effects/<id>.vfx.js` (mismo contrato; el sufijo `.vfx.js` es obligatorio):

```js
export default {
  id: 'miVfx', kind: 'vfx', label: 'Mi VFX', gpu: true,
  distort: false,   // true si muestrea la viñeta (fuerza modo GPU completo); también `post: true`
  params: [ { key: 'target', type: 'clipRef', default: null }, { key: 'anchor', type: 'anchor', default: null },
            { key: 'layer', type: 'select', options: ['back','mid','front'], default: 'mid' }, … ],
  build(ctx) {
    const { THREE, TSL, fx } = ctx.gpu;
    const g = ctx.gpu.layer(ctx.params.layer);        // THREE.Group en px de página
    g.add(new THREE.Mesh(geo, ctx.gpu.material({ fragment: TSL.vec4(rgb.mul(a), a) })));
    return { update(t) { /* uniforms que dependan de t; SOLO función de t */ } };
  },
};
```

`ctx` trae lo de siempre (params, duration, stage, fps, seed, rand, hashRand, panelRect, …) más `ctx.gpu`:

| miembro | qué es |
|---|---|
| `THREE`, `TSL` | los módulos `three/webgpu` y `three/tsl` (usá estos, no importes three aparte) |
| `target` | clip id de la viñeta destino |
| `mode` | `'full'` \| `'overlay'` |
| `time` | uniform float: t local del clip (ya cuantizado por `stepFps`); lo actualiza el player |
| `enabled` | uniform float 0/1: el clip está activo (el efecto puede apagarlo antes, ej. fuera de `at`) |
| `layer(name='mid')` | nuevo `THREE.Group` en px de página dentro de la capa `back`\|`mid`\|`front`\|`screen` (screen = encima de todo, sin parallax). El player lo oculta fuera del clip |
| `screen()` | = `layer('screen')` |
| `layerPx(name)` | uniform: px de dispositivo por px de página en esa capa (para antialias/tamaño mínimo) |
| `toBase(name)` | `(P) → P'`: pasa una posición en px de página de esa capa (con el empuje del parallax) a px de página del fondo; para máscaras que tienen que quedar fijas al dibujo |
| `pxScale` | uniform: px de dispositivo por px local de la viñeta |
| `material({ fragment, position?, blend: 'normal'\|'add' })` | `MeshBasicNodeMaterial` sin depth, doble cara, en **premultiplicado**: `fragment` devuelve `vec4(rgb*a, a)`; en `add` devolvé alfa 0 |
| `particles(spec, layerName)` | partículas analíticas instanciadas. `spec: { count, motion({ r0, r1, t, idx, fx }) → { pos, vel, size, alpha, color }, mask?(P) → float, style: 'glow'\|'ink'\|'soft', blend, shutter, stretch, soft, halo, outline, outlineColor }`. `r0`/`r1` = dos vec4 aleatorios por partícula (mulberry32 en JS). `pos`/`vel` en px de página; se estira según `vel` (motion blur). `mask(P)` (opcional) multiplica el alfa por fragmento, con `P` en px de página de la capa (combinalo con `toBase`) |
| `post(fn, { sample, order })` | pase de post sobre la viñeta (solo modo completo). `fn(io) → vec4` con `io = { color, sample(uv), uv, pagePos, localPos, framePos, pageToUv(P), pageDeltaToUv(d), pxScale, inner, panelTexture }`. `sample: true` si muestrea en otro uv (deformaciones). Se aplica solo mientras `enabled` = 1 |
| `bloom({ strength, radius, threshold, order })` | bloom (BloomNode de three) sobre la viñeta; devuelve `{ strength, radius, threshold }` (uniforms) |
| `panelTexture()` | textura de la viñeta compuesta ANTES de los pases de post (usable solo dentro de `post`) |
| `uniform(v)` | crea un uniform TSL |
| `randoms(n, salt)` | `Float32Array` de n aleatorios con la semilla del clip |
| `fx` | helpers TSL: `hash(uint)` (PCG entero), `hash2(a,b)`, `noise(vec2\|vec3)` (Perlin), `ballistic(p0, v0, g, k, τ) → vec4(pos, vel)` (gravedad + drag lineal, forma cerrada), `pulse(x,a,b)`, `heat(u) → vec3` (temperatura de color) |

Reglas: nada de `Math.random`, `Date.now` ni `fract(sin())`; los aleatorios salen de la semilla (`r0/r1`, `randoms`, `fx.hash`). Todo en función de `t`: `update(t)` puede tocar uniforms, nunca acumular estado.
