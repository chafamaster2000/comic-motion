---
name: comic-motion
description: Hace animaciones tipo cómic (motion comics) a partir de imágenes y videos del usuario, con HTML, CSS y Motion (ex Framer Motion). Incluye un panel local con línea de tiempo para revisar variantes, aprobarlas o rechazarlas con motivo y ajustar transiciones y timing, y exporta a video MP4/ProRes en 1080p o 4K. Usala cuando el usuario quiera animar viñetas, páginas de cómic, fotos o clips con estética de historieta (globos, onomatopeyas, líneas de velocidad, halftone, paneos de cámara), cuando mencione "motion comic", "animación tipo cómic", "Comic Studio" o un proyecto con scene.json de comic-motion, o cuando pida exportar o seguir iterando una animación de ese tipo.
---

# comic-motion

Cada animación es un **proyecto**: una carpeta con `scene.json` (la única fuente de verdad), `assets/`, `effects/` (efectos custom) y `exports/`. Un player determinístico (`render(t)`, con curvas y springs de Motion evaluados como funciones puras) se usa igual en el panel y en el export cuadro por cuadro. Por eso lo que se aprueba en el panel es exactamente lo que sale en el video.

CLI: `node ~/.claude/skills/comic-motion/bin/comic.js <comando>`. Abajo aparece abreviada como `comic`. Con `comic help` ves todos los comandos y con `comic presets` el catálogo completo de presets y params.

Si falta `dist/` o `node_modules/`: `cd ~/.claude/skills/comic-motion && npm install && npm run build && npx playwright install chromium`.

## Flujo

### 0. ¿Guiado o directo?
En un proyecto **nuevo**, antes de `comic init`, preguntale al usuario con AskUserQuestion:
- **Guiado (recomendado):** una entrevista de a una pregunta, con tu recomendación en cada una, para entender cómo lo quiere.
- **Directo:** vos proponés el storyboard y él corrige.

No preguntes si retoma un proyecto existente, ni si ya pidió ir directo o rápido.

**Si elige guiado:**
1. Primero mirá el material, antes del init: Read de cada imagen, y en los videos 4 a 6 cuadros sacados con ffmpeg a tu scratchpad. Así cada recomendación sale de su material.
2. Después seguí [references/guiado.md](references/guiado.md): reglas y "Árbol para un proyecto nuevo". Las respuestas de salida (fps, carpeta, título) definen los flags de `comic init`.
3. Al cerrar, guardá las decisiones en `meta.direction`.
4. El paso 3 (storyboard) sale de esas respuestas: mostralo junto con el resumen y esperá el OK.

**Durante el proyecto:** si el usuario pide un cambio grande o ambiguo desde el chat, ofrecé hacerlo guiado con el "Árbol para un cambio". En el panel, el mismo guiado está en el botón **Guiado** de cada variante y en **Dirección** (el proyecto entero).

### 1. Proyecto e ingesta
- `comic init <dir> --title "…"` (16:9, 1920×1080, 24 fps por defecto; se cambia con `--width/--height/--fps`).
- `comic ingest <dir> <archivos…>`: copia el material y mide cada archivo. Para los videos crea un proxy WebM y una **hoja de contacto** con los tiempos.

**Terminado cuando:** cada archivo del usuario figura en `scene.assets`.

### 2. Entender el material (vos sos el VLM)
Mirá con Read **cada** imagen y **cada** hoja de contacto. Después, en `scene.json`, completá por asset:
- `description`: qué se ve, quién aparece y, en los videos, los tiempos clave ("impacto a 3.8s").
- `focus`: el punto de interés.

Si una imagen es una **página de cómic** con varias viñetas:
1. Corré `comic panels <dir> <asset>`.
2. Mirá el overlay numerado. El detector falla cuando las viñetas se tocan sin canaleta o cuando el fondo se funde con la canaleta.
3. Corregí a ojo y guardá los recortes definitivos en `asset.panels`.

**Terminado cuando:** todos los assets tienen `description`, y las páginas de cómic tienen `panels` verificados visualmente.

### 3. Storyboard
Respetá `meta.direction` si existe (sale del guiado). Proponé al usuario, en pocas líneas, la secuencia de escenas: qué viñeta o clip va en cada una, qué pasa, la transición y la duración aproximada. Esperá su OK o sus cambios antes de escribir.

### 4. Escribir la escena
Editá `scene.json` siguiendo [references/scene-format.md](references/scene-format.md). Si hay archivos `references/*.local.md` con criterios propios, leelos y seguilos. Cada escena y cada clip arrancan con una variante `v1` en `draft`.
- `comic check <dir>`: sin errores.
- `comic snapshot <dir> --t a,b,c`: sacá cuadros en los momentos clave (entrada de cada escena, cada golpe, cada globo) y **miralos**. Corregí globos que tapen caras, textos cortados y cámaras que muestren bordes vacíos.
- Mostrale al usuario los cuadros revisados.

**Terminado cuando:** `check` pasa y viste un snapshot por escena sin problemas visibles.

### 5. Panel de revisión
- Levantalo en background: `comic studio <dir> --port 4777 --open`, y pasale la URL al usuario.
- En el panel, el usuario:
  - mira las variantes con **Ver** y las alterna con la tecla `A`;
  - **aprueba** diciendo qué le gusta, o **rechaza** diciendo qué no funciona;
  - arrastra clips y bordes para cambiar tiempos;
  - cambia transiciones y params en el inspector;
  - pide variantes o **retoques por prompt**.
- Esos pedidos los resuelve solo la cola del server, con `claude -p` headless (modelo `meta.generatorModel`, hasta `meta.maxVariants` por pedido). Corre hasta `meta.generatorConcurrency` pedidos a la vez (3 por defecto, se cambia en la barra), uno por escena: los de la misma escena van en fila.
- **Iterar varias escenas desde el chat:** si los cambios son en escenas distintas, lanzá un subagente por escena en paralelo. Ninguno escribe `scene.json` directo: o encolan pedidos con `POST /api/requests` del studio, o te devuelven el cambio de su escena y lo integrás vos releyendo el archivo. Antes, como siempre, decile al usuario qué escenas se van a tocar (lo aprobado se respeta).
- Cuando el usuario te pida seguir desde el chat, arrancá con `comic status <dir>`: resume la dirección (`meta.direction` y la de cada escena), lo aprobado, lo rechazado con sus motivos, las notas, lo desactualizado y los pedidos abiertos o fallidos.
- **Lo aprobado se respeta.** Antes de cambiar algo desde el chat:
  1. Corré `comic status` y armá el plan de cambios: qué escenas o clips vas a regenerar o editar, por qué, y cuáles están aprobados.
  2. Decíselo al usuario en pocas líneas ("voy a regenerar X e Y por tal motivo; A y B están aprobadas y no las toco") y **esperá su OK**.
  3. Lo aprobado no se toca salvo que el usuario lo nombre explícitamente. Aun así, el cambio va como **variante nueva**: la aprobada queda intacta para comparar.
  4. Si cambiás el motor de la skill (player, presets, render) de una forma que altera cómo se ve algo ya aprobado, avisalo. `approvedHash` solo detecta cambios en el JSON.
- Cambios grandes (rehacer la maqueta, sumar escenas, efectos custom nuevos) los hacés vos editando `scene.json`, siguiendo la regla anterior. El panel se recarga solo. Si el panel tenía un cambio sin guardar, su guardado choca (409) y recarga tu versión, sin pisarla.
- Al crear variantes a mano, usá la memoria de revisión igual que el generador: conservá las `note` y evitá las `rejection`.

### 6. Exportar
El export sale del botón **Exportar video** del panel, o de:

```
comic render <dir> --quality 1080|4k [--codec prores] [--from s --to s]
```

- Lo que se exporta es lo **activo**. El panel avisa si hay escenas sin aprobar.
- Los **cuadros por segundo** son configuración del proyecto (`meta.fps`: 24, 30 o 60). Se eligen en la barra superior del panel (o con `init --fps`) y tanto el preview como el export usan ese fps. 24 da una sensación más de cómic o cine; 60 hace los paneos más fluidos y tarda unas 2,5 veces más en exportar.
- Referencia en una Mac Apple Silicon con GPU: 1080p ≈ 2,2 veces el tiempo real y 4K ≈ 7 veces.

**Terminado cuando:** el archivo existe en `exports/`, extrajiste 2 o 3 cuadros con ffmpeg y los miraste, y le pasaste al usuario la ruta y los cuadros.

## Efectos custom
Cuando ningún preset alcanza, escribí `effects/<id>.js` en el proyecto con el contrato de la sección "Efectos custom" de `scene-format.md`. Aparece solo en el panel. Todo tiene que ser función del tiempo `t` (nada de `Math.random` ni animaciones CSS), porque si no el export no coincide con el preview.

## Opcionales
- **Profundidad 2.5D:** `comic cutout <dir> <asset>` (BiRefNet_lite, MIT, corre en JS) genera el recorte del personaje y un fondo sin personajes (`bgfill`). Después va `depth` de 0.06 a 0.15 en la viñeta. El fondo queda fijo a la página y solo avanzan los personajes. Si la imagen trae **textos dibujados** (globos, carteles), marcalos con `depthLock: [[x,y,w,h], …]` en px del asset: esas zonas se dibujan fijas por encima de todo, así las letras no se desfasan ni se recortan.
- **Material por capas** (PNG por capa más `scene_layout.json` con posición, tamaño y `z_index`, exportado del PSD): `comic layers <dir> <scene_layout.json>` crea un asset `type: 'layers'` por escena. Cada capa es un **plano 3D real** (three.js): la cámara 2D se traduce a una cámara en perspectiva, así los zooms son dolly con parallax de verdad, sin recortes ni rellenos. Los roles (`background`, `character`, `text`, `fx`, `divider`, `guide`), la profundidad y el `clipTo` (personajes cortados por el borde de su viñeta) salen solos. **Mirá la tabla que imprime** y la preview, y corregí con `params.layers` de la viñeta. Los textos quedan fijos y nítidos, y pueden entrar escalonados en orden de lectura (`autoTiming`). Los VFX van entre dos capas con `between`. Con la cámara en reposo el render coincide píxel a píxel con la preview del PSD: verificalo con `node test/layers-parity.mjs <scene_layout.json>`. Si una imagen plana ya animada tiene su versión por capas con un margen, usá `crop` en px del lienzo para que las coordenadas existentes (cámaras, anclajes) sigan valiendo.
- **Pixel art:** `pixelated: true` en la viñeta, para que al escalar no se vea borroso.
- **VFX (pista `vfx`, three.js WebGPU con respaldo WebGL2):** partículas analíticas (`snow`, `sparks`, `burst`), niebla procedural (`fog`: bancos de fbm con láminas de parallax en una banda baja), deformación (`shockwave`, `heat`), `impactFlash` y `glow`. Params comunes: `target` (viñeta), `anchor` `[x,y]` en px de página, `layer` `back|mid|front` (mid queda detrás del recorte 2.5D), `style` `glow|ink`, `intensity`, `stepFps`; `snow` y `fog` aceptan `region` (polígono en px de página) para no pisar el borde dibujado de la viñeta, y `fog` `avoid` para despejar caras y textos. Una viñeta con VFX en mid/back o de deformación pasa a dibujarse en GPU entera (el filtro `ink` no está portado: `check` avisa). Efectos custom: `effects/<id>.vfx.js` con `kind: 'vfx'` y la API `ctx.gpu` de `scene-format.md`. Revisá siempre los snapshots: la densidad y el glow se juzgan a ojo.
