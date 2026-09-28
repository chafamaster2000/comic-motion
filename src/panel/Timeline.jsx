import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TRACKS, TRACK_LABELS, activeVariant, activeClips, isStale } from '../shared/scene.js';

const GUTTER = 118;
const LANE = 26;

function statusClass(v, level) {
  if (!v) return '';
  if (isStale(v, level)) return 'stale';
  return v.status;
}

export function Timeline({ scene, layout, time, fps, duration, seek, edit, selection, setSelection, loop, setLoop }) {
  const scrollRef = useRef(null);
  const [pps, setPps] = useState(null); // píxeles por segundo
  const drag = useRef(null);

  useEffect(() => {
    if (pps || !scrollRef.current || !duration) return;
    setPps(Math.max(40, Math.min(400, (scrollRef.current.clientWidth - GUTTER - 40) / Math.max(duration, 1))));
  }, [duration, pps]);
  const k = pps || 100;
  const width = GUTTER + Math.max(duration + 2, 10) * k;
  const snap = (t) => Math.round(t * fps) / fps;

  // carriles por pista (sin solapamientos visuales)
  const rows = useMemo(() => {
    const out = [];
    for (const track of TRACKS) {
      const items = [];
      for (const e of layout) {
        for (const { clip, variant } of activeClips(e.variant)) {
          if (clip.track !== track) continue;
          items.push({ e, clip, variant, a: e.start + variant.start, b: e.start + variant.start + variant.duration });
        }
      }
      items.sort((p, q) => p.a - q.a);
      const lanes = [];
      for (const it of items) {
        let li = lanes.findIndex((end) => end <= it.a + 1e-6);
        if (li === -1) {
          li = lanes.length;
          lanes.push(0);
        }
        lanes[li] = it.b;
        it.lane = li;
      }
      out.push({ track, items, lanes: Math.max(1, lanes.length) });
    }
    return out;
  }, [layout]);

  const xToT = (clientX) => {
    const r = scrollRef.current.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + scrollRef.current.scrollLeft - GUTTER) / k);
  };

  // ---- arrastres ----
  const onPointerMove = (ev) => {
    const d = drag.current;
    if (!d) return;
    const dt = (ev.clientX - d.x0) / k;
    if (d.kind === 'scrub') return seek(snap(xToT(ev.clientX)));
    if (d.kind === 'loop') {
      const t = snap(xToT(ev.clientX));
      return setLoop([Math.min(d.t0, t), Math.max(d.t0, t)]);
    }
    d.moved = true;
    if (d.kind === 'clip') {
      edit((s) => {
        const sh = s.scenes.find((x) => x.id === d.sceneId);
        const sv = activeVariant(sh);
        const c = sv.clips.find((x) => x.id === d.clipId);
        const v = activeVariant(c);
        if (d.mode === 'move') v.start = Math.max(0, snap(d.start + dt));
        else if (d.mode === 'left') {
          const ns = Math.max(0, Math.min(d.start + d.dur - 1 / fps, snap(d.start + dt)));
          v.duration = snap(d.start + d.dur - ns);
          v.start = ns;
        } else v.duration = Math.max(1 / fps, snap(d.dur + dt));
      });
    } else if (d.kind === 'scene') {
      edit((s) => {
        const sh = s.scenes.find((x) => x.id === d.sceneId);
        activeVariant(sh).duration = Math.max(0.25, snap(d.dur + dt));
      });
    } else if (d.kind === 'trans') {
      edit((s) => {
        const sh = s.scenes.find((x) => x.id === d.sceneId);
        const v = activeVariant(sh);
        v.transition = { ...(v.transition || { preset: 'fade' }), duration: Math.max(0, snap(d.dur - dt)) };
      });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };
  const startDrag = (ev, d) => {
    ev.stopPropagation();
    ev.preventDefault();
    drag.current = { x0: ev.clientX, ...d };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setPps((p) => Math.max(15, Math.min(1200, (p || 100) * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  };

  const ticks = [];
  const every = k > 160 ? 0.5 : k > 60 ? 1 : k > 25 ? 2 : 5;
  for (let t = 0; t <= duration + 2; t += every) ticks.push(t);

  const isSel = (sceneId, clipId) => selection && selection.scene === sceneId && (selection.clip || null) === (clipId || null);

  return (
    <section className="timeline" ref={scrollRef} onWheel={onWheel}>
      <div className="tl-inner" style={{ width }}>
        {/* regla */}
        <div
          className="tl-row ruler"
          onPointerDown={(e) => {
            const t = snap(xToT(e.clientX));
            if (e.shiftKey) startDrag(e, { kind: 'loop', t0: t });
            else {
              seek(t);
              startDrag(e, { kind: 'scrub' });
            }
          }}
        >
          <div className="tl-label">
            <span className="dim">ctrl+rueda: zoom</span>
          </div>
          {ticks.map((t) => (
            <div key={t} className="tick" style={{ left: GUTTER + t * k }}>
              <span>{Number.isInteger(t) ? t + 's' : ''}</span>
            </div>
          ))}
          {loop && <div className="loop-range" style={{ left: GUTTER + loop[0] * k, width: (loop[1] - loop[0]) * k }} onDoubleClick={() => setLoop(null)} title="doble clic para quitar el loop" />}
        </div>

        {/* escenas */}
        <div className="tl-row scenes">
          <div className="tl-label">Escenas</div>
          {layout.map((e) => {
            const v = e.variant;
            const nVar = e.scene.variants.filter((x) => x.status !== 'hidden').length;
            return (
              <div
                key={e.scene.id}
                className={`blk scene ${statusClass(v, 'scene')} ${isSel(e.scene.id) ? 'sel' : ''}`}
                style={{ left: GUTTER + e.start * k, width: e.duration * k }}
                onPointerDown={(ev) => {
                  setSelection({ scene: e.scene.id });
                  seek(Math.max(e.start, xToT(ev.clientX)));
                }}
                title={`${e.scene.title || e.scene.id} · ${v.id} · ${v.status}`}
              >
                {e.transitionDuration > 0 && (
                  <div className="trans" style={{ width: e.transitionDuration * k }} title={`transición ${e.transition.preset} ${e.transitionDuration}s (arrastrá el borde)`} onPointerDown={(ev) => startDrag(ev, { kind: 'trans', sceneId: e.scene.id, dur: e.transitionDuration })}>
                    <span>{e.transition.preset}</span>
                  </div>
                )}
                <span className="blk-text">
                  {e.scene.title || e.scene.id} <em>{v.id}</em>
                  {nVar > 1 && <b className="nv">{nVar}</b>}
                </span>
                <div className="grip r" onPointerDown={(ev) => startDrag(ev, { kind: 'scene', sceneId: e.scene.id, dur: e.duration })} />
              </div>
            );
          })}
        </div>

        {/* pistas */}
        {rows.map(({ track, items, lanes }) => (
          <div key={track} className={'tl-row track t-' + track} style={{ height: lanes * LANE + 6 }} onPointerDown={(e) => seek(snap(xToT(e.clientX)))}>
            <div className="tl-label">{TRACK_LABELS[track]}</div>
            {items.map(({ e, clip, variant, lane }) => {
              const nVar = clip.variants.filter((x) => x.status !== 'hidden').length;
              return (
                <div
                  key={e.scene.id + clip.id}
                  className={`blk clip ${statusClass(variant, 'clip')} ${isSel(e.scene.id, clip.id) ? 'sel' : ''}`}
                  style={{ left: GUTTER + (e.start + variant.start) * k, width: Math.max(6, variant.duration * k), top: 3 + lane * LANE }}
                  title={`${clip.label || clip.id} · ${variant.preset} · ${variant.id} · ${variant.start}s +${variant.duration}s`}
                  onPointerDown={(ev) => {
                    setSelection({ scene: e.scene.id, clip: clip.id, sceneVariant: e.variant.id });
                    startDrag(ev, { kind: 'clip', mode: 'move', sceneId: e.scene.id, clipId: clip.id, start: variant.start, dur: variant.duration });
                  }}
                >
                  <div className="grip l" onPointerDown={(ev) => startDrag(ev, { kind: 'clip', mode: 'left', sceneId: e.scene.id, clipId: clip.id, start: variant.start, dur: variant.duration })} />
                  <span className="blk-text">
                    {clip.label || clip.id}
                    {nVar > 1 && <b className="nv">{nVar}</b>}
                  </span>
                  <div className="grip r" onPointerDown={(ev) => startDrag(ev, { kind: 'clip', mode: 'right', sceneId: e.scene.id, clipId: clip.id, start: variant.start, dur: variant.duration })} />
                </div>
              );
            })}
          </div>
        ))}
        <div className="playhead" style={{ left: GUTTER + time * k }} />
      </div>
    </section>
  );
}
