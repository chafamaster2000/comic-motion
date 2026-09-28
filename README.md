# comic-motion

**Motion comics con HTML, CSS y [Motion](https://motion.dev) (ex Framer Motion), como skill para [Claude Code](https://docs.claude.com/claude-code).**

Le pasás imágenes y videos a Claude, arma una animación tipo cómic (viñetas, cámara, globos de diálogo, onomatopeyas, líneas de velocidad, halftone) y te abre un **panel de revisión con línea de tiempo**. Ahí aprobás o rechazás variantes, pedís cambios por prompt y ajustás transiciones y timing. Al final **exporta a video** (MP4 H.264 o ProRes, 1080p o 4K).

![Uso del panel: variantes, aprobar/rechazar con motivo, ajustar timing y pedir variantes por prompt](docs/uso.gif)

*El panel en uso: mirar variantes y alternarlas con `A`, rechazar con motivo, aprobar con nota, mover un clip en la línea de tiempo y pedir variantes nuevas por prompt. La espera de la generación está recortada.*

---

## Qué trae

- **Player determinístico.** La animación es una función pura del tiempo, así que lo que ves en el panel es *exactamente* lo que sale en el video, cuadro por cuadro.
- **Panel local (Comic Studio):**
  - Línea de tiempo con pistas de cámara, viñetas, efectos, globos y onomatopeyas.
  - Arrastrar y estirar clips con snap a cuadro.
  - Loop de un tramo.
  - Inspector con los parámetros de cada preset.
  - Recarga en vivo cuando el archivo cambia desde afuera.
- **Variantes y revisión:**
  - Cada escena y cada clip puede tener varias variantes.
  - **Aprobar** con una nota ("qué me gusta") o **rechazar** con un motivo ("qué no funciona").
  - **Retocar** una variante por prompt, o pedir N variantes nuevas.
  - Las variantes nuevas se generan solas en segundo plano con `claude -p` y respetan la memoria de revisión: conservan lo aprobado y evitan lo rechazado.
  - `A` alterna entre dos variantes para compararlas.
  - Aviso de aprobación **desactualizada** cuando algo cambió después de aprobar.
- **Presets incluidos:**
  - **Transiciones:** corte, fundido, barrido, zoom punch, deslizar, corte diagonal, iris, mancha de tinta y flash.
  - **Cámara:** recorrido por keyframes, sacudida, inclinación holandesa y dolly.
  - **Viñetas** de imagen o video con Ken Burns, recorte, borde, inclinación y profundidad 2.5D.
  - **Globos:** diálogo, pensamiento, grito y narración, con máquina de escribir.
  - **Onomatopeyas:** slam, pop, temblor y estiramiento.
  - **Efectos:** líneas de velocidad, líneas de foco, flash y viñeteado.
  - **Filtros:** halftone, contorno de tinta, colores planos, papel, aberración de color y CSS libre.
- **Efectos custom:** un archivo JS por efecto en el proyecto, con el mismo contrato que los incluidos.
- **Ingesta asistida:**
  - Proxies de video para buscar cuadros con precisión.
  - Hojas de contacto para que Claude "vea" los videos.
  - Detección de viñetas en páginas de cómic (OpenCV.js).
  - Recorte de personajes para parallax (BiRefNet_lite en JS, sin Python).
- **Export** cuadro por cuadro con Chromium headless (con GPU) y ffmpeg.

## Requisitos

- [Claude Code](https://docs.claude.com/claude-code)
- Node.js 20 o más nuevo
- ffmpeg (con ffprobe)
- Unos 600 MB de disco (Chromium de Playwright, OpenCV.js y ONNX Runtime). El modelo de recorte (~200 MB) se descarga recién la primera vez que lo usás.

## Instalación

### Windows

1. Descargá o cloná este repo.
2. Hacé doble clic en **`install.bat`**.

El instalador:
- instala con `winget` lo que falte: Node.js LTS, ffmpeg y Git;
- ofrece instalar Claude Code si no lo encuentra;
- copia la skill a `%USERPROFILE%\.claude\skills\comic-motion`;
- instala las dependencias, compila el panel y descarga Chromium.

### macOS / Linux

```bash
git clone https://github.com/chafamaster2000/comic-motion.git
cd comic-motion
./install.sh
```

### Manual

```bash
git clone https://github.com/chafamaster2000/comic-motion.git ~/.claude/skills/comic-motion
cd ~/.claude/skills/comic-motion
npm install && npm run build && npx playwright install chromium
```

## Uso

Abrí Claude Code en una carpeta de trabajo y pedí algo como:

> Hagamos un motion comic con estas imágenes y este video: `./material/`

Claude va a:
1. crear el proyecto;
2. mirar el material;
3. proponerte un storyboard;
4. armar la escena y revisar cuadros;
5. levantar el panel (por defecto en `http://127.0.0.1:4777`).

Desde el panel revisás, pedís variantes y exportás. En cualquier momento podés volver al chat ("seguimos con el comic") y Claude retoma desde lo que aprobaste y rechazaste.

### Atajos del panel

| Tecla | Acción |
|---|---|
| `Espacio` | Play / pausa |
| `←` / `→` | Cuadro anterior / siguiente (`Shift`: ±1 s) |
| `A` | Alternar entre la variante actual y la anterior |
| `L` | Loop del tramo marcado (`Shift` + arrastrar en la regla) |
| `Ctrl/⌘` + rueda | Zoom de la línea de tiempo |

### CLI

La skill la usa por detrás, pero también la podés correr vos:

```
node ~/.claude/skills/comic-motion/bin/comic.js <comando>

  init <dir> [--title T] [--width 1920 --height 1080 --fps 24]
  ingest <dir> <archivos...>          copia imágenes/videos, proxy y hoja de contacto
  panels <dir> <assetId>              detecta viñetas en una página de cómic
  cutout <dir> <assetId>              recorta el personaje (profundidad 2.5D)
  check <dir>                         valida scene.json
  status <dir>                        resumen de revisión y pedidos
  presets                             catálogo de presets y parámetros
  snapshot <dir> --t 0.5,2,3.4        cuadros PNG sueltos
  studio <dir> [--port 4777] [--open] panel de revisión
  render <dir> [--quality 1080|4k] [--codec h264|prores] [--from s --to s]
```

## Un proyecto por dentro

```
mi-comic/
  scene.json        ← única fuente de verdad (escenas, clips, variantes, revisión)
  history.jsonl     ← registro de aprobaciones, rechazos, pedidos y exports
  assets/           ← tu material (+ proxies .webm y recortes)
  effects/          ← efectos custom (opcional)
  exports/          ← videos exportados
  .comic/           ← caché interna (hojas de contacto, snapshots, cola de pedidos)
```

El formato completo está en [`references/scene-format.md`](references/scene-format.md).

## Efectos custom

Creá `effects/miEfecto.js` en el proyecto:

```js
export default {
  id: 'miEfecto',
  kind: 'fx', // camera | panel | fx | bubble | ono | transition | filter
  label: 'Mi efecto',
  params: [{ key: 'color', label: 'Color', type: 'color', default: '#ffffff' }],
  build(ctx) {
    const el = document.createElement('div');
    ctx.mount(el, 'screen');
    return {
      update(t) {
        // solo función de t (y de ctx.rand / ctx.hashRand, que tienen semilla)
        el.style.background = ctx.params.color;
        el.style.opacity = Math.max(0, 1 - t / ctx.duration);
      },
    };
  },
};
```

Aparece solo en el panel. La única regla: todo tiene que depender del tiempo `t`. Nada de `Math.random()`, `Date.now()` ni animaciones CSS, porque si no el export no coincide con el preview.

## Exportar

Desde el botón **Exportar video** del panel (o `comic render`) elegís resolución (1080p o 4K), formato (MP4 H.264 o ProRes) y tramo (todo o el loop marcado). El render corre cuadro por cuadro con el mismo player que el preview, así que lo que aprobaste es exactamente lo que sale.

![Export: diálogo, progreso y resultado](docs/export.gif)

*Export a 1080p: diálogo, progreso (acelerado) y unos segundos del video resultante.*

### Rendimiento

Medido con GPU en Apple Silicon: 1080p ≈ 2 a 3 veces el tiempo real y 4K ≈ 7 veces. Los filtros SVG (tinta, colores planos) son lo más caro. Sin GPU pueden ser bastante más lentos.

## Limitaciones conocidas

- Sin audio: el export sale mudo.
- La detección de viñetas asume canaletas de un color parejo. Si las viñetas se tocan, Claude corrige los recortes mirando el overlay.
- El recorte 2.5D no rellena el hueco del fondo. Funciona bien con movimientos chicos.
- Probado en macOS. Windows y Linux están soportados por el instalador, pero tienen menos horas de uso.

## Licencias

- Código: [MIT](LICENSE).
- Tipografías incluidas: [Bangers](fonts/OFL-Bangers.txt) y [Comic Neue](fonts/OFL-ComicNeue.txt), ambas SIL Open Font License 1.1.
- Modelo de recorte: [BiRefNet_lite](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) (MIT). Se descarga en el primer uso, no viene incluido.
- Dependencias principales: Motion, React, Playwright, sharp, OpenCV.js y transformers.js, cada una con su licencia.
- Material del demo de los GIFs: fotos y video de la NASA (Apolo 8, Apolo 11 y Artemis I), de dominio público. Su uso no implica respaldo de la NASA a este proyecto.
