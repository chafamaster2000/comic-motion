# Cámara y recetas de escena

Guía para elegir el movimiento de cámara y los efectos de una escena a partir de la **dirección** (`meta.direction`, la `direction` de la escena, la instrucción del usuario). La usan el agente al escribir escenas y el generador headless. El formato exacto de `move3d`, los tags y las recetas está en `scene-format.md`.

## Reglas

1. **Viñeta por capas → `move3d` con tags.** Si la escena usa un asset `type: 'layers'`, la cámara va con el preset `move3d` apuntando a una referencia semántica: `"target": "@hero"`, `"@char-2"`, `"@bg-main"`, `"@text-1"`, `"layer:<id>"` o `"panel:<clipId>"`. No escribas keyframes `camera` con `cx/cy/w` a mano: se rompen cuando cambia el recorte, no respetan los bordes seguros y no se leen.
2. **Nunca coordenadas crudas si hay tags.** Lo mismo para `between` de los VFX (`["@bg-main", "@char-1"]`) y los overrides de `params.layers` (`"@hero": { … }`). Las coordenadas quedan para lo que no tiene capa (una onomatopeya en un punto vacío, un `region` de niebla).
3. **`amount` entre 0.2 y 0.5.** Es relativo al recorrido nominal del movimiento y al margen seguro (el motor lo limita para no mostrar bordes y avisa). 0.2 = sutil, 0.35 = claro, 0.5 = marcado. Más de 0.6 solo si la dirección lo pide explícitamente.
4. **Una cámara con recorrido por escena.** Dos clips que definen vista (`camera`, `move3d`) compiten. Para encadenar movimientos usá `shots` dentro de un mismo `move3d`. Los efectos (`shake`, `dutch`, `dolly`) sí se suman.
5. **Empezá por una receta.** `comic recipe <dir> <escena> <receta>` expande a clips normales (cámara, overrides de capas, fx, ono, vfx) que después se retocan. Es más rápido y más consistente que escribir todo a mano. `comic recipe --list` muestra el catálogo.
6. **Después, `comic check <dir> --gaps`** para ver si algún encuadre deja ver bordes o huecos, y `comic snapshot` para mirar.
7. Los `*.local.md` del usuario (si existen) pueden preferir o ajustar recetas y amounts: mandan sobre esta tabla.

## Dirección → movimiento

| dirección / tono | movimiento (`move3d`) | receta | amount | extras |
|---|---|---|---|---|
| épico, abrir escena, ubicar | `pullOut` al `@bg-main`, o `crane` | `establishing` | 0.35–0.45 | textos con pop en orden de lectura, deriva leve del fondo |
| íntimo, diálogo, emoción | `pushIn` al que habla + `breathe` (shots) | `dialogue` | 0.2–0.3 | `autoTiming` de textos |
| tenso, inquietante, amenaza | `dollyZoom` (in) al personaje | `tension` | 0.3–0.4 | `dutch` −4° a −8° que entra despacio |
| acción, persecución | `truck` en la dirección del movimiento | `reveal` + `impact` | 0.35–0.5 | `shake` + `flash` + `speedLines`/`burst` en el golpe |
| presentación de personaje | `pushIn` corto después del impacto | `hero-entrance` | 0.2 | slam en z + shake + flash + ono |
| golpe puntual | (no toca la cámara principal) | `impact` | — | shake 20–26, flash 0.6–0.7, burst en el punto |
| descubrir, sorpresa tranquila | `truck` o `reveal` | `reveal` | 0.3–0.45 | textos al final |
| cómico | cámara sobria: `breathe` o fija | (a mano) | 0.15–0.25 | el humor lo dan `pop`/`slam` de textos y onos, no la cámara |
| contemplativo, melancólico | `breathe` o `pushIn` muy lento | `dialogue` con `--target @bg-main` | 0.15–0.25 | sin shake, transiciones `fade` |
| cambio de foco, revelación de un detalle | `rackFocus` (`from` → `to`) | (a mano) | — | `dof` 0.4–0.6 |

## Recetas

| receta | qué expande | target por defecto |
|---|---|---|
| `establishing` | `move3d pullOut` (toda la duración), deriva del fondo (solo si no hay divisores ni personajes recortados contra él), overrides `at` + `pop` de cada texto en orden de lectura | `@bg-main` |
| `dialogue` | `move3d` con `shots`: `pushIn` (60 % de la duración) → `breathe`; `autoTiming: true` en la viñeta | `@hero` |
| `hero-entrance` | override de la capa: `at` + `enter: slam`; en el impacto `shake`, `flash`, `ono` (ubicada donde menos pisa textos y caras); `move3d pushIn` corto si no hay otra cámara (o con `--replace-camera`) | `@hero` |
| `reveal` | `move3d truck` (`--direction left|right`), `autoTiming: true` | `@bg-main` |
| `tension` | `move3d dollyZoom` + `dutch` −6° | `@hero` |
| `impact` | en `--at`: `shake`, `flash`, `speedLines`, `burst` (vfx, anclado al centro del target) | `@hero` |

Opciones: `--target @tag`, `--at s` (inicio, s de escena), `--duration s`, `--replace-camera` (saca las cámaras con recorrido de la escena), `--text "¡PAF!"` (ono de `hero-entrance`), `--direction`, `--activate` (deja activa la variante nueva), `--dry` (muestra sin escribir).

**Lo aprobado se respeta:** si la variante activa de la escena está aprobada (o `--replace-camera` tendría que sacar un clip aprobado), la receta crea una variante **nueva** de escena (copia de la activa + receta, `draft`) y la aprobada queda intacta. La viñeta nunca se edita en su lugar: los overrides van en una variante nueva del clip de la viñeta.

## Ejemplos

Diálogo con push-in al que habla y respiración (un solo clip encadenado):

```json
{ "id": "cam", "track": "camera", "label": "Diálogo", "active": "v1",
  "variants": [ { "id": "v1", "status": "draft", "preset": "move3d", "start": 0, "duration": 6,
    "params": { "target": "@char-2", "amount": 0.3, "ease": "easeInOut",
      "shots": [ { "at": 0, "dur": 3.6, "move": "pushIn" }, { "at": 3.6, "move": "breathe" } ] } } ] }
```

Plano de ubicación: pull-out y textos en orden de lectura con overrides por tag:

```json
{ "preset": "move3d", "start": 0, "duration": 7, "params": { "move": "pullOut", "target": "@bg-main", "amount": 0.4 } }
```
```json
{ "preset": "panel", "params": { "asset": "escena_01",
  "layers": { "@text-1": { "at": 1.2, "enter": "pop" }, "@text-2": { "at": 3.1, "enter": "pop" } } } }
```

Tensión: dolly zoom y dutch:

```json
[ { "preset": "move3d", "start": 0, "duration": 5, "params": { "move": "dollyZoom", "target": "@hero", "amount": 0.35 } },
  { "preset": "dutch", "start": 0, "duration": 5, "params": { "angle": -6, "inTime": 1.2 } } ]
```

Niebla entre el fondo y el primer personaje, sin ids del PSD:

```json
{ "preset": "fog", "params": { "target": "pagina", "between": ["@bg-main", "@char-1"], "density": 0.5 } }
```
