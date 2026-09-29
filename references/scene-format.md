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

## Viñetas por capas

Para arte que viene **por capas** de un PSD (PNGs RGBA 1:1 + `scene_layout.json` con `canvas`, árbol de capas con `file`, `z_index`, `position`, `size` y `scenes[i].draw_order`). Cada capa es un **plano 3D real** (three.js, WebGPU o WebGL2) a una distancia propia, visto por una cámara en perspectiva. En reposo la recomposición es la del PSD, píxel a píxel. Cuando la cámara se mueve hay parallax real: el fondo se mueve menos que los personajes y los textos quedan fijos.

```
comic layers <dir> <scene_layout.json> [--exclude margins,…] [--scenes]
```

Copia los PNG a `assets/layers/<escena>/` (las capas de la raíz del PSD, como `black_bkg`, van a `assets/layers/_global/`). Crea un asset por escena del layout, compone `_preview.png` sin guías y deja las máscaras `*.clip.png`. Imprime la tabla de decisiones: rol, depth, clipTo y el porqué de cada uno. Con `--scenes` también agrega una escena por asset: la viñeta ocupa la página, sin borde ni sombra, y la duración sale de los textos. `--exclude` deja afuera las capas cuyo id o nombre contiene alguno de los textos. Hace falta un `comic init` antes.

**Revisión (vos sos el VLM):** mirá la preview y la tabla, y corregí con `params.layers` de la viñeta lo que la heurística erró (o editá el asset).

### Asset `type: 'layers'`

```json
{ "type": "layers", "w": 2176, "h": 1336, "file": "assets/layers/scene_01/_preview.png",
  "layers": [
    { "id": "black_bkg", "name": "black_bkg", "file": "assets/layers/_global/black_bkg.png", "x": -1107, "y": -521, "w": 4391, "h": 2516, "z": 1, "role": "background", "depth": 0, "global": true },
    { "id": "hero", "name": "hero", "file": "assets/layers/scene_01/hero.png", "x": 861, "y": 35, "w": 1193, "h": 667, "z": 4, "role": "character", "depth": 0.875,
      "clipTo": "bkg_top", "clipMask": { "for": "bkg_top", "file": "assets/layers/scene_01/hero.clip.png", "x": 0, "y": 4, "w": 2139, "h": 743 } },
    { "id": "dialog_01", "name": "dialog 01", "file": "…", "x": 724, "y": 431, "w": 756, "h": 203, "z": 9, "role": "text", "depth": 1, "area": 98000 },
    { "id": "ornament", "role": "text", "attachedTo": "caption_box", "…": "…" },
    { "id": "sfx_text", "role": "text", "keepOrder": true, "…": "…" },
    { "id": "margins", "role": "guide", "depth": 0, "global": true, "…": "…" } ],
  "source": { "layout": "/ruta/scene_layout.json", "scene": "PAGE_01", "psd": "x.psd", "preview": "/ruta/previews/PAGE_01.png" } }
```

- `x, y, w, h`: px del lienzo (esquina superior izquierda, pueden ser negativos). `z`: el `z_index` del PSD, que define el orden de dibujo.
- `role`: `background` | `character` | `text` | `fx` | `divider` | `guide`.
- `depth`: escala 0..2, **más alto = más cerca**. 0 es el fondo lejano, 1 el plano focal (la página) y 2 muy cerca. La distancia física al plano focal es `Z = (1 − depth) · 0.6 · depthScale · D0`, con `D0` la distancia de la cámara en reposo.
- `clipTo`: id del fondo contra el que el personaje está cortado. `clipMask` es la ventana precalculada (ver abajo).
- `keepOrder`: el texto no sube arriba de todo porque en el PSD se solapa con algo que va encima.
- `attachedTo`: adorno pegado a un texto. Entra con él.
- `area`: px de alfa. Sirve para estimar el tiempo de lectura. Si sabés el texto, agregá `text: "…"` o `words: n`.

### Roles automáticos (heurística de `comic layers`)

| rol | por nombre | si no | depth por defecto | comportamiento |
|---|---|---|---|---|
| `background` | bkg, background, fondo | cubre >35 % del lienzo con >80 % de alfa | 0 (global) / 0.4 | lejos: se mueve menos |
| `character` | (el resto) | | 0.75 → 1 según el orden (el de más arriba = 1) | medio; puede tener `clipTo` |
| `text` | dialog, rhyme, snif, text, bubble, huh, caption… | adorno con ≥70 % de su alfa sobre un texto | 1 (ignorada) | **fijo en el plano focal**, sin parallax ni DOF, arriba de todo (salvo `keepOrder`) |
| `fx` | lines, vertigo, speed | | 1.15 | al frente |
| `divider` | div, divider, border, gutter | | la del fondo que más toca | pegado a su viñeta |
| `guide` | margins, guide | | — | no se dibuja nunca (para verla, cambiale el rol con un override) |

**clipTo (personajes cortados por el borde de su viñeta).** Por cada personaje y cada fondo de la escena se cuentan los píxeles del contorno alfa que caen sobre el borde del fondo (±2 px), pegados a él por dentro (≤14 px) o escondidos bajo un divisor. Con ≥500 px, o ≥120 px sobre el borde con ≥5 % del contorno, queda `clipTo`. Si no, queda libre (break-out). La ventana (`clipMask`, en el plano del fondo) es el alfa del fondo más los divisores, más lo que el personaje ya dejaba asomar a propósito, engordado 40 px (la cabeza que sobresale, un hombro fuera del cuadro). Así el parallax nunca deja ver un corte, pero tampoco se come los break-outs. En el render, cada fragmento del personaje tira un rayo desde la cámara hasta el plano del fondo y se multiplica por `ventana(rayo) / ventana(reposo)`. En reposo ese cociente da exactamente 1 y la paridad se mantiene. Lo que en reposo ya caía fuera de la ventana queda libre. Si un override apunta `clipTo` a otro fondo, se usa el alfa de ese fondo (sin el agregado de los break-outs).

### Params de la viñeta (preset `panel` con asset de capas)

Siempre se dibuja en modo GPU completo. `rect`, `crop` (px del lienzo), `focus`, `kenBurns`, `border`, `radius`, `tilt`, `shadow`, `enter`/`exit` de la caja y `filters` funcionan igual que siempre. Nuevos:

| param | tipo | qué hace |
|---|---|---|
| `layers` | `{ [idCapa]: { depth?, role?, hidden?, at?, dur?, enter?, exit?, motion?, clipTo? } }` | overrides por capa. `clipTo: null` explícito = libre |
| `depthScale` | número (1) | intensidad global del 3D. 0 = todo plano |
| `orbit` | `{ yaw, pitch, from?: {yaw, pitch}, ease? }` en grados | la cámara recorre un arco alrededor del punto enfocado, de `from` (o 0) a `{yaw, pitch}` a lo largo del clip. El plano focal no se mueve |
| `dof` | número 0..1 o `{ amount, focus }` (0) | desenfoque por distancia al plano de foco (`focus` en la escala depth, por defecto 1). Los textos nunca se desenfocan. Con `dof > 0` la paridad con el PSD deja de ser exacta |
| `autoTiming` | bool (true) | tiempos automáticos: los textos se escalonan en orden de lectura. `false` = todo visible desde el inicio |

**Tiempos por capa**, en segundos locales al clip de la viñeta:
- `at` es cuándo aparece y `dur` cuánto dura (por defecto hasta el fin de la viñeta).
- `enter` y `exit` son los mismos ENTERS de la viñeta (`pop`, `slam`, `slideLeft`, `fade`, `wipeRight`…), como `{preset, duration?, ease?}` o como string. Se aplican alrededor del centro de la capa.
- `motion: { dx, dy, scale, rotate, ease }` es un empujón o deriva a lo largo del `dur`: px del lienzo, factor de escala y grados.

Con `autoTiming`, cada texto sin `at` aparece en orden de lectura (renglones de arriba a abajo, izquierda a derecha) con `pop` de 0.35 s. El primero entra a los 0.5 s y los siguientes cuando termina el tiempo de lectura del anterior: 0.4 s + 0.25 s por palabra, con las palabras sacadas de `text`, `words` o el área de alfa (~7000 px² por palabra), o 0.6 s si no hay datos. Si no entran, se comprimen hasta el 70 % de la viñeta. Personajes, fondos y fx entran con la viñeta.

### Cámara 2D → cámara 3D

Los clips de cámara (`camera`, `dolly`, `shake`, `dutch`) y el `kenBurns` significan lo mismo que en una viñeta normal. La cámara 2D sigue moviendo el DOM: la caja, los globos y las onomatopeyas quedan alineados a coordenadas de página. Three **deriva de ella la cámara 3D**:
- El punto del lienzo que cae en el centro del cuadro es el eje óptico.
- El zoom se vuelve distancia: `D = D0 · s0/s` (dolly real).
- El paneo y la sacudida corren la cámara en x/y. `dutch` es un giro en el plano.

Proyectar desde ese centro sobre el plano focal y aplicar después la transformación 2D equivale exactamente a una cámara estenopeica paralela al plano. Por eso el plano focal (textos, globos DOM) queda idéntico a la cámara 2D y el resto gana parallax. El **reposo** es la cámara que encuadra la viñeta entera sin ken burns; en una viñeta que ocupa la página es la vista por defecto de la escena. La entrada/salida y el `tilt` de la caja no mueven la cámara 3D, porque son de la tarjeta, no del ojo. Para que las capas cercanas no crucen la cámara, la distancia no baja de `(0.15 + max(−Z)) · D0`.

### VFX entre capas

En una viñeta por capas, los VFX aceptan además de `layer` (back/mid/front/screen):
- `between: [idAtrás, idAdelante]`: se dibujan entre esas dos capas, a la profundidad media.
- `z`: un número en la escala depth; se ubican en el orden según esa profundidad.

Con `layer` a secas:
- `back` va delante del fondo más lejano.
- `mid` va entre el último fondo y el primer personaje.
- `front` va delante de todo, textos incluidos.
- `screen` va encima, sin parallax.

`anchor`, `region` y `ctx.gpu.toBase` siguen en px de página. `toBase` lleva al plano del fondo principal de la viñeta.

### Paridad y límites

- `node test/layers-parity.mjs <scene_layout.json> [--webgl]` renderiza cada escena al tamaño del lienzo (1:1) con la cámara en reposo y la compara contra `previews/SCENE_XX.png`, con la guía incluida, con `autoTiming` al final de la escena y sin guía contra una composición de referencia. Da media, p99 y max por escena, y falla con max > 1/255.
- Para lograr diferencia 0 las capas se decodifican sin premultiplicar (`createImageBitmap`, `premultiplyAlpha: 'none'`), el shader premultiplica en float y los buffers de la viñeta son de 8 bits. Cada capa se redondea al mezclarse, igual que en Photoshop. Consecuencia: en una viñeta por capas el glow/bloom de los VFX trabaja con 8 bits por canal.
- Todas las capas se mezclan en modo normal con opacidad 1. `comic layers` avisa si el PSD traía otro modo u opacidad.
- Los fondos no se agrandan solos (no hay overscan automático). Si un fondo a sangre deja ver su borde al panear, bajá `depthScale`, acercá ese fondo (`depth` más alto) o limitá la cámara.
