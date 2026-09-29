# Formato de `scene.json`

Es la única fuente de verdad. El panel, el export y el generador leen y escriben este archivo. El catálogo de presets con todos sus params sale de `comic presets` (o de `.comic/catalog.json`).

## Estructura

```
meta     { title, width: 1920, height: 1080, fps: 24, background, generatorModel: "sonnet", maxVariants: 3, generatorConcurrency: 3,
           guideModel?: "sonnet", direction?: { destino, duracion, tono, textos, camara, transiciones, profundidad, vfx, look, final, … } }
         direction: decisiones del modo guiado (claves libres, valores en texto, con las palabras del usuario).
         Cada escena puede tener también su propio `direction` (mismo formato) al lado de `variants`.
         Cambiar la dirección no desactualiza aprobaciones: guía las variantes que se generen después.
         panelDefaults?: { border: 0, shadow: false, crop: [...], autoTiming: false, … } — ver "Params por defecto de las viñetas".
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

### Params por defecto de las viñetas (`meta.panelDefaults`)

`meta.panelDefaults` es un objeto con params del preset `panel` que valen para **todas** las viñetas del proyecto (por ejemplo `{ "border": 0, "shadow": false, "crop": [128,128,1920,1080], "autoTiming": false }`). Al construir la escena se mergean **debajo** de los params de cada variante: la variante gana clave por clave (merge superficial: un `layers` en la variante reemplaza entero al de los defaults). `asset` no puede ir ahí (`check` da error) y las claves que no son params de `panel` dan aviso.

Como el merge es en runtime, agregar o cambiar `panelDefaults` **no toca el `approvedHash`** de ninguna variante (el hash es del contenido de la variante). Ojo: cambiar un default sí cambia cómo se ve lo aprobado que no fija ese param, igual que cambiar el motor. `comic defaults <dir> --hoist` sube a `panelDefaults` los params que todas las variantes de viñeta tienen iguales y los saca de las variantes; como el render queda idéntico, re-sella las aprobaciones que estaban al día (las desactualizadas siguen así). Para código que lea params de viñeta fuera del player: `withPanelDefaults(meta, params)` de `src/player/presets.js`.

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

- `tags` / `tagsAuto`: alias semánticos (ver abajo).

### Tags (alias semánticos de capas)

`comic layers` (y `comic tags <dir> [asset] [--reset]` para recalcular un asset ya ingestado) pone `tags` en cada capa. Se usan en lugar del id como `"@tag"`, o con el id explícito como `"layer:<id>"`, en: claves de `params.layers` de la viñeta, `clipTo` de un override, `between` de los VFX y el `target` (y `shots[].target`) de la cámara `move3d`. Un `@tag` con varias capas resuelve a la de más adelante (z mayor). `comic check` da error si una referencia no resuelve.

| tag | capa |
|---|---|
| `hero` | personaje principal: max(área de alfa · (0.75 + 0.5·cercanía) · (1 − 0.6·distancia al centro)); cercanía 0 = el de más atrás … 1 = el de más adelante; distancia del centroide del alfa al centro del lienzo, normalizada a la media diagonal. Gana el más grande/cercano y, a igual tamaño, el más centrado |
| `char-1..n` | personajes de atrás hacia adelante (depth, luego z) |
| `bg-main` | el fondo no global con más área de alfa |
| `bg-far` | el fondo más lejano (global, depth mínima) si es otro |
| `fx-front` | el fx de más adelante |
| `text-1..n` | textos en orden de lectura (sin adornos `attachedTo`) |
| `divider` | los divisores |

Los tags se pueden editar a mano en el asset (`"tags": ["hero", "villano"]`). `tagsAuto` guarda la última propuesta automática: si `tags` difiere, es una edición a mano y se conserva al re-ingestar o recalcular (`--reset` la pisa). Un tag puesto a mano en una capa se saca de la propuesta automática de las demás (poner `@hero` a mano mueve el héroe).

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
| `layers` | `{ [idCapa \| "@tag" \| "layer:id"]: { depth?, role?, hidden?, at?, dur?, enter?, exit?, motion?, clipTo? } }` | overrides por capa (las claves `@tag` se aplican primero y las de id exacto encima). `clipTo: null` explícito = libre; `clipTo` acepta `@tag` |
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
- Los fondos no se agrandan solos (no hay overscan automático). Si un fondo a sangre deja ver su borde al panear, bajá `depthScale`, acercá ese fondo (`depth` más alto) o limitá la cámara. `comic check --gaps` encuentra esos instantes y `move3d` se limita solo (ver "Cámara 3D (move3d) y límites").

## Cámara 3D (move3d) y límites

`move3d` (pista `camera`) describe movimientos clásicos de cámara por **intención** (qué, hacia dónde, cuánto) en vez de keyframes en px. Cada movimiento es un cambio sobre centro, distancia y FOV, y devuelve la misma interfaz que las cámaras 2D (`{view, dx, dy, drot, dzoom}`): los globos DOM, la paridad de capas y el pipeline 2D → 3D no cambian. Funciona en viñetas por capas (parallax real) y en viñetas planas (se vuelve un recorrido 2D). Sostiene su vista al terminar el clip, como `camera`.

| param | qué es |
|---|---|
| `move` | `pushIn` \| `pullOut` \| `truck` \| `pedestal` \| `dollyZoom` \| `arc` \| `crane` \| `reveal` \| `rackFocus` \| `handheld` \| `breathe` |
| `target` | `@tag`, `layer:<id>`, `panel:<clipId>`, `region:[x,y,w,h]` (px de página) o `focus` (foco de la viñeta). Vacío = la primera viñeta de la escena |
| `amount` | 0..1, fracción del recorrido nominal (tabla). **Nunca px**. Si los bordes no dan, se limita y avisa |
| `direction` | `left`/`right` (truck, arc, reveal), `up`/`down` (pedestal, crane, reveal), `in`/`out` (dollyZoom) |
| `ease` | curva del tramo (default `easeInOut`) |
| `zoom` | encuadre base (≥ 1) de los movimientos que lo usan; vacío = el del movimiento |
| `from`, `to`, `dof` | rackFocus: capas (o depth) de foco inicial y final (default: el fondo → el objetivo) e intensidad del desenfoque |
| `shots` | encadenado `[{at, dur, move, target, amount, direction, ease, zoom}]`: cada tramo arranca donde terminó el anterior |

| move | amount = 1 | encuadre base |
|---|---|---|
| `pushIn` | zoom ×2 hacia el objetivo (queda centrado) | la viñeta |
| `pullOut` | arranca a zoom ×2 sobre el objetivo y abre hasta la viñeta | — |
| `truck` / `pedestal` | recorrido de medio ancho / medio alto de vista; el objetivo pasa por el centro a mitad | zoom 1.2 |
| `dollyZoom` | distancia ×0.4 (`in`, el fondo se aleja) o ×2.5 (`out`, el fondo se viene encima); el plano del objetivo mantiene su tamaño | zoom 1.25 |
| `arc` / `crane` | órbita de 12° / 10° alrededor del objetivo, que queda centrado | zoom 1.15 |
| `reveal` | arranca a zoom 1.8 contra el borde opuesto a `direction` y abre hasta el objetivo | — |
| `rackFocus` | no mueve la cámara: anima el foco del DOF de `from` a `to` | `zoom` o 1 |
| `handheld` | ruido suave de ±2 % del ancho y ±0.4° (baja frecuencia, con semilla) | zoom 1.06 |
| `breathe` | zoom lento de +3 % (período 4 s) y deriva mínima | zoom 1.04 |

```json
{ "id": "cam", "track": "camera", "variants": [ { "id": "v1", "status": "draft", "preset": "move3d", "start": 0, "duration": 6,
  "params": { "move": "pushIn", "target": "@hero", "amount": 0.5 } } ] }
```

```json
"params": { "shots": [
  { "at": 0, "dur": 2.5, "move": "pullOut", "target": "@hero", "amount": 0.6 },
  { "at": 2.5, "dur": 1.5, "move": "rackFocus", "from": "@hero", "to": "@bg-main" },
  { "at": 4, "dur": 2, "move": "handheld", "amount": 0.3 } ] }
```

**Canales 3D.** Además de la cámara 2D, `move3d` devuelve `dist` (factor de distancia a igual encuadre del plano focal), `orbit` (`[yaw, pitch]` en grados, se suma al `orbit` de la viñeta) y `dof` (`{amount, focus}`, reemplaza al `dof` de la viñeta mientras la cámara lo empuje). El rig no expone el FOV: el dolly zoom se hace con `dist` (`D = D0·s0/s·dist`, equivalente a cambiar la distancia focal) y el zoom 2D se despeja para que el plano del objetivo (a `Zt`) mida lo mismo en pantalla: `r = K·dist / (dist − K·Zt)`, con `r` la escala del plano focal respecto del reposo y `K` la del arranque. La distancia nunca baja de `(0.15 − zmin)·D0`; si el dolly `in` choca con ese límite, se limita `amount`. Para centrar una capa a profundidad `Z` la vista se centra en su punto del mundo `c0 + (p − c0)(1 + Z)` (con órbita, más `tan θ · Z·D0`).

**Límites (estilo "cinematic photos": el render cubre el cuadro en cada cuadro).** Al construir, `move3d` muestrea su recorrido y verifica con `src/player/bounds.js` que:
- en una viñeta por capas, la unión de los **fondos** visibles (rol `background`, bbox en el plano de cada uno, con su parallax) cubra la parte visible de la caja;
- si la escena en reposo está cubierta por viñetas (a sangre), la vista no salga de ellas; si no, que no salga de la página.

El muestreo es denso (≤ 30 fps) e incluye los **efectos de cámara de la escena** que se suman encima (`shake`, `dutch`, `dolly` de otros clips), también los que caen después de cada tramo (el siguiente arranca de ahí y move3d sostiene su vista al final). Si no da, primero corre el encuadre hacia el centro de la viñeta (en `pushIn`, `pullOut`, `reveal`; en el resto primero limita `amount`) y después limita `amount`; si ni sin moverse entra (un shake viejo sobre el encuadre de reposo), agranda el encuadre lo mínimo (overscan hasta ×1.5, salvo en `dollyZoom`). **Siempre con aviso** (`ctx.warn`, `player.warnings`, `rt.warnings`/`rt.limits` y `comic check --gaps`): `truck: amount limitado a 0.22 (pedido 1) para no ver bordes`. Las cámaras viejas (`camera`, `dolly`, `shake`…) no se tocan: solo las revisa `check --gaps`.

**`comic check <dir> --gaps [fps]`** muestrea cada escena (4 fps por defecto) con la cámara compuesta (la misma función que el player, sin navegador) y reporta, con tiempos locales a la escena:
- `s3 t=5.25–6.00s (peor en 5.50s): se ve el borde derecho de <fondo> (−34 px)` (hueco entre los fondos de una viñeta por capas);
- `se ve fuera de la viñeta <id>` / `fuera de la página` (vista 2D que sale del contenido);
- textos (rol `text`) cortados por el borde del cuadro o de su viñeta durante ≥ 0.5 s, o que aparecen (`at > 0`) enteros fuera de cuadro; globos DOM cortados;
- VFX con `region` fuera de su viñeta;
- los avisos de `move3d`.

Se saltean los tramos de entrada/salida de las viñetas. La cobertura usa el bbox de cada capa (no el alfa): un fondo con transparencias grandes puede dar un falso "cubierto". Sin `--gaps`, `check` no cambia.

## Recetas de escena

`comic recipe <dir> <sceneId> <receta> [--target @tag] [--at s] [--duration s] [--replace-camera] [--activate] [--text T] [--direction left|right] [--dry]` expande una receta a **clips normales y editables** sobre la variante activa de la escena: cámara `move3d` con `@tag`, overrides de capas (en una variante nueva del clip de la viñeta, que queda activa), `shake`/`flash`/`ono`/`speedLines` y VFX. No hay un formato de receta en `scene.json`: después de aplicarla queda JSON común. `comic recipe --list` muestra el catálogo; qué receta usar según la dirección está en `camera-recipes.md`.

- Si la variante activa de la escena está aprobada (o `--replace-camera` tendría que sacar un clip aprobado), crea una variante nueva de escena copiando la activa (`draft`, `parent` = la activa, `instruction: "receta <id>"`) y la aprobada queda intacta; con `--activate` la deja activa.
- Si no, agrega los clips a la variante activa (ids únicos: `cam`, `cam_2`…).
- Necesita una viñeta por capas con tags (`comic layers` / `comic tags`).

Recetas (`src/recipes/<id>.js`, funciones puras `expand(ctx) → { summary, clips, layers?, panel?, notes? }`; contrato en `src/recipes/index.js`): `establishing`, `dialogue`, `hero-entrance`, `reveal`, `tension`, `impact`.
