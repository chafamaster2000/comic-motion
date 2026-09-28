// Player determinístico: render(t) es una función pura del tiempo global.
// El panel lo usa en vivo (play con rAF) y el exportador lo congela cuadro por cuadro con seek(t).
import { layoutScenes, activeClips, hashString, mulberry32 } from '../shared/scene.js';
import { BUILTIN, defaultsOf } from './presets.js';
import { easing } from './ease.js';
import { mix } from 'motion';

const STYLE_ID = 'cm-player-style';

function injectStyle(fontBase) {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
@font-face { font-family: 'Bangers'; src: url('${fontBase}Bangers-Regular.ttf') format('truetype'); font-display: block; }
@font-face { font-family: 'Comic Neue'; src: url('${fontBase}ComicNeue-Bold.ttf') format('truetype'); font-weight: 700; font-display: block; }
@font-face { font-family: 'Comic Neue'; src: url('${fontBase}ComicNeue-Regular.ttf') format('truetype'); font-weight: 400; font-display: block; }
.cm-frame { position: relative; overflow: hidden; contain: strict; }
.cm-frame * { box-sizing: border-box; }
.cm-scene, .cm-screen, .cm-overlay { position: absolute; inset: 0; }
.cm-scene { overflow: hidden; }
.cm-cam { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.cm-page { position: absolute; left: 0; top: 0; overflow: hidden; }
.cm-overlay { display: none; pointer-events: none; }
.cm-clip-hidden { visibility: hidden !important; }
`;
  document.head.append(st);
}

export function registry(customDefs = []) {
  const map = {};
  for (const d of BUILTIN) map[d.id] = d;
  for (const d of customDefs) if (d && d.id) map[d.id] = { ...d, custom: true };
  return map;
}

export async function loadCustomEffects(urls) {
  const out = [];
  for (const u of urls || []) {
    try {
      const m = await import(/* @vite-ignore */ u);
      out.push(m.default);
    } catch (e) {
      console.error('[comic] efecto custom falló', u, e);
    }
  }
  return out;
}

// opts: { scene, baseUrl (prefijo de archivos del proyecto), fontBase, customDefs }
export function createPlayer(root, opts) {
  injectStyle(opts.fontBase || '/fonts/');
  const presets = registry(opts.customDefs);
  let scene = opts.scene;
  let built = null;
  let time = 0;
  let playing = false;
  let raf = 0;
  let playStartWall = 0;
  let playStartT = 0;
  let loop = null; // [a,b]
  const listeners = new Set();
  const pending = new Set(); // imágenes por decodificar

  const W = () => scene.meta.width;
  const H = () => scene.meta.height;

  function fileUrl(f) {
    if (!f) return '';
    if (/^(https?:|data:|blob:|\/)/.test(f)) return f;
    return (opts.baseUrl || '') + f;
  }

  function build() {
    root.innerHTML = '';
    const frame = document.createElement('div');
    frame.className = 'cm-frame';
    Object.assign(frame.style, { width: W() + 'px', height: H() + 'px', background: scene.meta.background || '#fff' });
    const defsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defsSvg.setAttribute('width', '0');
    defsSvg.setAttribute('height', '0');
    defsSvg.style.position = 'absolute';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defsSvg.append(defs);
    frame.append(defsSvg);
    root.append(frame);

    const layout = layoutScenes(scene);
    const videos = [];
    const errors = [];
    let uidN = 0;
    const scenes = layout.map((entry, zi) => {
      const v = entry.variant;
      const stage = { w: v.stage?.w || W(), h: v.stage?.h || H() };
      const sceneEl = div('cm-scene');
      sceneEl.style.zIndex = String(2 * zi + 2);
      sceneEl.style.background = v.stage?.background || scene.meta.background || '#fff';
      const cam = div('cm-cam');
      const page = div('cm-page');
      Object.assign(page.style, { width: stage.w + 'px', height: stage.h + 'px', background: v.stage?.background || scene.meta.background || '#fff' });
      cam.append(page);
      const screen = div('cm-screen');
      // overlays de transición a nivel cuadro: uno debajo y otro encima de la escena entrante
      const under = div('cm-overlay');
      under.style.zIndex = String(2 * zi + 1);
      const overlay = div('cm-overlay');
      overlay.style.zIndex = String(2 * zi + 3);
      sceneEl.append(cam, screen);
      frame.append(under, sceneEl, overlay);

      const clips = activeClips(v);
      // rects de viñetas para que cámara y globos puedan apuntarles
      const panelRects = {};
      for (const { clip, variant } of clips) {
        if (clip.track === 'panel') panelRects[clip.id] = variant.params?.rect || [0, 0, stage.w, stage.h];
      }
      const order = ['panel', 'fx', 'bubble', 'ono', 'camera'];
      const sorted = [...clips].sort((a, b) => order.indexOf(a.clip.track) - order.indexOf(b.clip.track));
      const runtimes = [];
      for (const { clip, variant } of sorted) {
        const def = presets[variant.preset];
        const holder = div('cm-clip');
        holder.dataset.clip = clip.id;
        Object.assign(holder.style, { position: 'absolute', inset: 0, pointerEvents: 'none' });
        let space = null;
        if (!def) {
          errors.push(`preset desconocido "${variant.preset}" en ${entry.scene.id}/${clip.id}`);
          continue;
        }
        const seed = hashString(entry.scene.id + '/' + clip.id + '/' + variant.id);
        const ctx = {
          params: { ...defaultsOf(def), ...(variant.params || {}) },
          duration: variant.duration,
          clip,
          variant,
          stage,
          frame: { w: W(), h: H() },
          presets,
          seed,
          rand: mulberry32(seed),
          hashRand: (n) => mulberry32(seed ^ Math.imul(n + 1, 2654435761))(),
          easing,
          mix,
          defs,
          uid: (s) => `cm${uidN++}-${s}`,
          asset: (id) => (id ? scene.assets?.[id] : null),
          assetUrl: (a) => fileUrl(a.type === 'video' ? a.proxy || a.file : a.file),
          fileUrl,
          panelRect: (id) => panelRects[id],
          preload: (img) => {
            pending.add(img);
            const done = () => pending.delete(img);
            img.decode ? img.decode().then(done, done) : img.addEventListener('load', done);
          },
          registerVideo: (video, map) => videos.push({ video, map, clipStart: variant.start, sceneEntry: entry, holder }),
          mount: (node, sp = 'page') => {
            space = sp;
            holder.append(node);
          },
        };
        let rt;
        try {
          rt = def.build(ctx) || {};
        } catch (e) {
          errors.push(`${entry.scene.id}/${clip.id}: ${e.message}`);
          continue;
        }
        if (holder.childNodes.length) (space === 'screen' ? screen : page).append(holder);
        runtimes.push({ clip, variant, def, rt, holder, isCamera: def.kind === 'camera' });
      }
      return { entry, stage, sceneEl, cam, page, screen, overlay, under, runtimes, zi };
    });
    built = { frame, layout, scenes, videos, errors };
    if (errors.length) console.warn('[comic]', errors);
  }

  function div(cls) {
    const d = document.createElement('div');
    d.className = cls;
    return d;
  }

  function resetScene(s) {
    for (const k of ['transform', 'clipPath', 'opacity', 'maskImage', 'webkitMaskImage', 'filter']) s.sceneEl.style[k] = '';
    s.sceneEl.style.zIndex = String(2 * s.zi + 2);
    s.overlay.removeAttribute('style');
    s.overlay.style.zIndex = String(2 * s.zi + 3);
    s.under.removeAttribute('style');
    s.under.style.zIndex = String(2 * s.zi + 1);
  }

  function render(t) {
    if (!built) build();
    time = t;
    const total = duration();
    const scenes = built.scenes;
    scenes.forEach((s, i) => {
      const { start, end } = s.entry;
      const isLast = i === scenes.length - 1;
      const visible = t >= start && (t < end || (isLast && t <= end + 1e-6));
      s.visible = visible;
      s.sceneEl.style.display = visible ? '' : 'none';
      if (!visible) return;
      resetScene(s);
      const local = t - start;
      let view = { cx: s.stage.w / 2, cy: s.stage.h / 2, w: Math.max(s.stage.w, s.stage.h * (W() / H())), rotate: 0 };
      let dx = 0;
      let dy = 0;
      let drot = 0;
      let dzoom = 1;
      for (const r of s.runtimes) {
        const cs = r.variant.start || 0;
        const ce = cs + (r.variant.duration || 0);
        const on = local >= cs && local < ce + (r.isCamera ? 1e9 : 0);
        if (r.isCamera) {
          if (local < cs) continue;
          const lt = Math.min(local - cs, r.variant.duration || 0);
          const res = r.rt.update ? r.rt.update(lt) || {} : {};
          if (local >= ce && r.def.id !== 'camera') continue; // efectos de cámara terminan con su clip
          if (res.view) view = { ...view, ...res.view };
          dx += res.dx || 0;
          dy += res.dy || 0;
          drot += res.drot || 0;
          dzoom *= res.dzoom || 1;
          continue;
        }
        r.holder.classList.toggle('cm-clip-hidden', !on);
        if (on && r.rt.update) r.rt.update(local - cs);
      }
      const sc = (W() / view.w) * dzoom;
      s.cam.style.transform = `translate(${W() / 2 + dx}px, ${H() / 2 + dy}px) rotate(${(view.rotate || 0) + drot}deg) scale(${sc}) translate(${-view.cx}px, ${-view.cy}px)`;
    });
    // transiciones de entrada
    scenes.forEach((s, i) => {
      if (!s.visible || !s.entry.transition || i === 0) return;
      const local = t - s.entry.start;
      const td = s.entry.transitionDuration;
      if (td <= 0 || local >= td) return;
      const def = presets[s.entry.transition.preset];
      if (!def || !def.apply) return;
      const p = easing(s.entry.transition.ease || 'easeInOut', td)(local / td);
      const prev = scenes[i - 1];
      def.apply({
        inEl: s.sceneEl,
        outEl: prev.visible ? prev.sceneEl : null,
        overlay: s.overlay,
        under: s.under,
        p,
        params: { ...defaultsOf(def), ...(s.entry.transition.params || {}) },
        ctx: { frame: { w: W(), h: H() }, hashRand: (n) => mulberry32(hashString(s.entry.scene.id) ^ Math.imul(n + 1, 2654435761))() },
      });
    });
    syncVideos(t, false);
    for (const cb of listeners) cb(t, total);
  }

  function videoTime(v, t) {
    const local = t - v.sceneEntry.start - (v.clipStart || 0);
    return Math.max(0, v.map(Math.max(0, local)));
  }

  function syncVideos(t, seeking) {
    for (const v of built.videos) {
      const visible = t >= v.sceneEntry.start && t <= v.sceneEntry.end;
      if (!visible) {
        if (!v.video.paused) v.video.pause();
        continue;
      }
      const target = videoTime(v, t);
      if (playing && !seeking) {
        if (v.video.paused) {
          v.video.currentTime = target;
          v.video.play().catch(() => {});
        } else if (Math.abs(v.video.currentTime - target) > 0.2) {
          v.video.currentTime = target;
        }
      } else {
        if (!v.video.paused) v.video.pause();
        if (Math.abs(v.video.currentTime - target) > 0.001) v.video.currentTime = target;
      }
    }
  }

  function duration() {
    if (!built) build();
    const l = built.layout;
    return l.length ? Math.max(...l.map((e) => e.end)) : 0;
  }

  // Para exportar: renderiza t y espera a que imágenes, fuentes y videos estén listos.
  async function seek(t) {
    pause();
    render(t);
    await document.fonts.ready;
    const waits = [];
    for (const img of pending) waits.push(img.decode ? img.decode().catch(() => {}) : Promise.resolve());
    for (const v of built.videos) {
      const vis = t >= v.sceneEntry.start && t <= v.sceneEntry.end;
      if (!vis) continue;
      const target = videoTime(v, t);
      waits.push(
        new Promise((res) => {
          const ready = () => v.video.readyState >= 2 && !v.video.seeking;
          if (ready() && Math.abs(v.video.currentTime - target) <= 0.001) return res();
          const done = () => {
            v.video.removeEventListener('seeked', done);
            v.video.removeEventListener('loadeddata', done);
            res();
          };
          v.video.addEventListener('seeked', done);
          v.video.addEventListener('loadeddata', done);
          v.video.currentTime = target;
          setTimeout(done, 8000);
        }),
      );
    }
    await Promise.all(waits);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  function tick() {
    if (!playing) return;
    let t = playStartT + (performance.now() - playStartWall) / 1000;
    const total = duration();
    const [a, b] = loop || [0, total];
    if (t >= b) {
      if (loop || opts.loopAll) {
        playStartT = a;
        playStartWall = performance.now();
        t = a;
        for (const v of built.videos) v.video.pause();
      } else {
        render(total);
        pause();
        return;
      }
    }
    // el preview avanza de a cuadros del proyecto: lo que se ve es lo que se exporta
    const fps = scene.meta.fps || 24;
    const tq = Math.floor(t * fps + 1e-6) / fps;
    if (tq !== time) render(tq);
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (playing) return;
    if (time >= duration() - 1e-3) time = loop ? loop[0] : 0;
    playing = true;
    playStartT = time;
    playStartWall = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    if (built) for (const v of built.videos) if (!v.video.paused) v.video.pause();
  }

  build();
  render(0);

  return {
    get time() {
      return time;
    },
    get playing() {
      return playing;
    },
    get errors() {
      return built?.errors || [];
    },
    get frameEl() {
      return built?.frame;
    },
    duration,
    render,
    seek,
    play,
    pause,
    setLoop(r) {
      loop = r;
    },
    setScene(next, customDefs) {
      const was = playing;
      pause();
      scene = next;
      if (customDefs) Object.assign(presets, registry(customDefs));
      build();
      render(Math.min(time, duration()));
      if (was) play();
    },
    onTime(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy() {
      pause();
      root.innerHTML = '';
      listeners.clear();
    },
    presets,
  };
}
