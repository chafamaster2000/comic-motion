# Modo guiado (grill)

Entrevista para entender **cómo quiere el usuario su motion comic** antes de escribir nada. Funciona en dos lugares con las mismas reglas:
- **En la terminal**, al arrancar un proyecto nuevo. Si el usuario elige "guiado", la entrevista va antes de `comic init`.
- **En el panel** (botón "Guiado"), cuando el usuario quiere cambiar una escena, un clip o la dirección general del proyecto. Ahí el server te invoca headless, **una pregunta por llamada** (ver "Modo panel").

## Reglas

1. **Una pregunta por vez.** Esperá la respuesta antes de hacer la siguiente. Varias preguntas juntas marean.
2. **Cada pregunta trae tu recomendación**, con el porqué en una línea. Las opciones son de 2 a 4, excluyentes y concretas, y la recomendada va primera. El usuario siempre puede responder otra cosa.
3. **Los hechos los averiguás vos; las decisiones son del usuario.** No preguntes lo que se ve en el material o en `scene.json` (cuántas viñetas hay, si tienen texto dibujado, cuánto dura un video, qué se aprobó): miralo y usalo para recomendar. Preguntá solo lo que es gusto o intención.
4. **Recorré el árbol de decisiones resolviendo dependencias.** Si una respuesta vuelve irrelevante una rama, salteala. Si abre una pregunta que no estaba en el árbol, hacela.
5. **Recomendá desde el material, no en genérico.** Mal: "¿querés profundidad 2.5D?". Bien: "La viñeta 3 tiene al personaje bien recortable sobre un fondo liso: recomiendo 2.5D ahí y en ninguna otra, porque en las demás el texto está pegado al personaje".
6. **Respetá lo aprobado.** En un proyecto con variantes aprobadas, no propongas cambiarlas sin decir explícitamente qué se regeneraría. Las `note` y `rejection` existentes son respuestas que ya dio: no las vuelvas a preguntar.
7. **No se escribe nada hasta el OK.** Al final mostrá un resumen de las decisiones (y en la terminal, el storyboard que sale de ellas) y esperá la confirmación. Recién ahí se escribe.
8. **Cortá a tiempo.** Si el usuario dice "ya está", "dale" o "hacelo", cerrá con lo que haya y completá lo que falte con tus recomendaciones, diciendo cuáles asumiste.

## Árbol para un proyecto nuevo

Salteá lo que ya esté respondido en el pedido o no aplique al material.

1. **Destino:** para qué es y dónde se va a ver (redes, trailer, pitch, portfolio, pantalla grande). Define el ritmo y la duración.
2. **Duración objetivo.**
3. **Orden y selección:** qué viñetas o clips entran y en qué orden (recomendá el orden de lectura detectado).
4. **Tono:** épico, cómico, tenso, emotivo… Define curvas, cámara y transiciones.
5. **Textos:** dejar los dibujados (fijarlos con `depthLock` si hay 2.5D), recrear los globos animados (con máquina de escribir), o sin texto.
6. **Cámara:** sobria (paneos lentos, Ken Burns) o agresiva (zoom punch, temblor, holandés).
7. **Transiciones:** estilo general (cortes secos, fundidos, cortes de cómic: slash, iris, mancha de tinta).
8. **Profundidad 2.5D:** en qué viñetas (recomendá solo donde el recorte funcione).
9. **VFX:** dónde y cuáles (nieve, chispas, niebla, onda de choque…), estilo `glow` o `ink`.
10. **Look:** limpio, halftone, tinta, papel, aberración de color.
11. **Final:** fundido a negro, golpe final, loop.
12. **Salida:** fps (24, 30 o 60), 1080p o 4K, MP4 o ProRes. En la terminal, además, carpeta y título del proyecto.

Guardá las respuestas en `meta.direction` (ver `scene-format.md`), con las palabras del usuario cuando las haya.

## Árbol para un cambio (panel o chat, sobre algo que existe)

1. **Qué no le gusta o qué busca**, en concreto (si la instrucción ya lo dice, no lo repreguntes).
2. **Alcance:** solo este clip, la escena entera, o también la dirección general del proyecto.
3. **Qué se conserva:** proponé conservar todo lo aprobado y lo que tiene `note`, y confirmá.
4. **Las 1 a 3 decisiones concretas** que definen el cambio (timing, entrada, cámara, efecto…), cada una con recomendación.
5. **Cuántas variantes** y en qué se diferencian entre sí.

## Modo panel (headless, una pregunta por llamada)

El server te pasa en el prompt la ruta de un `guide.json` con:
- `target`: `null` (proyecto), `{ scene }` o `{ scene, clip }`;
- `instruction`: lo que escribió el usuario al abrir el guiado (puede venir vacío);
- `transcript`: las preguntas y respuestas hasta ahora, `[{ question, answer }]`;
- `finish`: `true` si el usuario pidió cerrar ya;
- `context`: la escena o el clip, su memoria de revisión, `meta` (con `direction`) y los assets.

Leé también `scene.json`, `catalog.json` y las imágenes que necesites. Después escribí **un solo archivo**, `turn.json`, en la carpeta que te indica el prompt, con una de estas dos formas:

```json
{
  "type": "question",
  "question": "¿Cómo querés que entre el ¡PAF!?",
  "why": "Hoy entra con pop a 1.1s, antes del impacto del puño (1.35s).",
  "options": [
    { "label": "Slam en el impacto", "description": "Entra a 1.35s, clavado con el golpe, y tiembla", "recommended": true },
    { "label": "Pop anticipado", "description": "Como ahora, pero más grande" },
    { "label": "Estirado", "description": "Se estira hacia la cámara, más cómico" }
  ]
}
```

```json
{
  "type": "done",
  "summary": "Entrada del ¡PAF! con slam justo en el impacto; se conserva la cámara aprobada; 2 variantes: una con temblor fuerte y otra seca.",
  "direction": { "tone": "más violento en los golpes" },
  "instruction": "Retocá el clip paf: slam a 1.35s clavado con el golpe…",
  "kind": "variants",
  "count": 2
}
```

- `question`: de 2 a 4 opciones, la recomendada primera y con `recommended: true`. El panel agrega solo el campo libre.
- `done`: cerrá cuando las decisiones alcancen para generar sin adivinar, o cuando `finish` sea `true`.
  - `instruction` es el pedido completo y autocontenido para el generador: incluí todas las decisiones, no solo la última respuesta.
  - `direction` (opcional) son solo las claves de dirección que cambian: van a `meta.direction` si `target` es `null`, o a la `direction` de la escena si no.
  - `kind` es `variants` o `retouch`, y `count` va de 1 a `meta.maxVariants`.
- No escribas ningún otro archivo ni toques `scene.json`.
