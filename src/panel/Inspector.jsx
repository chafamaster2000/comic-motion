import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { activeVariant, findTarget, isStale } from '../shared/scene.js';
import { trackLabel, panelsOf } from './tracks.js';
import { Field, Num, EaseSelect } from './Fields.jsx';
import { LayersEditor, BetweenField, OrbitField, LAYER_CAMERA_PARAMS } from './Layers.jsx';
import { layersAssetOf, isLayersParam, isLayerPairParam, layersFrontToBack } from './layers.js';

const STATUS_LABEL = { draft: 'borrador', approved: 'aprobada', rejected: 'rechazada', hidden: 'escondida', stale: 'aprobada · desactualizada' };

export function Inspector({ studio, scene, presets, selection, setSelection, requests, activate, layout, pickAnchor, pickingKey, draft, askConfirm, openGuide, onLayerHot }) {
  const t = selection ? findTarget(scene, selection) : {};
  const byKind = useMemo(() => {
    const m = {};
    for (const d of presets.builtin) (m[d.kind] = m[d.kind] || []).push(d);
    return m;
  }, [presets]);

  if (!selection || !t.holder) {
    return (
      <aside className="inspector">
        <h3>Escenas</h3>
        <div className="scene-list">
          {layout.map((e) => {
            const ap = e.scene.variants.find((v) => v.status === 'approved');
            return (
              <button key={e.scene.id} className="scene-item" onClick={() => setSelection({ scene: e.scene.id })}>
                <span className={'dot ' + (ap ? (isStale(ap, 'scene') ? 'stale' : 'approved') : e.variant.status)} />
                <b>{e.scene.title || e.scene.id}</b>
                <span className="dim">
                  {e.start.toFixed(1)}–{e.end.toFixed(1)}s · {e.variant.id}
                </span>
              </button>
            );
          })}
        </div>
        <div className="help">
          <p>
            Clic en una escena o clip de la línea de tiempo para revisarlo. Cada ítem tiene <b>variantes</b>: miralas con <b>Ver</b>, alterná con <kbd>A</kbd>, y
            <b> aprobá</b> o <b>rechazá</b> diciendo qué sí y qué no. Eso queda guardado y Claude lo usa en las próximas variantes.
          </p>
          <p>
            Arrastrá clips para mover, los bordes para cambiar duración. Todo se guarda en <code>scene.json</code>.
          </p>
        </div>
      </aside>
    );
  }

  const isClip = t.level === 'clip';
  const holder = t.holder;
  const v = activeVariant(holder);
  const baseTarget = { scene: selection.scene, clip: selection.clip, sceneVariant: isClip ? t.sceneVariant?.id : undefined };

  const editActive = (fn) =>
    studio.edit((s) => {
      const tt = findTarget(s, baseTarget);
      fn(activeVariant(tt.holder), tt.holder);
    });

  return (
    <aside className="inspector">
      <div className="insp-head">
        <button className="btn tiny ghost" onClick={() => setSelection(isClip ? { scene: selection.scene } : null)}>
          ← {isClip ? 'escena' : 'todas'}
        </button>
        <span className={'kind k-' + (isClip ? holder.track : 'scene')}>{isClip ? trackLabel(holder.track) : 'Escena'}</span>
        <input className="name" value={(isClip ? holder.label : holder.title) || ''} placeholder={holder.id} onChange={(e) => studio.edit((s) => {
          const h = findTarget(s, baseTarget).holder;
          if (isClip) h.label = e.target.value;
          else h.title = e.target.value;
        })} />
      </div>

      <VariantPanel studio={studio} holder={holder} level={t.level} baseTarget={baseTarget} requests={requests} activate={activate} scene={scene} draft={draft} askConfirm={askConfirm} openGuide={openGuide} />

      {v && (
        <div className="editor">
          <h4>
            Ajustes de <em>{v.id}</em> <span className="dim">(se guardan en la variante activa)</span>
          </h4>
          {isClip ? (
            <ClipEditor v={v} holder={holder} editActive={editActive} byKind={byKind} presets={presets} scene={scene} sceneVariant={t.sceneVariant} pickAnchor={pickAnchor} pickingKey={pickingKey} onLayerHot={onLayerHot ? (id) => onLayerHot(id && (typeof id === 'object' ? { ...baseTarget, ...id } : { ...baseTarget, layer: id })) : null} />
          ) : (
            <SceneEditor v={v} editActive={editActive} byKind={byKind} setSelection={setSelection} selection={selection} />
          )}
        </div>
      )}
    </aside>
  );
}

function SceneEditor({ v, editActive, byKind, setSelection, selection }) {
  const trans = v.transition || { preset: 'cut', duration: 0 };
  const tdef = (byKind.transition || []).find((d) => d.id === trans.preset);
  return (
    <>
      <label className="field">
        <span className="field-label">Duración</span>
        <Num value={v.duration} step={1 / 24} min={0.5} max={30} onChange={(d) => editActive((x) => (x.duration = d))} suffix="s" />
      </label>
      <label className="field">
        <span className="field-label">Transición de entrada</span>
        <select value={trans.preset} onChange={(e) => editActive((x) => (x.transition = { ...trans, preset: e.target.value, duration: trans.duration || 0.5, params: {} }))}>
          {(byKind.transition || []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {trans.preset !== 'cut' && (
        <>
          <label className="field">
            <span className="field-label">Duración de transición</span>
            <Num value={trans.duration} step={1 / 24} min={0} max={3} onChange={(d) => editActive((x) => (x.transition = { ...trans, duration: d }))} suffix="s" />
          </label>
          <label className="field">
            <span className="field-label">Ease</span>
            <EaseSelect value={trans.ease} onChange={(ease) => editActive((x) => (x.transition = { ...trans, ease }))} />
          </label>
          {(tdef?.params || []).map((p) => (
            <Field key={p.key} def={p} value={trans.params?.[p.key] ?? tdef.defaults?.[p.key]} onChange={(val) => editActive((x) => (x.transition = { ...trans, params: { ...(trans.params || {}), [p.key]: val } }))} />
          ))}
        </>
      )}
      <label className="field">
        <span className="field-label">Fondo de página</span>
        <input type="color" value={v.stage?.background || '#f4efe3'} onChange={(e) => editActive((x) => (x.stage = { ...(x.stage || {}), background: e.target.value }))} />
      </label>
      <h4>Clips</h4>
      <div className="clip-list">
        {(v.clips || []).map((c) => {
          const cv = activeVariant(c);
          return (
            <button key={c.id} className="scene-item" onClick={() => setSelection({ scene: selection.scene, clip: c.id, sceneVariant: v.id })}>
              <span className={'dot ' + (cv ? (isStale(cv, 'clip') ? 'stale' : cv.status) : '')} />
              <b>{c.label || c.id}</b>
              <span className="dim">
                {trackLabel(c.track)} · {cv?.preset} · {c.variants.length} var.
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function ClipEditor({ v, holder, editActive, byKind, presets, scene, sceneVariant, pickAnchor, pickingKey, onLayerHot }) {
  const kind = holder.track;
  const options = [...(byKind[kind] || []), ...presets.custom];
  const def = presets.builtin.find((d) => d.id === v.preset);
  const fps = scene.meta.fps || 24;
  const setParam = (key) => (val) =>
    editActive((x) => {
      const params = { ...(x.params || {}) };
      if (val === undefined) delete params[key];
      else params[key] = val;
      x.params = params;
    });
  // viñeta de capas: la propia (preset panel) o la target (VFX)
  const lasset = layersAssetOf(scene, v.params);
  const declared = new Set((def?.params || []).map((p) => p.key));
  const target = kind === 'vfx' || (def?.params || []).some(isLayerPairParam) ? targetPanel(sceneVariant, v.params?.target) : null;
  const targetAsset = target ? layersAssetOf(scene, activeVariant(target)?.params) : null;
  const layersEditor = lasset && (
    <LayersEditor key="__layers" asset={lasset} value={v.params?.layers} onChange={setParam('layers')} fps={fps} onHot={onLayerHot} />
  );
  // resaltar en el preview la capa elegida de la viñeta target
  const onTargetHot = onLayerHot && target ? (id) => onLayerHot(id ? { clip: target.id, layer: id } : null) : null;
  const between = (p, value) => (
    <div key={p.key} className="field f-between">
      <span className="field-label">{p.label || 'Entre capas'}</span>
      <BetweenField value={value} onChange={(val) => setParam(p.key)(val ?? undefined)} layers={targetAsset ? layersFrontToBack(targetAsset) : null} panelLabel={target ? target.label || target.id : null} onHot={onTargetHot} />
    </div>
  );
  return (
    <>
      <label className="field">
        <span className="field-label">Preset</span>
        <select value={v.preset} onChange={(e) => editActive((x) => (x.preset = e.target.value))}>
          {options.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
              {d.custom ? ' (custom)' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="row2">
        <label className="field">
          <span className="field-label">Inicio</span>
          <Num value={v.start} step={1 / 24} onChange={(d) => editActive((x) => (x.start = Math.max(0, d)))} suffix="s" />
        </label>
        <label className="field">
          <span className="field-label">Duración</span>
          <Num value={v.duration} step={1 / 24} onChange={(d) => editActive((x) => (x.duration = Math.max(1 / 24, d)))} suffix="s" />
        </label>
      </div>
      {(def?.params || []).map((p) => {
        const value = v.params?.[p.key] ?? def.defaults?.[p.key];
        if (isLayersParam(p, lasset)) return layersEditor || null;
        if (isLayerPairParam(p)) return between(p, value);
        if (lasset && p.key === 'orbit') return <OrbitRow key={p.key} p={p} value={value} onChange={setParam(p.key)} />;
        return (
          <Field
            key={p.key}
            def={p}
            value={value}
            ctx={{ assets: scene.assets, filters: byKind.filter, panels: panelsOf(sceneVariant), pickAnchor, pickingKey }}
            onChange={(val) => editActive((x) => (x.params = { ...(x.params || {}), [p.key]: val }))}
          />
        );
      })}
      {/* el motor todavía no declara estos params: igual se editan (se guardan en params) */}
      {lasset && !(def?.params || []).some((p) => isLayersParam(p, lasset)) && layersEditor}
      {lasset &&
        LAYER_CAMERA_PARAMS.filter((p) => !declared.has(p.key)).map((p) =>
          p.type === 'orbit' ? <OrbitRow key={p.key} p={p} value={v.params?.[p.key]} onChange={setParam(p.key)} /> : <Field key={p.key} def={p} value={v.params?.[p.key] ?? p.default} onChange={setParam(p.key)} />,
        )}
      {kind === 'vfx' && targetAsset && !(def?.params || []).some(isLayerPairParam) && between({ key: 'between', label: 'Entre capas' }, v.params?.between)}
      {!def && <Field def={{ key: 'params', label: 'Parámetros (efecto custom)', type: 'json' }} value={v.params} onChange={(val) => editActive((x) => (x.params = val || {}))} />}
    </>
  );
}

function OrbitRow({ p, value, onChange }) {
  return (
    <div className="field f-orbit">
      <span className="field-label">{p.label || p.key}</span>
      <OrbitField value={value} onChange={(v) => onChange(v ?? undefined)} />
    </div>
  );
}

// viñeta target de un VFX: la nombrada, o la primera de la escena
function targetPanel(sceneVariant, id) {
  const panels = (sceneVariant?.clips || []).filter((c) => c.track === 'panel');
  return (id && panels.find((c) => c.id === id)) || (!id ? panels[0] : null) || null;
}

// ---------- variantes ----------
function VariantPanel({ studio, holder, level, baseTarget, requests, activate, scene, draft, askConfirm, openGuide }) {
  const [showHidden, setShowHidden] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [count, setCount] = useState(scene.meta.maxVariants || 3);
  const active = activeVariant(holder)?.id;
  const mine = requests.filter((r) => r.target.scene === baseTarget.scene && (r.target.clip || null) === (baseTarget.clip || null) && ['queued', 'running', 'error'].includes(r.status));
  const visible = holder.variants.filter((v) => showHidden || v.status !== 'hidden');
  const hiddenN = holder.variants.length - holder.variants.filter((v) => v.status !== 'hidden').length;
  return (
    <div className="variants">
      <div className="ask">
        <textarea rows={2} value={prompt} placeholder="¿Qué querés probar? Ej: “más violento, que el ¡BAM! entre justo con el golpe”" onChange={(e) => setPrompt(e.target.value)} />
        <div className="ask-row">
          <select value={count} onChange={(e) => setCount(+e.target.value)}>
            {Array.from({ length: scene.meta.maxVariants || 3 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} variante{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
          <button
            className="btn primary"
            onClick={() => {
              studio.requestVariants({ target: baseTarget, kind: 'variants', count, instruction: prompt, from: active });
              setPrompt('');
            }}
          >
            Generar variantes
          </button>
          <button
            className="btn guide-btn"
            title="Claude te hace preguntas (de a una, con recomendación) antes de generar. Usa el texto de arriba como punto de partida."
            onClick={() => {
              openGuide?.(baseTarget, prompt.trim());
              setPrompt('');
            }}
          >
            Guiado
          </button>
        </div>
      </div>
      <AnimatePresence>
        {mine.map((r) => (
          <motion.div key={r.id} className={'req ' + r.status} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
            {r.status === 'error' ? '✗' : <span className="spin" />} {r.kind === 'retouch' ? `retoque de ${r.from}` : `${r.count} variante(s)`} · {r.status === 'queued' ? 'en cola' : r.status === 'running' ? 'generando…' : r.error}
            {r.instruction && <span className="dim"> · “{r.instruction}”</span>}
            {r.status !== 'error' && (
              <button className="btn tiny ghost" onClick={() => studio.cancelRequest(r.id)}>
                cancelar
              </button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      <div className="cards">
        <AnimatePresence initial={false}>
          {visible.map((v) => (
            <VariantCard key={v.id} v={v} level={level} active={v.id === active} target={{ ...baseTarget, variant: v.id }} studio={studio} activate={activate} maxVariants={scene.meta.maxVariants || 3} draft={draft} askConfirm={askConfirm} />
          ))}
        </AnimatePresence>
      </div>
      {hiddenN > 0 && (
        <button className="btn tiny ghost" onClick={() => setShowHidden((x) => !x)}>
          {showHidden ? 'ocultar escondidas' : `ver ${hiddenN} escondida(s)`}
        </button>
      )}
    </div>
  );
}

function VariantCard({ v, level, active, target, studio, activate, maxVariants, draft, askConfirm }) {
  const [mode, setMode] = useState(null); // approve | reject | retouch
  const [text, setText] = useState('');
  const [n, setN] = useState(1);
  const st = isStale(v, level) ? 'stale' : v.status;
  const submit = async () => {
    if (mode === 'approve') {
      if (draft && askConfirm) {
        const ok = await askConfirm({
          title: 'Modo borrador activo',
          message: 'Estás en modo borrador: lo que ves no es la calidad final. ¿Aprobar igual?',
          okLabel: 'Aprobar igual',
          cancelLabel: 'Volver',
        });
        if (!ok) return;
      }
      studio.review(target, 'approve', text.trim() || undefined);
    }
    if (mode === 'reject') {
      if (!text.trim()) return studio.notify('Contá qué no funciona: es lo que evita que la próxima variante repita el error.', 'warn');
      studio.review(target, 'reject', text.trim());
    }
    if (mode === 'retouch') {
      if (!text.trim()) return;
      const { variant, ...t } = target;
      studio.requestVariants({ target: t, kind: 'retouch', count: n, instruction: text.trim(), from: variant });
    }
    setMode(null);
    setText('');
  };
  return (
    <motion.div layout className={`card ${st} ${active ? 'active' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
      <div className="card-head">
        <b>{v.id}</b>
        <span className={'chip ' + st}>{STATUS_LABEL[st]}</span>
        {active && <span className="chip live">en pantalla</span>}
        {v.parent && <span className="dim">← {v.parent}</span>}
      </div>
      {v.summary && <div className="summary">{v.summary}</div>}
      {v.instruction && <div className="line">pedido: “{v.instruction}”</div>}
      {v.note && <div className="line ok">✓ {v.note}</div>}
      {v.rejection && <div className="line bad">✗ {v.rejection}</div>}
      <div className="card-actions">
        {!active && (
          <button className="btn tiny" onClick={() => activate(target)}>
            Ver
          </button>
        )}
        {v.status !== 'approved' || st === 'stale' ? (
          <button className="btn tiny ok" onClick={() => setMode(mode === 'approve' ? null : 'approve')}>
            Aprobar
          </button>
        ) : (
          <button className="btn tiny ghost" onClick={() => studio.review(target, 'unapprove')}>
            Desaprobar
          </button>
        )}
        {v.status !== 'rejected' && (
          <button className="btn tiny bad" onClick={() => setMode(mode === 'reject' ? null : 'reject')}>
            Rechazar
          </button>
        )}
        <button className="btn tiny" onClick={() => setMode(mode === 'retouch' ? null : 'retouch')}>
          Retocar
        </button>
        {v.status === 'hidden' ? (
          <button className="btn tiny ghost" onClick={() => studio.review(target, 'restore')}>
            Restaurar
          </button>
        ) : (
          <button className="btn tiny ghost" onClick={() => studio.review(target, 'hide')}>
            Esconder
          </button>
        )}
      </div>
      <AnimatePresence>
        {mode && (
          <motion.div className="card-form" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <textarea
              autoFocus
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}
              placeholder={
                { approve: '¿Qué te gusta? (opcional, se respeta en próximas variantes)', reject: '¿Qué no funciona? (obligatorio)', retouch: '¿Qué cambio le hago a esta variante?' }[mode]
              }
            />
            <div className="ask-row">
              {mode === 'retouch' && (
                <select value={n} onChange={(e) => setN(+e.target.value)}>
                  {Array.from({ length: maxVariants }, (_, i) => i + 1).map((k) => (
                    <option key={k} value={k}>
                      {k} versión{k > 1 ? 'es' : ''}
                    </option>
                  ))}
                </select>
              )}
              <button className={'btn ' + (mode === 'reject' ? 'bad' : 'primary')} onClick={submit}>
                {{ approve: 'Aprobar', reject: 'Rechazar', retouch: 'Retocar' }[mode]}
              </button>
              <span className="dim">⌘↵</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
