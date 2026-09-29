import React, { useState } from 'react';
import { motion } from 'motion/react';

export const Backdrop = ({ onClose, children, side }) => (
  <motion.div className={'backdrop ' + (side ? 'side' : '')} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
    {children}
  </motion.div>
);

export function ExportDialog({ studio, render, onClose, loop, scene, validation }) {
  const [quality, setQuality] = useState('1080');
  const [codec, setCodec] = useState('h264');
  const [range, setRange] = useState('all');
  const running = render.status === 'running';
  const pending = scene.scenes.filter((s) => !s.variants.some((v) => v.status === 'approved'));
  const pct = running ? Math.round(((render.frame || 0) / (render.frames || 1)) * 100) : 0;
  return (
    <Backdrop onClose={onClose}>
      <motion.div className="dialog" initial={{ y: 30, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 30, scale: 0.97 }}>
        <h3>Exportar video</h3>
        {validation.errors.length > 0 && (
          <div className="warnbox bad">
            La escena tiene errores; el export va a fallar:
            <ul>
              {validation.errors.slice(0, 6).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {pending.length > 0 && (
          <div className="warnbox">
            {pending.length} escena(s) sin aprobar: {pending.map((s) => s.title || s.id).join(', ')}. Se exporta lo que está en pantalla.
          </div>
        )}
        <div className="opts">
          <label>
            <span>Resolución</span>
            <div className="seg">
              {['1080', '4k'].map((q) => (
                <button key={q} className={quality === q ? 'on' : ''} onClick={() => setQuality(q)} disabled={running}>
                  {q === '1080' ? '1080p' : '4K'}
                </button>
              ))}
            </div>
          </label>
          <label>
            <span>Formato</span>
            <div className="seg">
              <button className={codec === 'h264' ? 'on' : ''} onClick={() => setCodec('h264')} disabled={running}>
                MP4 H.264
              </button>
              <button className={codec === 'prores' ? 'on' : ''} onClick={() => setCodec('prores')} disabled={running}>
                ProRes (.mov)
              </button>
            </div>
          </label>
          <label>
            <span>Cuadros/s</span>
            <span className="dim">{scene.meta.fps || 24} fps · se configura arriba, en la barra del proyecto</span>
          </label>
          <label>
            <span>Tramo</span>
            <div className="seg">
              <button className={range === 'all' ? 'on' : ''} onClick={() => setRange('all')} disabled={running}>
                Todo
              </button>
              <button className={range === 'loop' ? 'on' : ''} onClick={() => setRange('loop')} disabled={running || !loop}>
                Loop {loop ? `${loop[0].toFixed(2)}–${loop[1].toFixed(2)}s` : '(marcá con shift+arrastrar)'}
              </button>
            </div>
          </label>
        </div>
        {running && (
          <div className="progress">
            <div className="bar" style={{ width: pct + '%' }} />
            <span>
              cuadro {render.frame}/{render.frames} · faltan ~{Math.round(render.eta || 0)}s
            </span>
          </div>
        )}
        {render.status === 'done' && (
          <div className="warnbox ok">
            Listo: <a href={render.url} target="_blank" rel="noreferrer">{render.outFile?.split('/').pop()}</a> ({render.frames} cuadros en {render.seconds?.toFixed(0)}s)
            {render.warnings?.length ? <div className="dim">{render.warnings.join(' · ')}</div> : null}
          </div>
        )}
        {render.status === 'error' && <div className="warnbox bad">Falló: {render.error}</div>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
          {running ? (
            <button className="btn bad" onClick={studio.cancelRender}>
              Cancelar export
            </button>
          ) : (
            <button className="btn primary" onClick={() => studio.startRender({ quality, codec, ...(range === 'loop' && loop ? { from: loop[0], to: loop[1] } : {}) })}>
              Exportar
            </button>
          )}
        </div>
      </motion.div>
    </Backdrop>
  );
}

export function QueueDrawer({ requests, onClose, cancel, setSelection }) {
  const list = [...requests].reverse();
  return (
    <Backdrop onClose={onClose} side>
      <motion.div className="drawer" initial={{ x: 380 }} animate={{ x: 0 }} exit={{ x: 380 }} transition={{ type: 'spring', stiffness: 380, damping: 36 }}>
        <h3>Cola de variantes</h3>
        {!list.length && <p className="dim">Nada pedido todavía.</p>}
        {list.map((r) => (
          <div key={r.id} className={'req-row ' + r.status}>
            <div>
              <b>{r.target.clip ? `${r.target.scene} / ${r.target.clip}` : r.target.scene}</b> <span className="chip">{r.status}</span>
            </div>
            <div className="dim">
              {r.kind === 'retouch' ? `retoque de ${r.from}` : `${r.count} variante(s) desde ${r.from}`} · {new Date(r.createdAt).toLocaleTimeString()}
            </div>
            {r.instruction && <div>“{r.instruction}”</div>}
            {r.results?.length > 0 && <div className="ok">→ {r.results.join(', ')}</div>}
            {r.error && <div className="bad">{r.error}</div>}
            {r.warnings?.map((w) => (
              <div key={w} className="dim">
                ⚠ {w}
              </div>
            ))}
            <div className="card-actions">
              <button
                className="btn tiny"
                onClick={() => {
                  setSelection({ scene: r.target.scene, clip: r.target.clip, sceneVariant: r.target.sceneVariant });
                  onClose();
                }}
              >
                Ir
              </button>
              {(r.status === 'queued' || r.status === 'running') && (
                <button className="btn tiny ghost" onClick={() => cancel(r.id)}>
                  Cancelar
                </button>
              )}
            </div>
          </div>
        ))}
      </motion.div>
    </Backdrop>
  );
}

// Confirmación propia del panel (en vez de window.confirm). Enter confirma, Esc cancela (lo maneja App).
export function ConfirmDialog({ title, message, okLabel = 'Aceptar', cancelLabel = 'Cancelar', onAnswer }) {
  return (
    <Backdrop onClose={() => onAnswer(false)}>
      <motion.div className="dialog confirm" role="alertdialog" aria-modal="true" initial={{ y: 30, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 30, scale: 0.97 }}>
        <h3>{title}</h3>
        <p className="confirm-msg">{message}</p>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => onAnswer(false)}>
            {cancelLabel}
          </button>
          <button className="btn primary" autoFocus onClick={() => onAnswer(true)}>
            {okLabel}
          </button>
        </div>
      </motion.div>
    </Backdrop>
  );
}
