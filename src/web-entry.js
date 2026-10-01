// Player web del export HTML (`comic html`): el mismo player determinístico que el preview y el export de video,
// reproduciéndose en vivo. Lee la escena y la configuración del propio index.html (no hace falta fetch para eso),
// precarga los archivos (carpeta: fetch con progreso; --single: base64 embebido) como blob: URLs y recién ahí
// arranca. Bundle clásico (IIFE): funciona también abriendo el .html desde disco (file://) si es --single.
import { createPlayer } from './player/player.js';

// La tipografía va solo en controles y carteles: el cuadro hereda los estilos por defecto, como en el exportador.
const CSS = `
html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}
.cw-root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000;user-select:none;-webkit-user-select:none}
.cw-ctrl,.cw-loader,.cw-msg{font:13px/1.3 system-ui,-apple-system,'Segoe UI',sans-serif;color:#eee}
.cw-box{position:relative;overflow:hidden;background:#000}
.cw-stage{position:absolute;left:0;top:0;transform-origin:0 0}
.cw-hit{position:absolute;inset:0;cursor:pointer}
.cw-loader,.cw-msg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#000;text-align:center;padding:24px;box-sizing:border-box}
.cw-loader .t{opacity:.85}
.cw-bar{width:min(360px,70%);height:4px;border-radius:2px;background:#333;overflow:hidden}
.cw-bar>div{height:100%;width:0;background:#f5c518;transition:width .15s}
.cw-msg{background:rgba(0,0,0,.88);z-index:5}
.cw-msg b{font-size:15px}
.cw-msg code{background:#222;padding:2px 6px;border-radius:4px;color:#f5c518}
.cw-poster{position:absolute;left:50%;top:50%;width:84px;height:84px;margin:-42px 0 0 -42px;border-radius:50%;background:rgba(0,0,0,.55);border:2px solid rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;pointer-events:none;transition:opacity .2s}
.cw-poster svg{width:34px;height:34px;margin-left:5px;fill:#fff}
.cw-ctrl{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:10px;padding:18px 12px 10px;background:linear-gradient(transparent,rgba(0,0,0,.75));transition:opacity .25s;z-index:4}
.cw-ctrl.hide{opacity:0;pointer-events:none}
.cw-ctrl button{all:unset;cursor:pointer;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:6px;flex:none}
.cw-ctrl button:hover{background:rgba(255,255,255,.15)}
.cw-ctrl button:focus-visible{outline:2px solid #f5c518}
.cw-ctrl button.on{color:#f5c518}
.cw-ctrl svg{width:18px;height:18px;fill:currentColor}
.cw-ctrl input{flex:1;min-width:40px;accent-color:#f5c518;cursor:pointer;margin:0}
.cw-time{font-variant-numeric:tabular-nums;opacity:.9;flex:none;min-width:84px;text-align:center}
@media (max-width:480px){.cw-time{display:none}.cw-ctrl{gap:4px;padding:14px 6px 6px}}
`;

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  loop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
};

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const readJson = (id) => {
  const s = document.getElementById(id);
  return s ? JSON.parse(s.textContent) : null;
};
const fmt = (t) => {
  const ds = Math.floor(t * 10 + 1e-6); // décimas
  const m = Math.floor(ds / 600);
  const s = (ds % 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
};
const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';

// Descarga (o decodifica, si van embebidos) todos los archivos a blob: URLs. Las texturas GPU necesitan leer los
// píxeles: con blob: URLs no hay problemas de origen ni en http ni en file://.
async function loadFiles(cfg, onProgress) {
  const files = cfg.files || [];
  const total = files.reduce((a, f) => a + (f.size || 0), 0) || 1;
  let loaded = 0;
  const map = {};
  if (cfg.embedded) {
    const blobs = document.querySelectorAll('script[type="application/octet-stream"][data-path]');
    for (const s of blobs) {
      const f = files.find((x) => x.path === s.dataset.path);
      // data: URL → Blob con el decodificador del navegador (rápido y sin strings intermedios gigantes)
      const blob = await (await fetch(`data:${f?.type || 'application/octet-stream'};base64,${s.textContent.trim()}`)).blob();
      map[s.dataset.path] = URL.createObjectURL(blob);
      s.textContent = ''; // libera el texto base64
      loaded += f?.size || blob.size;
      onProgress(loaded / total, loaded, total);
    }
    return { map, ok: true };
  }
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const res = await fetch(f.path);
      if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
      const chunks = [];
      if (res.body?.getReader) {
        const rd = res.body.getReader();
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          onProgress(Math.min(1, loaded / total), loaded, total);
        }
      } else chunks.push(await res.arrayBuffer());
      map[f.path] = URL.createObjectURL(new Blob(chunks, { type: f.type || '' }));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
    return { map, ok: true };
  } catch (e) {
    // abierto desde disco: el navegador no deja leer archivos con fetch. Lo que es DOM se ve igual con URLs
    // relativas; lo que dibuja la GPU no (lo avisamos después de construir).
    if (location.protocol === 'file:') return { map: {}, ok: false, fileProtocol: true };
    throw e;
  }
}

async function main() {
  const scene = readJson('comic-scene');
  const cfg = readJson('comic-config') || {};
  if (!scene) throw new Error('falta la escena (script#comic-scene)');
  const q = new URLSearchParams(location.search);
  const showUi = q.get('ui') !== '0'; // ?ui=0: sin controles ni carteles (capturas, tests, iframes limpios)
  const W = scene.meta.width;
  const H = scene.meta.height;
  const fps = scene.meta.fps || 24;
  // tope de resolución de los canvas GPU (px de dispositivo por px del cuadro): 1080 → ancho 1920, 4k → 3840
  const capPx = cfg.quality === '1080' ? 1920 : 3840;
  const cap = capPx / W;

  const style = el('style');
  style.textContent = CSS;
  document.head.append(style);
  const rootEl = document.getElementById('comic-app') || document.body.appendChild(el('div'));
  const root = el('div', 'cw-root');
  const box = el('div', 'cw-box');
  const stage = el('div', 'cw-stage');
  const hit = el('div', 'cw-hit');
  const loader = el('div', 'cw-loader', `<div class="t">Cargando… <span class="pct">0%</span></div><div class="cw-bar"><div></div></div><div class="t sz"></div>`);
  if (!showUi) loader.style.visibility = 'hidden';
  box.append(stage, hit, loader);
  root.append(box);
  rootEl.append(root);

  let zoom = 1;
  let player = null;
  const layout = () => {
    const vw = root.clientWidth || window.innerWidth;
    const vh = root.clientHeight || window.innerHeight;
    zoom = Math.min(vw / W, vh / H);
    box.style.width = W * zoom + 'px';
    box.style.height = H * zoom + 'px';
    // zoom (no transform): Chrome rasteriza el DOM a la resolución final, como en el export de video
    stage.style.zoom = String(zoom);
  };
  layout();

  const t0 = performance.now();
  const bar = loader.querySelector('.cw-bar>div');
  const res = await loadFiles(cfg, (p, l, tot) => {
    bar.style.width = Math.round(p * 100) + '%';
    loader.querySelector('.pct').textContent = Math.round(p * 100) + '%';
    loader.querySelector('.sz').textContent = `${mb(l)} de ${mb(tot)}`;
  });
  const urlMap = res.map;
  const fontUrl = (f) => urlMap['fonts/' + f] || 'fonts/' + f;

  const dpr = () => window.devicePixelRatio || 1;
  player = createPlayer(stage, {
    scene,
    baseUrl: '',
    fontBase: 'fonts/',
    fontUrl,
    urlMap,
    customDefs: window.__comicEffects || [],
    pixelScale: () => Math.min(zoom * dpr(), cap),
    layoutZoom: () => zoom * dpr(),
  });
  const fontsUsed = cfg.fonts || [];
  await Promise.all([fontsUsed.includes('ComicNeue-Bold.ttf') ? document.fonts.load("700 40px 'Comic Neue'") : null, fontsUsed.includes('Bangers-Regular.ttf') ? document.fonts.load("40px 'Bangers'") : null]).catch(() => {});
  await player.gpuReady();
  await player.seek(0);
  const loadMs = Math.round(performance.now() - t0);
  loader.remove();

  const api = (window.__comicWeb = {
    ready: false,
    loadMs,
    duration: player.duration(),
    fps,
    get time() {
      return player.time;
    },
    get playing() {
      return player.playing;
    },
    get gpuBackend() {
      return player.gpuBackend;
    },
    get errors() {
      return player.errors;
    },
    gpuPanels: player.gpuPanelCount,
    fileProtocolBlocked: !!res.fileProtocol,
    seek: async (t, o) => {
      hidePoster();
      await player.seek(t, o);
      sync();
    },
    play: () => togglePlay(true),
    pause: () => togglePlay(false),
  });

  if (res.fileProtocol && player.gpuPanelCount > 0) {
    const m = el(
      'div',
      'cw-msg',
      `<b>Esta animación usa la GPU y el navegador no deja leer sus archivos abriéndola desde el disco (file://).</b>
<div>Abrila con un servidor: <code>comic html --serve ${location.pathname.split('/').slice(-2, -1)[0] || '.'}</code> (o cualquier servidor estático, p. ej. <code>npx serve</code>),<br>subí la carpeta a un hosting (GitHub Pages, Netlify), o exportá un solo archivo con <code>comic html --single</code>.</div>`,
    );
    box.append(m);
  }

  // ---------- controles ----------
  const dur = player.duration();
  let loopOn = !!cfg.loop;
  const applyLoop = () => player.setLoop(loopOn ? [0, dur] : null);
  applyLoop();
  const poster = el('div', 'cw-poster', ICON.play);
  if (showUi) box.append(poster);
  function hidePoster() {
    poster.style.opacity = '0';
  }
  let ctrl = null;
  let btnPlay;
  let range;
  let timeEl;
  let btnLoop;
  if (cfg.controls !== false && showUi) {
    ctrl = el('div', 'cw-ctrl');
    btnPlay = el('button', '', ICON.play);
    btnPlay.title = 'Reproducir (espacio)';
    range = el('input');
    Object.assign(range, { type: 'range', min: 0, max: dur, step: 1 / fps, value: 0 });
    range.setAttribute('aria-label', 'Tiempo');
    timeEl = el('div', 'cw-time');
    btnLoop = el('button', loopOn ? 'on' : '', ICON.loop);
    btnLoop.title = 'Repetir';
    const btnFull = el('button', '', ICON.full);
    btnFull.title = 'Pantalla completa (F)';
    ctrl.append(btnPlay, range, timeEl, btnLoop, btnFull);
    box.append(ctrl);
    btnPlay.onclick = () => togglePlay();
    btnLoop.onclick = () => {
      loopOn = !loopOn;
      btnLoop.classList.toggle('on', loopOn);
      applyLoop();
    };
    btnFull.onclick = toggleFull;
    // arrastrar la barra: render síncrono mientras se arrastra; al soltar, seek (espera imágenes/video/GPU)
    let resume = false;
    range.addEventListener('pointerdown', () => {
      resume = player.playing;
      player.pause();
    });
    range.addEventListener('input', () => {
      hidePoster();
      player.render(+range.value);
    });
    range.addEventListener('change', async () => {
      await player.seek(+range.value);
      if (resume) player.play();
      resume = false;
      sync();
    });
  }
  function sync() {
    if (!ctrl) return;
    btnPlay.innerHTML = player.playing ? ICON.pause : ICON.play;
    btnPlay.title = player.playing ? 'Pausa (espacio)' : 'Reproducir (espacio)';
    if (document.activeElement !== range) range.value = player.time;
    timeEl.textContent = `${fmt(player.time)} / ${fmt(dur)}`;
  }
  player.onTime(() => {
    if (ctrl) {
      range.value = player.time;
      timeEl.textContent = `${fmt(player.time)} / ${fmt(dur)}`;
    }
    // al terminar (sin loop) el player se pausa solo
    if (!player.playing) sync();
  });
  function togglePlay(force) {
    const want = force ?? !player.playing;
    if (want) {
      hidePoster();
      player.play();
    } else player.pause();
    sync();
    wake();
  }
  async function step(dt) {
    const t = Math.min(dur, Math.max(0, Math.round((player.time + dt) * fps) / fps));
    hidePoster();
    await player.seek(t);
    sync();
  }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
  }
  hit.addEventListener('click', () => togglePlay());
  hit.addEventListener('dblclick', toggleFull);
  window.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' && e.key !== ' ') return;
    if (e.key === ' ' || e.key === 'k') togglePlay();
    else if (e.key === 'ArrowRight') step(e.shiftKey ? 1 : 1 / fps);
    else if (e.key === 'ArrowLeft') step(e.shiftKey ? -1 : -1 / fps);
    else if (e.key === 'Home') step(-dur);
    else if (e.key === 'f' || e.key === 'F') toggleFull();
    else if ((e.key === 'l' || e.key === 'L') && btnLoop) btnLoop.click();
    else return;
    e.preventDefault();
    wake();
  });
  // los controles se esconden reproduciendo, si el mouse no se mueve
  let idle;
  function wake() {
    if (!ctrl) return;
    ctrl.classList.remove('hide');
    clearTimeout(idle);
    idle = setTimeout(() => player.playing && ctrl.classList.add('hide'), 2200);
  }
  root.addEventListener('pointermove', wake);

  // ventana / pantalla completa / cambio de devicePixelRatio (otro monitor, zoom del navegador)
  let pend = 0;
  const onResize = () => {
    cancelAnimationFrame(pend);
    pend = requestAnimationFrame(() => {
      layout();
      if (!player.playing) player.render(player.time);
    });
  };
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);

  sync();
  if (cfg.autoplay) togglePlay(true);
  api.ready = true;
  window.__comicReady = true;
}

main().catch((e) => {
  window.__comicError = String(e?.stack || e);
  console.error(e);
  const box = document.querySelector('.cw-box') || document.body;
  const m = el('div', 'cw-msg', '<b>No se pudo cargar la animación.</b>');
  m.append(el('div', '', String(e?.message || e).replace(/</g, '&lt;')));
  box.append(m);
});
