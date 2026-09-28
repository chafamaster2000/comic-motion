import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { createPlayer, loadCustomEffects } from '../player/player.js';
import { layoutScenes, totalDuration, findTarget, activeVariant } from '../shared/scene.js';
import { useStudio } from './useStudio.js';
import { Timeline } from './Timeline.jsx';
import { Inspector } from './Inspector.jsx';
import { ExportDialog, QueueDrawer } from './Dialogs.jsx';

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
  const abMemory = useRef({}); // holderKey -> variante anterior para A/B

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
    } else {
      playerRef.current.setScene(scene, customDefs);
    }
  }, [scene, customDefs]);

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
      else if (e.key === 'Escape') setSelection(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, time, duration, seek, togglePlay, toggleAB, loop, loopOn]);

  const openReqs = requests.filter((r) => r.status === 'queued' || r.status === 'running');

  if (!scene) return <div className="boot">Cargando estudio…</div>;

  const layout = layoutScenes(scene);
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
        </div>
        <div className="top-right">
          <span className={'pill ' + (validation.errors.length ? 'bad' : 'ok')} title={[...validation.errors, ...validation.warnings].join('\n') || 'sin problemas'}>
            {validation.errors.length ? `${validation.errors.length} errores` : 'válido'}
            {validation.warnings.length ? ` · ${validation.warnings.length} avisos` : ''}
          </span>
          <span className="pill">
            {approvedCount}/{scene.scenes.length} escenas aprobadas
          </span>
          <span className={'save ' + saveState}>{{ saved: 'guardado', dirty: 'sin guardar…', saving: 'guardando…', error: 'error al guardar' }[saveState]}</span>
          <button className="btn ghost" onClick={() => setShowQueue(true)}>
            Cola {openReqs.length ? <b className="badge">{openReqs.length}</b> : null}
          </button>
          <button className="btn primary" onClick={() => setShowExport(true)}>
            {render.status === 'running' ? `Exportando ${Math.round(((render.frame || 0) / (render.frames || 1)) * 100)}%` : 'Exportar video'}
          </button>
        </div>
      </header>

      <main className="middle">
        <section className="stage" ref={stageRef} onClick={() => togglePlay()}>
          <div className="stage-inner" style={{ width: scene.meta.width * fit, height: scene.meta.height * fit }}>
            <div ref={hostRef} style={{ transform: `scale(${fit})`, transformOrigin: '0 0', width: scene.meta.width, height: scene.meta.height }} />
          </div>
          {!scene.scenes.length && <div className="empty">Todavía no hay escenas. Pedile a Claude que arme la primera con tus imágenes.</div>}
        </section>
        <Inspector studio={studio} scene={scene} presets={presets} selection={selection} setSelection={setSelection} requests={requests} activate={activate} time={time} layout={layout} />
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
        <span className="hint dim">espacio play · ←/→ cuadro · shift ±1s · A alterna variantes · L loop</span>
      </section>

      <Timeline scene={scene} layout={layout} time={time} fps={fps} duration={duration} seek={seek} edit={studio.edit} selection={selection} setSelection={setSelection} loop={loop} setLoop={(r) => { setLoop(r); setLoopOn(!!r); }} />

      <AnimatePresence>
        {showExport && <ExportDialog key="exp" studio={studio} render={render} onClose={() => setShowExport(false)} loop={loop} scene={scene} validation={validation} />}
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
