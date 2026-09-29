// Modo guiado: el modelo pregunta de a una, con recomendación, hasta tener claro el cambio.
// El estado vive en el server (.comic/guides/<id>.json) y llega por SSE; este diálogo solo lo muestra.
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Backdrop } from './Dialogs.jsx';

export function guideTargetLabel(scene, target) {
  if (!target) return { main: 'Proyecto', sub: 'dirección general' };
  const s = scene.scenes.find((x) => x.id === target.scene);
  if (!target.clip) return { main: `${target.scene} · ${s?.title || ''}`.replace(/ · $/, ''), sub: 'escena' };
  const sv = s?.variants.find((v) => v.id === target.sceneVariant);
  const c = (sv || s?.variants[0])?.clips?.find((x) => x.id === target.clip);
  return { main: `${target.scene} / ${target.clip}`, sub: c?.label && c.label !== target.clip ? c.label : 'clip' };
}

const swap = { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 }, transition: { duration: 0.18 } };

export function GuideDialog({ studio, scene, session, target, onStart, onHide, onDone }) {
  const t = session ? session.target : target;
  const label = guideTargetLabel(scene, t);
  const status = session?.status || 'intro';
  const holderDir = t ? scene.scenes.find((s) => s.id === t.scene)?.direction : null;
  const act = (action, body) => studio.guideAction(session.id, action, body);

  return (
    <Backdrop onClose={onHide}>
      <motion.div className="dialog guide" role="dialog" aria-modal="true" initial={{ y: 30, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 30, scale: 0.97 }}>
        <div className="guide-head">
          <span className="guide-tag">Guiado</span>
          <b className="guide-target">{label.main}</b>
          <span className="dim">{label.sub}</span>
          {session?.turn > 0 && <span className="dim guide-turn">turno {session.turn}</span>}
          <button className="btn tiny ghost guide-x" onClick={onHide} title="Ocultar (la sesión sigue abierta)">
            ✕
          </button>
        </div>
        {session?.instruction && <div className="guide-instr">“{session.instruction}”</div>}
        {holderDir && Object.keys(holderDir).length > 0 && (
          <div className="guide-dirchips">
            {Object.entries(holderDir).map(([k, v]) => (
              <span key={k} className="chip" title={v}>
                {k}: {v}
              </span>
            ))}
          </div>
        )}
        {session?.transcript?.length > 0 && <Transcript items={session.transcript} />}

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={status + ':' + (session?.turn || 0)} {...swap}>
            {status === 'intro' && <Intro studio={studio} scene={scene} onStart={onStart} />}
            {status === 'thinking' && <Thinking session={session} onCancel={() => act('cancel')} />}
            {status === 'question' && <Question q={session.question} onAnswer={(a) => act('answer', { answer: a })} onFinish={() => act('finish')} />}
            {status === 'done' && <Done scene={scene} session={session} act={act} onDone={onDone} />}
            {status === 'error' && (
              <div className="guide-body">
                <div className="warnbox bad">
                  El turno falló: {session.error}
                  {session.log && (
                    <div className="dim">
                      log: <code>{session.log}</code>
                    </div>
                  )}
                </div>
                <div className="dialog-actions">
                  <button className="btn ghost" onClick={async () => (await act('cancel')) && onDone()}>
                    Descartar
                  </button>
                  <button className="btn primary" onClick={() => act('retry')}>
                    Reintentar
                  </button>
                </div>
              </div>
            )}
            {(status === 'cancelled' || status === 'applied') && (
              <div className="guide-body">
                <p className="dim">{status === 'cancelled' ? 'Sesión cancelada.' : 'Ya se aplicó.'}</p>
                <div className="dialog-actions">
                  <button className="btn primary" onClick={onDone}>
                    Cerrar
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </Backdrop>
  );
}

function Transcript({ items }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [items.length]);
  return (
    <ol className="guide-log" ref={ref}>
      {items.map((it, i) => (
        <li key={i}>
          <span className="q">{it.question}</span>
          <span className="a">→ {it.answer}</span>
        </li>
      ))}
    </ol>
  );
}

function Thinking({ session, onCancel }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const secs = session.turnStartedAt ? Math.max(0, Math.round((now - Date.parse(session.turnStartedAt)) / 1000)) : 0;
  return (
    <div className="guide-body guide-thinking">
      <span className="spin big" />
      <div>
        <b>{session.finish ? 'Cerrando con lo que hay…' : 'Pensando…'}</b>
        <div className="dim">Mirando la escena y el material · {secs}s</div>
      </div>
      <button className="btn ghost" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  );
}

function Question({ q, onAnswer, onFinish }) {
  const [free, setFree] = useState('');
  const [sent, setSent] = useState(false);
  const send = (text) => {
    if (sent || !text.trim()) return;
    setSent(true);
    Promise.resolve(onAnswer(text.trim())).then((ok) => !ok && setSent(false));
  };
  const pick = (o) => send(o.description ? `${o.label} — ${o.description}` : o.label);
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const n = +e.key;
      if (n >= 1 && n <= q.options.length) {
        e.preventDefault();
        pick(q.options[n - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="guide-body">
      <h3 className="guide-q">{q.question}</h3>
      {q.why && <p className="guide-why">{q.why}</p>}
      <div className="guide-opts">
        {q.options.map((o, i) => (
          <motion.button
            key={i}
            className={'guide-opt ' + (o.recommended ? 'rec' : '')}
            onClick={() => pick(o)}
            disabled={sent}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.04 * i }}
            whileHover={{ x: 3 }}
            whileTap={{ scale: 0.98 }}
          >
            <kbd>{i + 1}</kbd>
            <span className="opt-text">
              <b>{o.label}</b>
              {o.recommended && <span className="chip rec">Recomendada</span>}
              {o.description && <span className="dim">{o.description}</span>}
            </span>
          </motion.button>
        ))}
      </div>
      <div className="guide-free">
        <input
          type="text"
          value={free}
          placeholder="Otra respuesta…"
          onChange={(e) => setFree(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(free)}
          disabled={sent}
        />
        <button className="btn" onClick={() => send(free)} disabled={sent || !free.trim()}>
          Enviar
        </button>
      </div>
      <div className="dialog-actions">
        <span className="dim guide-keys">teclas 1–{q.options.length} eligen</span>
        <button
          className="btn ghost"
          disabled={sent}
          onClick={() => {
            setSent(true);
            Promise.resolve(onFinish()).then((ok) => !ok && setSent(false));
          }}
        >
          Ya está, cerrá
        </button>
      </div>
    </div>
  );
}

function Done({ scene, session, act, onDone }) {
  const r = session.result;
  const max = scene.meta.maxVariants || 3;
  const [count, setCount] = useState(Math.min(max, r.count || 1));
  const [more, setMore] = useState(false);
  const [moreText, setMoreText] = useState('');
  const [busy, setBusy] = useState(false);
  const willGenerate = !!(session.target && r.instruction);
  const hasDir = r.direction && Object.keys(r.direction).length > 0;
  const where = session.target ? `escena ${session.target.scene}` : 'proyecto';
  const apply = async () => {
    setBusy(true);
    const res = await act('apply', { count });
    setBusy(false);
    if (res) onDone(res);
  };
  return (
    <div className="guide-body">
      <h3 className="guide-q">Listo para aplicar</h3>
      <p className="guide-summary">{r.summary}</p>
      {hasDir && (
        <div className="guide-block">
          <div className="guide-label">Dirección que se guarda ({where})</div>
          <dl className="guide-dir">
            {Object.entries(r.direction).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      )}
      {r.instruction && (
        <div className="guide-block">
          <div className="guide-label">{willGenerate ? `Pedido al generador · ${r.kind === 'retouch' ? 'retoque' : 'variantes'}` : 'Pedido (sin target: no se genera)'}</div>
          <div className="guide-instruction">{r.instruction}</div>
        </div>
      )}
      {!hasDir && !willGenerate && <div className="warnbox">No hay nada para guardar: seguí preguntando o descartá.</div>}
      <AnimatePresence>
        {more && (
          <motion.div className="card-form" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <textarea autoFocus rows={2} value={moreText} placeholder="¿Qué falta definir? (opcional)" onChange={(e) => setMoreText(e.target.value)} className="guide-more" />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="dialog-actions">
        <button className="btn ghost" disabled={busy} onClick={async () => (await act('cancel')) && onDone()}>
          Descartar
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => (more ? act('answer', { answer: moreText }) : setMore(true))}>
          {more ? 'Enviar y seguir' : 'Seguir preguntando'}
        </button>
        {willGenerate && (
          <select value={count} onChange={(e) => setCount(+e.target.value)} disabled={busy}>
            {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n} {r.kind === 'retouch' ? (n > 1 ? 'versiones' : 'versión') : n > 1 ? 'variantes' : 'variante'}
              </option>
            ))}
          </select>
        )}
        <button className="btn primary" disabled={busy || (!hasDir && !willGenerate)} onClick={apply}>
          {willGenerate ? 'Aplicar y generar' : 'Guardar dirección'}
        </button>
      </div>
    </div>
  );
}

// Dirección del proyecto: se edita a mano (se guarda en scene.json como cualquier edición) o se revisa guiado.
function Intro({ studio, scene, onStart }) {
  const dir = scene.meta.direction || {};
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const [instr, setInstr] = useState('');
  const setKey = (k, v) =>
    studio.edit((s) => {
      s.meta.direction = { ...(s.meta.direction || {}) };
      if (v == null) delete s.meta.direction[k];
      else s.meta.direction[k] = v;
    });
  const add = () => {
    const k = newKey.trim();
    if (!k) return;
    setKey(k, newVal);
    setNewKey('');
    setNewVal('');
  };
  return (
    <div className="guide-body">
      <div className="guide-label">Dirección actual</div>
      {!Object.keys(dir).length && <p className="dim">Todavía no hay dirección guardada. Armala a mano o con el guiado.</p>}
      <div className="dir-edit">
        {Object.entries(dir).map(([k, v]) => (
          <div key={k} className="dir-row">
            <span className="dir-key">{k}</span>
            <input type="text" value={v} onChange={(e) => setKey(k, e.target.value)} />
            <button className="btn tiny ghost" title="Quitar" onClick={() => setKey(k, null)}>
              ✕
            </button>
          </div>
        ))}
        <div className="dir-row add">
          <input type="text" className="dir-key" placeholder="clave (tono, cámara…)" value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <input type="text" placeholder="valor" value={newVal} onChange={(e) => setNewVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <button className="btn tiny" onClick={add} disabled={!newKey.trim()}>
            ＋
          </button>
        </div>
      </div>
      <textarea className="guide-more" rows={2} value={instr} placeholder="¿Qué querés revisar? (opcional) Ej: “que todo sea más épico y lento”" onChange={(e) => setInstr(e.target.value)} />
      <div className="dialog-actions">
        <button className="btn primary" onClick={() => onStart(instr.trim())}>
          Revisar guiado
        </button>
      </div>
    </div>
  );
}
