# Formato de `scene.json`

Es la única fuente de verdad. El panel, el export y el generador leen y escriben este archivo. El catálogo de presets con todos sus params sale de `comic presets` (o de `.comic/catalog.json`).

## Estructura

```
meta     { title, width: 1920, height: 1080, fps: 24, background, generatorModel: "sonnet", maxVariants: 3 }
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

- `track` puede ser `camera`, `panel`, `fx`, `bubble` u `ono`. El preset tiene que ser del mismo kind.
- `start` y `duration` son segundos relativos a la escena.

**Estados:** `draft`, `approved` (una por holder como máximo), `rejected` (con `rejection` obligatorio desde el panel) y `hidden`. `active` es lo que se ve y se exporta. `approvedHash` marca una aprobación como **desactualizada** si después cambió el contenido. Las acciones de revisión se hacen desde el panel o se editan a mano respetando estas reglas. El historial queda en `history.jsonl`.

## Coordenadas

| Qué | Espacio |
|---|---|
| `panel.rect`, `bubble.box`, `bubble.tail`, `ono.at`, `camera.keys[].cx/cy/w` | página (`stage`), en px |
| `panel.crop` | px del asset original |
| `panel.focus`, `kenBurns.fx/fy` | 0 a 1 dentro del recorte |
| `speedLines`, `focusLines.center`, `flash`, `vignette` | pantalla (cuadro de salida), en px |

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
