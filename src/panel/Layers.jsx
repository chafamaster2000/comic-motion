// Editor de capas de una viñeta con asset `type: 'layers'`, y editor `between` de los VFX.
import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ENTERS } from '../player/presets.js';
import { Num, EaseSelect } from './Fields.jsx';
import { ROLES, ROLE_LABEL, DEPTH_RANGE, MOTION_KEYS, autoDepth, effectiveLayer, layersFrontToBack, setOverride, overrideCount, isEmptyMotion } from './layers.js';

const thumbUrl = (file) => (file ? '/p/' + String(file).replace(/^\/+/, '') : null);
const presetOf = (spec) => (typeof spec === 'string' ? spec : spec?.preset) || 'none';
const fmtNum = (n) => (Math.round(n * 100) / 100).toString();

export function LayersEditor({ asset, value, onChange, fps = 24, onHot }) {
  const [open, setOpen] = useState(null); // id con el desplegable de tiempos abierto
  const [sel, setSel] = useState(null); // capa fijada (resaltada aunque el mouse salga)
  const layers = layersFrontToBack(asset);
  const n = overrideCount(value);
  const backgrounds = layers.filter((l) => effectiveLayer(l, value?.[l.id]).role === 'background');
  const set = (layer, key, v) => onChange(setOverride(value, layer, key, v));
  const hot = (id) => onHot?.(id ?? sel);

  return (
    <div className="layers-ed" onPointerLeave={() => hot(null)}>
      <div className="layers-head">
        <span className="field-label">
          Capas <span className="dim">· {layers.length} · adelante → atrás</span>
        </span>
        <button className="btn tiny ghost" disabled={!n} onClick={() => onChange(undefined)} title="Borra todos los overrides: vuelve a lo que trae el asset">
          Restablecer capas{n ? ` (${n})` : ''}
        </button>
      </div>
      <div className="layer-list">
        {layers.map((l) => {
          const ov = value?.[l.id] || {};
          const e = effectiveLayer(l, ov);
          const auto = autoDepth(l);
          const isOpen = open === l.id;
          const timed = e.at != null || presetOf(e.enter) !== 'none' || presetOf(e.exit) !== 'none' || e.dur != null || !isEmptyMotion(e.motion) || e.clipTo;
          return (
            <motion.div
              layout="position"
              key={l.id}
              className={`layer-row r-${e.role} ${e.hidden ? 'off' : ''} ${sel === l.id ? 'sel' : ''} ${Object.keys(ov).length ? 'has-ov' : ''}`}
              data-layer={l.id}
              onPointerEnter={() => hot(l.id)}
            >
              <div className="layer-main">
                <button
                  className="layer-thumb"
                  title={`${l.name || l.id} · ${l.w}×${l.h} en ${l.x},${l.y} · z ${l.z}${sel === l.id ? ' (fijada: clic para soltar)' : ' (clic: fijar el contorno)'}`}
                  onClick={() => {
                    const next = sel === l.id ? null : l.id;
                    setSel(next);
                    onHot?.(next ?? l.id);
                  }}
                >
                  {thumbUrl(l.file) && <img src={thumbUrl(l.file)} alt="" loading="lazy" draggable={false} />}
                </button>
                <div className="layer-name">
                  <b title={l.id}>{l.name || l.id}</b>
                  <span className="dim">z {l.z}</span>
                </div>
                <select className={'role-chip r-' + e.role + (ov.role ? ' ov' : '')} value={e.role || ''} title="Rol de la capa (define cómo la trata el motor)" onChange={(ev) => set(l, 'role', ev.target.value)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                      {r === l.role && ov.role ? ' (asset)' : ''}
                    </option>
                  ))}
                  {e.role && !ROLES.includes(e.role) && <option value={e.role}>{e.role}</option>}
                </select>
                <button className={'eye ' + (e.hidden ? 'off' : '')} title={e.hidden ? 'Oculta: clic para mostrar' : 'Visible: clic para ocultar'} onClick={() => set(l, 'hidden', !e.hidden)}>
                  {e.hidden ? (
                    <svg viewBox="0 0 20 20" width="16" height="16"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3 17 17 3" stroke="currentColor" strokeWidth="1.6" /></svg>
                  ) : (
                    <svg viewBox="0 0 20 20" width="16" height="16"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="10" cy="10" r="2.6" fill="currentColor" /></svg>
                  )}
                </button>
              </div>
              <div className="layer-depth">
                <span className="dim">prof.</span>
                <span className="depth-slider">
                  <input type="range" className={ov.depth == null ? 'auto' : ''} min={DEPTH_RANGE.min} max={DEPTH_RANGE.max} step={DEPTH_RANGE.step} value={e.depth} onChange={(ev) => set(l, 'depth', parseFloat(ev.target.value))} />
                  <i className="auto-mark" style={{ left: `calc(7px + (100% - 14px) * ${(auto - DEPTH_RANGE.min) / (DEPTH_RANGE.max - DEPTH_RANGE.min)})` }} title={`automática: ${fmtNum(auto)}`} />
                </span>
                <input
                  type="number"
                  className="depth-num"
                  step={DEPTH_RANGE.step}
                  value={ov.depth ?? ''}
                  placeholder={fmtNum(auto)}
                  onChange={(ev) => set(l, 'depth', ev.target.value === '' ? undefined : parseFloat(ev.target.value))}
                />
                <button className={'btn tiny ghost auto-btn ' + (ov.depth == null ? 'is-auto' : '')} disabled={ov.depth == null} onClick={() => set(l, 'depth', undefined)} title="Volver a la profundidad automática del asset">
                  auto
                </button>
                <button className={'btn tiny ghost times-btn ' + (isOpen ? 'on' : '') + (timed ? ' timed' : '')} onClick={() => setOpen(isOpen ? null : l.id)} title="Entrada, salida y movimiento de la capa">
                  <motion.span animate={{ rotate: isOpen ? 90 : 0 }} style={{ display: 'inline-block' }}>
                    ▸
                  </motion.span>{' '}
                  tiempos{e.at != null ? ` · ${fmtNum(e.at)}s` : ''}
                </button>
              </div>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div className="layer-times" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
                    <LayerTimes layer={l} e={e} ov={ov} set={set} fps={fps} backgrounds={backgrounds} />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function LayerTimes({ layer, e, ov, set, fps, backgrounds }) {
  const snap = (t) => Math.max(0, Math.round(t * fps) / fps);
  const spec = (cur, preset) => (preset === 'none' ? undefined : typeof cur === 'object' && cur ? { ...cur, preset } : { preset });
  const m = e.motion || {};
  const setM = (k, v) => {
    const next = { ...m, [k]: v };
    if (v == null || Number.isNaN(v)) delete next[k];
    set(layer, 'motion', isEmptyMotion(next) ? undefined : next);
  };
  return (
    <div className="lt-grid">
      <label>
        <span>aparece</span>
        <Num value={e.at ?? ''} step={1 / fps} onChange={(v) => set(layer, 'at', snap(v))} suffix="s" />
        {ov.at != null && (
          <button className="btn tiny ghost" onClick={() => set(layer, 'at', undefined)} title="Sin tiempo propio (entra con la viñeta)">
            ✕
          </button>
        )}
      </label>
      <label>
        <span>dura</span>
        <Num value={e.dur ?? ''} step={1 / fps} onChange={(v) => set(layer, 'dur', v > 0 ? snap(v) : undefined)} suffix="s" />
      </label>
      <label>
        <span>entrada</span>
        <span className="lt-io">
          <select value={presetOf(e.enter)} onChange={(ev) => set(layer, 'enter', spec(e.enter, ev.target.value))}>
            {ENTERS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          {presetOf(e.enter) !== 'none' && <Num value={e.enter?.duration ?? 0.4} step={0.05} onChange={(d) => set(layer, 'enter', { ...(typeof e.enter === 'object' ? e.enter : { preset: presetOf(e.enter) }), duration: d })} suffix="s" />}
        </span>
      </label>
      <label>
        <span>salida</span>
        <span className="lt-io">
          <select value={presetOf(e.exit)} onChange={(ev) => set(layer, 'exit', spec(e.exit, ev.target.value))}>
            {ENTERS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          {presetOf(e.exit) !== 'none' && <Num value={e.exit?.duration ?? 0.3} step={0.05} onChange={(d) => set(layer, 'exit', { ...(typeof e.exit === 'object' ? e.exit : { preset: presetOf(e.exit) }), duration: d })} suffix="s" />}
        </span>
      </label>
      <div className="lt-motion">
        <span className="dim">movimiento (durante la viñeta)</span>
        <div className="lt-mgrid">
          {MOTION_KEYS.map((k) => (
            <label key={k.key}>
              <b>{k.label}</b>
              <Num value={m[k.key] ?? (k.key === 'scale' ? 1 : 0)} step={k.step} onChange={(v) => setM(k.key, v)} suffix={k.suffix} />
            </label>
          ))}
          <label className="span2">
            <b>ease</b>
            <EaseSelect value={m.ease} onChange={(v) => setM('ease', v)} />
          </label>
        </div>
      </div>
      <label>
        <span>recorte</span>
        <select value={e.clipTo ?? ''} onChange={(ev) => set(layer, 'clipTo', ev.target.value || null)} title="Recortar la capa a la silueta de un fondo, o dejarla libre (puede salirse del cuadro)">
          <option value="">libre</option>
          {backgrounds
            .filter((b) => b.id !== layer.id)
            .map((b) => (
              <option key={b.id} value={b.id}>
                dentro de {b.name || b.id}
              </option>
            ))}
          {e.clipTo && !backgrounds.some((b) => b.id === e.clipTo) && <option value={e.clipTo}>{e.clipTo} (no es fondo)</option>}
        </select>
      </label>
    </div>
  );
}

// Params de cámara de la viñeta de capas que el motor quizá todavía no declara.
export const LAYER_CAMERA_PARAMS = [
  { key: 'depthScale', label: 'Escala de profundidad', type: 'number', min: 0, max: 3, step: 0.05, default: 1 },
  { key: 'orbit', label: 'Órbita {yaw, pitch} (°)', type: 'orbit', default: null },
  { key: 'dof', label: 'Desenfoque de profundidad', type: 'number', min: 0, max: 1, step: 0.01, default: 0 },
];

export function OrbitField({ value, onChange }) {
  const v = value || {};
  const set = (k, n) => {
    const next = { ...v, [k]: n };
    onChange(!next.yaw && !next.pitch ? null : next);
  };
  return (
    <span className="orbit-field">
      <b>yaw</b>
      <Num value={v.yaw ?? 0} step={0.5} onChange={(n) => set('yaw', n)} suffix="°" />
      <b>pitch</b>
      <Num value={v.pitch ?? 0} step={0.5} onChange={(n) => set('pitch', n)} suffix="°" />
    </span>
  );
}

// between: [idAtrás, idAdelante] entre dos capas de la viñeta target, o null (usa el param Capa).
export function BetweenField({ value, onChange, layers, panelLabel, onHot }) {
  const list = layers || [];
  const pair = Array.isArray(value) && value.length === 2 ? value : null;
  if (!list.length)
    return <span className="dim between-none">{panelLabel ? `La viñeta ${panelLabel} no usa un asset de capas: se usa la capa back/mid/front.` : 'Sin viñeta de capas: se usa la capa back/mid/front.'}</span>;
  const z = (id) => list.find((l) => l.id === id)?.z;
  const bad = pair && z(pair[0]) != null && z(pair[1]) != null && z(pair[0]) >= z(pair[1]);
  const opts = (sel) => (
    <>
      {list.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name || l.id} · z{l.z}
        </option>
      ))}
      {sel && !list.some((l) => l.id === sel) && <option value={sel}>{sel} (no existe)</option>}
    </>
  );
  // por defecto: la primera de fondo y la siguiente por encima
  const start = () => {
    const back = [...list].reverse().find((l) => l.role === 'background') || list[list.length - 1];
    const front = [...list].reverse().find((l) => l.z > back.z) || list[0];
    onChange([back.id, front.id]);
  };
  return (
    <span className="between-field">
      <span className="seg mini">
        <button type="button" className={!pair ? 'on' : ''} onClick={() => onChange(null)} title="Usa el param Capa (back/mid/front)">
          capa back/mid/front
        </button>
        <button type="button" className={pair ? 'on' : ''} onClick={() => !pair && start()}>
          entre capas
        </button>
      </span>
      {pair && (
        <span className="between-sel">
          <label onPointerEnter={() => onHot?.(pair[0])} onPointerLeave={() => onHot?.(null)}>
            <b>atrás</b>
            <select value={pair[0]} onChange={(e) => onChange([e.target.value, pair[1]])}>
              {opts(pair[0])}
            </select>
          </label>
          <label onPointerEnter={() => onHot?.(pair[1])} onPointerLeave={() => onHot?.(null)}>
            <b>adelante</b>
            <select value={pair[1]} onChange={(e) => onChange([pair[0], e.target.value])}>
              {opts(pair[1])}
            </select>
          </label>
          {bad && <span className="warn-line">“atrás” está por encima de “adelante”: invertilas.</span>}
        </span>
      )}
    </span>
  );
}
