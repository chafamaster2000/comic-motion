import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { createPlayer, loadCustomEffects } from '../player/player.js';
import { layoutScenes, totalDuration, findTarget, activeVariant } from '../shared/scene.js';
import { useStudio } from './useStudio.js';
import { Timeline } from './Timeline.jsx';
import { Inspector } from './Inspector.jsx';
import { ExportDialog, QueueDrawer, ConfirmDialog } from './Dialogs.jsx';
import { GuideDialog } from './Guide.jsx';

const GUIDE_KEY = 'comic-motion.guide';
const store = {
  get: () => {
    try {
      return localStorage.getItem(GUIDE_KEY);
    } catch {
      return null;
    }
  },
  set: (v) => {
    try {
      v ? localStorage.setItem(GUIDE_KEY, v) : localStorage.removeItem(GUIDE_KEY);
    } catch {}
  },
};
import { scenePage, pageMapping } from './pageMap.js';
import { layersAssetOf, layerPageQuad, effectiveLayer } from './layers.js';

const GPU_LABEL = { webgpu: 'WebGPU', webgl2: 'WebGL2' };
const GPU_TIP = { webgpu: 'Los VFX se dibujan con WebGPU', webgl2: 'sin WebGPU: se usa WebGL2' };

// segundos con centésimas + número de cuadro (lo que se ve en el export)
const fmt = (t, fps) => `${t.toFixed(2)}s`;
const frameOf = (t, fps) => Math.round(t * fps);

export function App() {
  const studio = useStudio();
  const { scene, presets, requests, render, validation, toast, saveState } = studio;
  const stageRef = useRef(null);
  const hostRef = useRef(null);
  const playerRef = useRef(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(null);
  const [loopOn, setLoopOn] = useState(false);
  const [selection, setSelection] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [customDefs, setCustomDefs] = useState(null);
  const [fit, setFit] = useState(0.5);
  const innerRef = useRef(null);
  const [buildTick, setBuildTick] = useState(0); // sube cada vez que el player reconstruye
  const [gpuBackend, setGpuBackend] = useState(null);
  const [draft, setDraft] = useState(false);
  const draftRef = useRef(false);
  const [pick, setPick] = useState(null); // { key, target } mientras se apunta en el preview
  const [hover, setHover] = useState(null); // coords de página bajo la mira
  const [markers, setMarkers] = useState([]);
  const [layerHot, setLayerHot] = useState(null); // { scene, clip, sceneVariant, layer } fila de capa bajo el mouse
  const [layerOutline, setLayerOutline] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const abMemory = useRef({}); // holderKey -> variante anterior para A/B
  const [guide, setGuide] = useState(null); // { id?, target, visible }
  const guideSession = guide?.id ? studio.guides[guide.id] : null;

  // guiado: desde un ítem arranca directo; desde "Dirección" muestra primero la dirección actual
  const openGuide = useCallback(
    async (target, instruction) => {
      setGuide({ id: null, target, visible: true, starting: !!target });
      if (!target) return;
      const g = await studio.startGuide(target, instruction);
      if (!g) return setGuide(null);
      store.set(g.id);
      setGuide({ id: g.id, target: g.target, visible: true });
    },
    [studio],
  );
  const startProjectGuide = useCallback(
    async (instruction) => {
      const g = await studio.startGuide(null, instruction);
      if (!g) return;
      store.set(g.id);
      setGuide({ id: g.id, target: null, visible: true });
    },
    [studio],
  );
  const closeGuide = useCallback(
    (res) => {
      store.set(null);
      setGuide(null);
      if (res?.request) {
        studio.notify(`Pedido encolado: ${res.request.count} ${res.request.kind === 'retouch' ? 'retoque(s)' : 'variante(s)'}`);
        setShowQueue(true);
      } else if (res?.session?.applied?.direction) studio.notify('Dirección guardada');
    },
    [studio],
  );
  // retomar la sesión abierta si el panel se recargó
  useEffect(() => {
    const id = store.get();
    if (!id) return;
    studio.loadGuide(id).then((g) => {
      if (g && ['thinking', 'question', 'done', 'error'].includes(g.status)) setGuide({ id: g.id, target: g.target, visible: true });
      else store.set(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fps = scene?.meta.fps || 24;
  const duration = scene ? totalDuration(scene) : 0;

  // efectos custom del proyecto
  useEffect(() => {
    loadCustomEffects(presets.custom.map((c) => c.url + '?v=' + Date.now())).then(setCustomDefs);
  }, [presets]);

  // player: se crea una vez y se reconstruye cuando cambia la escena
  useEffect(() => {
    if (!scene || !customDefs || !hostRef.current) return;
    if (!playerRef.current) {
      playerRef.current = createPlayer(hostRef.current, { scene, baseUrl: '/p/', fontBase: '/fonts/', customDefs, loopAll: false });
      playerRef.current.onTime((t) => {
        setTime(t);
        setPlaying(playerRef.current.playing);
      });
      if (draftRef.current) playerRef.current.setDraft?.(true);
    } else {
      playerRef.current.setScene(scene, customDefs);
    }
    setGpuBackend(playerRef.current.gpuBackend ?? null);
    setBuildTick((n) => n + 1);
  }, [scene, customDefs]);

  // el backend de VFX puede resolverse de forma asíncrona (init de WebGPU): se relee cada tanto
  useEffect(() => {
    const id = setInterval(() => setGpuBackend(playerRef.current?.gpuBackend ?? null), 1000);
    return () => clearInterval(id);
  }, []);

  const toggleDraft = useCallback(() => {
    const next = !draftRef.current;
    draftRef.current = next;
    setDraft(next);
    const p = playerRef.current;
    if (!p) return;
    p.setDraft?.(next);
    if (!p.playing) p.render(p.time);
  }, []);

  const askConfirm = useCallback((opts) => new Promise((resolve) => setConfirmState({ ...opts, resolve })), []);
  const answerConfirm = useCallback(
    (ok) => {
      confirmState?.resolve(ok);
      setConfirmState(null);
    },
    [confirmState],
  );

  useEffect(() => () => playerRef.current?.destroy(), []);

  useEffect(() => {
    playerRef.current?.setLoop(loopOn && loop ? loop : null);
  }, [loop, loopOn]);

  // escala de la vista previa
  useEffect(() => {
    if (!stageRef.current || !scene) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setFit(Math.min((width - 24) / scene.meta.width, (height - 24) / scene.meta.height));
    });
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [scene?.meta.width, scene?.meta.height]);

  const seek = useCallback(
    (t) => {
      const p = playerRef.current;
      if (!p) return;
      p.pause();
      p.render(Math.max(0, Math.min(duration, t)));
      setPlaying(false);
    },
    [duration],
  );

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) p.pause();
    else p.play();
    setPlaying(p.playing);
  }, []);

  const layout = useMemo(() => (scene ? layoutScenes(scene) : []), [scene]);

  // params de tipo 'anchor' del clip seleccionado (para el marcador y la mira)
  const selAnchor = useMemo(() => {
    if (!scene || !selection?.clip) return null;
    const tt = findTarget(scene, selection);
    const v = activeVariant(tt.holder);
    const def = presets.builtin.find((d) => d.id === v?.preset);
    const params = (def?.params || []).filter((p) => p.type === 'anchor');
    if (!params.length) return null;
    const index = layout.findIndex((e) => e.scene.id === selection.scene && e.variant === tt.sceneVariant);
    const entry = layout[index];
    return {
      index,
      entry,
      clipStart: v.start || 0,
      anchors: params.map((p) => ({ key: p.key, label: p.label || p.key, value: v.params?.[p.key] ?? def.defaults?.[p.key] ?? null })),
    };
  }, [scene, selection, presets, layout]);

  const mapping = useCallback(() => (selAnchor ? pageMapping(scenePage(playerRef.current?.frameEl, selAnchor.index)) : null), [selAnchor]);

  // marcador: se recalcula en cada cuadro renderizado, así sigue a la cámara al hacer scrub/play
  useLayoutEffect(() => {
    const m = mapping();
    const inner = innerRef.current;
    if (!m || !inner) return setMarkers((x) => (x.length ? [] : x));
    const r = inner.getBoundingClientRect();
    setMarkers(
      selAnchor.anchors
        .filter((a) => Array.isArray(a.value))
        .map((a) => {
          const [x, y] = m.toScreen(a.value);
          return { key: a.key, label: a.label, value: a.value, x: x - r.left, y: y - r.top };
        }),
    );
  }, [mapping, selAnchor, time, fit, buildTick]);

  // contorno de la capa resaltada en el editor de capas (aprox.: sin el parallax 3D)
  useEffect(() => setLayerHot(null), [selection?.scene, selection?.clip]);
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!layerHot || !scene || !inner) return setLayerOutline((x) => (x ? null : x));
    const tt = findTarget(scene, layerHot);
    const v = activeVariant(tt.holder);
    const asset = layersAssetOf(scene, v?.params);
    const layer = asset?.layers.find((l) => l.id === layerHot.layer);
    const index = layout.findIndex((e) => e.scene.id === layerHot.scene && e.variant === tt.sceneVariant);
    const m = layer && index >= 0 ? pageMapping(scenePage(playerRef.current?.frameEl, index)) : null;
    if (!m) return setLayerOutline(null);
    const entry = layout[index];
    const stage = { w: tt.sceneVariant?.stage?.w || scene.meta.width, h: tt.sceneVariant?.stage?.h || scene.meta.height };
    const quad = layerPageQuad(v.params, asset, layer, stage, v.duration, time - entry.start - (v.start || 0));
    const r = inner.getBoundingClientRect();
    const pts = quad.map((q) => m.toScreen(q)).map(([x, y]) => [x - r.left, y - r.top]);
    const e = effectiveLayer(layer, v.params?.layers?.[layer.id]);
    setLayerOutline({ pts, name: layer.name || layer.id, role: e.role, hidden: e.hidden, id: layer.id });
  }, [layerHot, scene, layout, time, fit, buildTick]);

  const startPick = useCallback(
    (key) => {
      if (!key || !selAnchor) return setPick(null);
      const e = selAnchor.entry;
      if (!e) return studio.notify('Esta variante de escena no está en pantalla: activala con “Ver” para apuntar.', 'warn');
      // si la escena del clip no está a la vista, llevar el cursor adentro de su tramo
      if (!(time >= e.start && time < e.end)) {
        const tl = Math.min(selAnchor.clipStart, Math.max(0, e.duration - 1 / fps));
        seek(Math.round((e.start + tl) * fps) / fps);
      }
      setPick({ key, target: { ...selection } });
      setHover(null);
    },
    [selAnchor, selection, studio, time, fps, seek],
  );

  // cambiar de selección cancela la mira
  useEffect(() => setPick(null), [selection?.scene, selection?.clip]);

  const pickAt = useCallback(
    (ev, commit) => {
      const m = mapping();
      if (!m) {
        if (commit) studio.notify('La escena de este clip no se ve en este cuadro: mové el cursor a su tramo.', 'warn');
        return setHover(null);
      }
      const [x, y] = m.toPage(ev.clientX, ev.clientY).map((n) => Math.round(n));
      if (!commit) return setHover({ x, y, sx: ev.nativeEvent.offsetX, sy: ev.nativeEvent.offsetY });
      const { key, target } = pick;
      studio.edit((s) => {
        const tt = findTarget(s, target);
        const v = activeVariant(tt.holder);
        if (v) v.params = { ...(v.params || {}), [key]: [x, y] };
      });
      setPick(null);
      setHover(null);
    },
    [mapping, pick, studio],
  );

  const holderOfSelection = useMemo(() => {
    if (!scene || !selection) return null;
    return findTarget(scene, selection);
  }, [scene, selection]);

  // A/B: alterna entre la variante activa y la anterior del ítem seleccionado
  const toggleAB = useCallback(() => {
    const h = holderOfSelection?.holder;
    if (!h) return;
    const key = selection.scene + '/' + (selection.clip || '');
    const prev = abMemory.current[key];
    const cur = activeVariant(h)?.id;
    if (!prev || prev === cur) return studio.notify('A/B: primero mirá otra variante con “Ver”.');
    abMemory.current[key] = cur;
    studio.review({ ...selection, variant: prev }, 'activate');
  }, [holderOfSelection, selection, studio]);

  const activate = useCallback(
    (target) => {
      const key = target.scene + '/' + (target.clip || '');
      const h = findTarget(scene, target).holder;
      const cur = activeVariant(h)?.id;
      if (cur && cur !== target.variant) abMemory.current[key] = cur;
      studio.review(target, 'activate');
    },
    [scene, studio],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (confirmState) {
        if (e.key === 'Escape') answerConfirm(false);
        return;
      }
      if (guide?.visible) {
        if (e.key === 'Escape') setGuide((g) => (g?.id ? { ...g, visible: false } : null));
        return;
      }
      if (pick && e.key === 'Escape') {
        e.preventDefault();
        return setPick(null);
      }
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const step = e.shiftKey ? 1 : 1 / fps;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(time + step);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(time - step);
      } else if (e.key === 'Home') seek(loopOn && loop ? loop[0] : 0);
      else if (e.key === 'End') seek(duration);
      else if (e.key.toLowerCase() === 'l') setLoopOn((v) => !v);
      else if (e.key.toLowerCase() === 'a') toggleAB();
      else if (e.key.toLowerCase() === 'p' && selAnchor) startPick(pick ? null : selAnchor.anchors[0].key);
      else if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, time, duration, seek, togglePlay, toggleAB, loop, loopOn, confirmState, answerConfirm, pick, selAnchor, startPick, guide]);

  const openReqs = requests.filter((r) => r.status === 'queued' || r.status === 'running');

  if (!scene) return <div className="boot">Cargando estudio…</div>;

  const approvedCount = scene.scenes.filter((s) => s.variants.some((v) => v.status === 'approved')).length;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">¡POW!</span>
          <span className="title">{scene.meta.title}</span>
          <span className="dim">
            {scene.meta.width}×{scene.meta.height} · {duration.toFixed(2)}s
          </span>
          <label className="fps-pick" title="Configuración del proyecto: el preview y el export usan este fps">
            <select value={fps} onChange={(e) => studio.edit((s) => (s.meta.fps = +e.target.value))}>
              {[24, 30, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
              {![24, 30, 60].includes(fps) && <option value={fps}>{fps} fps</option>}
            </select>
          </label>
          <label className="fps-pick" title="Cuántas escenas se generan a la vez en la cola (dentro de una misma escena van en fila)">
            <select value={scene.meta.generatorConcurrency || 3} onChange={(e) => studio.edit((s) => (s.meta.generatorConcurrency = +e.target.value))}>
              {[1, 2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? 'cola en serie' : `${n} en paralelo`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="top-right">
          {GPU_LABEL[gpuBackend] && (
            <span className={'pill gpu ' + gpuBackend} title={GPU_TIP[gpuBackend]}>
              VFX: {GPU_LABEL[gpuBackend]}
            </span>
          )}
          <button className={'btn ghost draft-btn ' + (draft ? 'on' : '')} onClick={toggleDraft} title="Modo borrador: preview más liviano. Lo que ves no es la calidad final (el export siempre sale en calidad final).">
            Borrador {draft ? 'ON' : 'OFF'}
          </button>
          <span className={'pill ' + (validation.errors.length ? 'bad' : 'ok')} title={[...validation.errors, ...validation.warnings].join('\n') || 'sin problemas'}>
            {validation.errors.length ? `${validation.errors.length} errores` : 'válido'}
            {validation.warnings.length ? ` · ${validation.warnings.length} avisos` : ''}
          </span>
          <span className="pill">
            {approvedCount}/{scene.scenes.length} escenas aprobadas
          </span>
          <span className={'save ' + saveState}>{{ saved: 'guardado', dirty: 'sin guardar…', saving: 'guardando…', error: 'error al guardar' }[saveState]}</span>
          {guide?.id && !guide.visible && (
            <button className="btn ghost on" onClick={() => setGuide((g) => ({ ...g, visible: true }))} title="Hay un guiado abierto">
              Guiado <b className="badge">{guideSession?.status === 'question' ? '?' : '…'}</b>
            </button>
          )}
          <button className="btn ghost" onClick={() => openGuide(null)} title="Dirección general del proyecto (tono, cámara, ritmo…) — editala o revisala con el guiado">
            Dirección
          </button>
          <button className="btn ghost" onClick={() => setShowQueue(true)}>
            Cola {openReqs.length ? <b className="badge">{openReqs.length}</b> : null}
          </button>
          <button className="btn primary" onClick={() => setShowExport(true)}>
            {render.status === 'running' ? `Exportando ${Math.round(((render.frame || 0) / (render.frames || 1)) * 100)}%` : 'Exportar video'}
          </button>
        </div>
      </header>

      <main className="middle">
        <section className="stage" ref={stageRef} onClick={() => !pick && togglePlay()}>
          <div className="stage-inner" ref={innerRef} style={{ width: scene.meta.width * fit, height: scene.meta.height * fit }}>
            <div ref={hostRef} style={{ transform: `scale(${fit})`, transformOrigin: '0 0', width: scene.meta.width, height: scene.meta.height }} />
            {markers.map((m) => (
              <div key={m.key} className={'anchor-marker ' + (pick?.key === m.key ? 'dim' : '')} style={{ left: m.x, top: m.y }}>
                <svg width="34" height="34" viewBox="-17 -17 34 34">
                  <circle r="9" />
                  <path d="M-16 0H-5M5 0H16M0 -16V-5M0 5V16" />
                </svg>
                <span>
                  {m.label} {m.value[0]},{m.value[1]}
                </span>
              </div>
            ))}
            {layerOutline && (
              <svg className={'layer-outline r-' + layerOutline.role + (layerOutline.hidden ? ' off' : '')} width="100%" height="100%">
                <polygon points={layerOutline.pts.map((p) => p.join(',')).join(' ')} />
                <text x={Math.min(...layerOutline.pts.map((p) => p[0])) + 6} y={Math.max(14, Math.min(...layerOutline.pts.map((p) => p[1])) + 16)}>
                  {layerOutline.name}
                  {layerOutline.hidden ? ' (oculta)' : ''}
                </text>
              </svg>
            )}
            <AnimatePresence>
              {draft && (
                <motion.div key="draft" className="draft-stamp" initial={{ scale: 1.6, opacity: 0, rotate: -14 }} animate={{ scale: 1, opacity: 1, rotate: -8 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ type: 'spring', stiffness: 420, damping: 22 }}>
                  BORRADOR
                </motion.div>
              )}
            </AnimatePresence>
            {pick && (
              <div
                className="pick-layer"
                onPointerMove={(e) => pickAt(e, false)}
                onPointerLeave={() => setHover(null)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  pickAt(e, true);
                }}
              >
                {hover && (
                  <span className="pick-readout" style={{ left: hover.sx + 14, top: hover.sy + 14 }}>
                    {hover.x}, {hover.y}
                  </span>
                )}
              </div>
            )}
          </div>
          <AnimatePresence>
            {pick && (
              <motion.div key="pickbar" className="pick-banner" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
                ◎ Clic en el preview para ubicar <b>{selAnchor?.anchors.find((a) => a.key === pick.key)?.label || pick.key}</b> · Esc cancela
              </motion.div>
            )}
          </AnimatePresence>
          {!scene.scenes.length && <div className="empty">Todavía no hay escenas. Pedile a Claude que arme la primera con tus imágenes.</div>}
        </section>
        <Inspector
          studio={studio}
          scene={scene}
          presets={presets}
          selection={selection}
          setSelection={setSelection}
          requests={requests}
          activate={activate}
          layout={layout}
          pickAnchor={startPick}
          pickingKey={pick?.key}
          draft={draft}
          askConfirm={askConfirm}
          openGuide={openGuide}
          onLayerHot={setLayerHot}
        />
      </main>

      <section className="transport">
        <button className="btn icon" onClick={() => seek(loopOn && loop ? loop[0] : 0)} title="Inicio (Home)">
          ⏮
        </button>
        <button className="btn icon" onClick={() => seek(time - 1 / fps)} title="Cuadro anterior (←)">
          ◀︎
        </button>
        <button className="btn icon play" onClick={togglePlay} title="Play/pausa (espacio)">
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="btn icon" onClick={() => seek(time + 1 / fps)} title="Cuadro siguiente (→)">
          ▶︎
        </button>
        <span className="tc">
          {fmt(time, fps)} <span className="dim">/ {fmt(duration, fps)} · cuadro {frameOf(time, fps)}</span>
        </span>
        <button className={'btn ghost ' + (loopOn ? 'on' : '')} onClick={() => setLoopOn((v) => !v)} title="Loop (L). Shift+arrastrar en la regla marca el tramo.">
          Loop {loop ? `${loop[0].toFixed(2)}–${loop[1].toFixed(2)}s` : 'todo'}
        </button>
        <span className="hint dim">espacio play · ←/→ cuadro · shift ±1s · A alterna variantes · L loop · P apunta anchor VFX</span>
      </section>

      <Timeline scene={scene} presets={presets} layout={layout} time={time} fps={fps} duration={duration} seek={seek} edit={studio.edit} selection={selection} setSelection={setSelection} loop={loop} setLoop={(r) => { setLoop(r); setLoopOn(!!r); }} />

      <AnimatePresence>
        {showExport && <ExportDialog key="exp" studio={studio} render={render} onClose={() => setShowExport(false)} loop={loop} scene={scene} validation={validation} />}
        {confirmState && <ConfirmDialog key="confirm" title={confirmState.title} message={confirmState.message} okLabel={confirmState.okLabel} cancelLabel={confirmState.cancelLabel} onAnswer={answerConfirm} />}
        {guide?.visible && (guide.id ? guideSession : !guide.starting) && (
          <GuideDialog
            key="guide"
            studio={studio}
            scene={scene}
            session={guideSession}
            target={guide.target}
            onStart={startProjectGuide}
            onHide={() => setGuide((g) => (g?.id ? { ...g, visible: false } : null))}
            onDone={closeGuide}
          />
        )}
        {showQueue && <QueueDrawer key="q" requests={requests} onClose={() => setShowQueue(false)} cancel={studio.cancelRequest} setSelection={setSelection} />}
      </AnimatePresence>
      <AnimatePresence>
        {toast && (
          <motion.div key={toast.id} className={'toast ' + toast.kind} initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}>
            {toast.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
