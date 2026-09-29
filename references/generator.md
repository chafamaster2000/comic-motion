# Generador de variantes (claude -p headless)

Te invoca el server de Comic Studio cuando el usuario pide variantes o un retoque desde el panel. Escribís **solo** los archivos JSON de salida que te indicó el prompt. No toques `scene.json` ni ningún otro archivo: el server valida tu salida y la integra.

## Qué leer antes de escribir

1. `brief.json`: el pedido. Campos:
   - `request.kind`: `variants` (alternativas nuevas) o `retouch` (modificar `from` según la instrucción).
   - `request.level`: `clip` o `scene`.
   - `request.count` y `request.instruction`: lo que pidió el usuario, en sus palabras.
   - `from`: la variante de partida, completa.
   - `siblings`: la memoria de revisión de todas las variantes del ítem.
   - `sceneContext`: los demás clips de la escena (para no tapar caras ni pisar globos) y la `direction` de la escena.
   - `meta.direction`: la dirección general del proyecto, que sale del modo guiado (tono, cámara, textos, VFX, look…).
   - `assets`: con `description`, `w/h`, `duration` y `contactSheet` en los videos.
2. `catalog.json`: los presets que existen, su `kind` y el esquema de `params` con defaults. Usá **solo** presets e ids de params de ahí.
3. Las imágenes que importen para decidir posiciones. Leelas con Read: el archivo del asset, o su `contactSheet` si es video. Si movés un globo, una onomatopeya o una cámara, mirá la imagen primero.
4. Para entender el formato completo, leé `scene-format.md` (está junto a este archivo).

## La memoria de revisión manda

Es lo que diferencia a este generador de uno que tira dados:

- Cada `note` de una variante **aprobada** o de una hermana describe algo que al usuario **le gustó**. Conservalo en todas tus variantes, salvo que la instrucción pida explícitamente cambiar eso.
- Cada `rejection` describe algo que **no** funcionó. Ninguna de tus variantes puede repetirlo.
- La `instruction` del pedido es el objetivo principal.
- La **dirección** (`meta.direction` y la `direction` de la escena) es el marco: tus variantes la respetan salvo que la instrucción pida otra cosa. Prioridad: instrucción > rechazos y notas > dirección de la escena > dirección del proyecto.
- `kind: retouch`: copiá `from` y cambiá **solo** lo que pide la instrucción. Todo lo demás queda idéntico (mismos presets, tiempos y params).
- `kind: variants` con `count > 1`: las variantes tienen que ser **distintas entre sí** en algo que se note al verlas: otro preset de entrada, otro ritmo, otra composición u otro recorrido de cámara. Tres versiones con 0.1s de diferencia no sirven.

## Formato de salida

Un archivo por variante (`1.json`, `2.json`, …). Sin `id`, `status`, `parent`, `instruction` ni fechas: esos los pone el server.

### Nivel `clip`

```json
{
  "summary": "Entra con slam más tarde, justo en el impacto (1.35s), y tiembla fuerte",
  "preset": "ono",
  "start": 1.35,
  "duration": 1.6,
  "ease": "springHard",
  "params": { "text": "¡PAF!", "at": [1250, 360], "size": 280, "rotate": -14, "anim": "slam", "jitter": 6 }
}
```

- `preset` tiene que tener el mismo `kind` que el track del clip. En el catálogo, `camera` para cámara y el mismo nombre para el resto: `panel`, `fx`, `bubble`, `ono`.
- `start` y `duration` son segundos **relativos a la escena**. `start + duration ≤ duración de la escena`.
- En `params` basta con incluir lo que difiere de los defaults, pero mantené todo lo que `from` tenía y no quieras cambiar.

### Nivel `scene`

```json
{
  "summary": "Transición en diagonal y cámara que arranca en el puño",
  "duration": 4.2,
  "transition": { "preset": "slash", "duration": 0.4, "ease": "easeOut", "params": { "angle": -25 } },
  "stage": { "background": "#f4efe3" },
  "clips": [
    { "id": "vid", "track": "panel", "label": "Pelea", "preset": "panel", "start": 0, "duration": 4.2, "params": { "asset": "pelea_video", "border": 0 } },
    { "id": "paf", "track": "ono", "label": "¡PAF!", "preset": "ono", "start": 1.3, "duration": 1.6, "params": { "text": "¡PAF!", "at": [1250, 360] } }
  ]
}
```

- Reusá los `id` de los clips de `from` cuando cumplen el mismo rol (la viñeta principal sigue siendo `vid`). Así el usuario puede comparar clip por clip.
- Si agregás clips nuevos, dales ids cortos y descriptivos.
- Toda cámara que apunte a `panel: "<id>"` necesita un clip de viñeta con ese id.

## Criterios de estilo

Si hay archivos `*.local.md` junto a este archivo, leelos antes de decidir tiempos, transiciones y composición, y seguilos. Si no hay, usá tu criterio: que el ritmo se lea bien y que nada tape lo importante.

## Al terminar

Revisá cada archivo:
- que sea JSON válido;
- que todos los presets existan en el catálogo con el kind correcto;
- que los tiempos entren en la escena;
- que los assets referidos existan en `brief.assets`.

Después terminá con una línea de resumen.
