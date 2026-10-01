import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';

export const Backdrop = ({ onClose, children, side }) => (
  <motion.div className={'backdrop ' + (side ? 'side' : '')} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
    {children}
  </motion.div>
);

export function ExportDialog({ studio, render, onClose, loop, scene, validation, playerWarnings = [], goTo }) {
  const [quality, setQuality] = useState('1080');
  const [codec, setCodec] = useState('h264');
  const [range, setRange] = useState('all');
  const [workers, setWorkers] = useState('auto');
  // export HTML (web): mismas escenas activas, player en vivo; opciones propias
  const [html, setHtml] = useState({ single: false, quality: '4k', controls: true, autoplay: false, loop: false });
  const [htmlRes, setHtmlRes] = useState(null); // { status: 'running' | 'done' | 'error', … }
  const isHtml = codec === 'html';
  const htmlRunning = htmlRes?.status === 'running';
  const running = render.status === 'running';
  const pending = scene.scenes.filter((s) => !s.variants.some((v) => v.status === 'approved'));
  const pct = running ? Math.round(((render.frame || 0) / (render.frames || 1)) * 100) : 0;
  // cuántos navegadores usaría Auto en esta máquina (núcleos, RAM libre, calidad y largo del tramo)
  const [plan, setPlan] = useState(null);
  const useLoop = range === 'loop' && loop;
  useEffect(() => {
    const q = new URLSearchParams({ quality, ...(useLoop ? { from: loop[0], to: loop[1] } : {}) });
    let alive = true;
    fetch('/api/render/plan?' + q)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setPlan(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [quality, useLoop, loop?.[0], loop?.[1]]);
  const autoTip = plan ? `Auto: ${plan.n} en esta máquina (límite por ${plan.limit}; ${plan.availGB} GB disponibles, ~${plan.perWorkerGB} GB por navegador a ${quality === '4k' ? '4K' : '1080p'})` : 'según núcleos y memoria libre (hasta 4)';
  const camWarnings = playerWarnings;
  return (
    <Backdrop onClose={onClose}>
      <motion.div className="dialog" initial={{ y: 30, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 30, scale: 0.97 }}>
        <h3>{isHtml ? 'Exportar para la web' : 'Exportar video'}</h3>
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
        {camWarnings.length > 0 && (
          <div className="warnbox">
            {camWarnings.length} aviso(s) de cámara/límites (el export sale igual, con estos ajustes):
            <ul className="warn-list">
              {camWarnings.slice(0, 8).map((w) => {
                const m = /^([^/]+)\/([^:]+): (.*)$/.exec(w);
                return (
                  <li key={w}>
                    {m && goTo ? (
                      <button className="linkish" onClick={() => goTo({ scene: m[1], clip: m[2] })} title="Ir al clip">
                        {m[1]}/{m[2]}
                      </button>
                    ) : null}
                    {m ? ': ' + m[3] : w}
                  </li>
                );
              })}
              {camWarnings.length > 8 && <li className="dim">y {camWarnings.length - 8} más (contador ⚠ de la barra)</li>}
            </ul>
          </div>
        )}
        <div className="opts">
          {!isHtml && (
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
          )}
          <label>
            <span>Formato</span>
            <div className="seg">
              <button className={codec === 'h264' ? 'on' : ''} onClick={() => setCodec('h264')} disabled={running}>
                MP4 H.264
              </button>
              <button className={codec === 'prores' ? 'on' : ''} onClick={() => setCodec('prores')} disabled={running}>
                ProRes (.mov)
              </button>
              <button className={isHtml ? 'on' : ''} onClick={() => setCodec('html')} disabled={running || htmlRunning} title="El mismo player reproduciéndose en vivo en el navegador: para publicar en la web">
                HTML (web)
              </button>
            </div>
          </label>
          {isHtml && (
            <>
              <label>
                <span>Salida</span>
                <div className="seg">
                  <button className={!html.single ? 'on' : ''} onClick={() => setHtml({ ...html, single: false })} disabled={htmlRunning} title="index.html + player.js + assets/: para subir a un hosting estático (GitHub Pages, Netlify)">
                    Carpeta
                  </button>
                  <button className={html.single ? 'on' : ''} onClick={() => setHtml({ ...html, single: true })} disabled={htmlRunning} title="Todo embebido en un .html (hasta 50 MB): se abre con doble clic">
                    Un solo .html
                  </button>
                </div>
              </label>
              <label>
                <span>Nitidez GPU</span>
                <div className="seg">
                  {['1080', '4k'].map((q) => (
                    <button
                      key={q}
                      className={html.quality === q ? 'on' : ''}
                      onClick={() => setHtml({ ...html, quality: q })}
                      disabled={htmlRunning}
                      title={q === '1080' ? 'Tope de los canvas GPU (VFX, capas) a 1080p: más liviano en notebooks y celulares' : 'Tope a 4K: nítido en pantallas retina grandes'}
                    >
                      {q === '1080' ? 'hasta 1080p' : 'hasta 4K'}
                    </button>
                  ))}
                </div>
              </label>
              <label>
                <span>Player</span>
                <div className="seg">
                  {[
                    ['controls', 'Controles'],
                    ['autoplay', 'Autoplay'],
                    ['loop', 'Loop'],
                  ].map(([k, l]) => (
                    <button key={k} className={html[k] ? 'on' : ''} onClick={() => setHtml({ ...html, [k]: !html[k] })} disabled={htmlRunning}>
                      {l}
                    </button>
                  ))}
                </div>
              </label>
            </>
          )}
          <label>
            <span>Cuadros/s</span>
            <span className="dim">{scene.meta.fps || 24} fps · se configura arriba, en la barra del proyecto</span>
          </label>
          {!isHtml && (
            <label>
              <span>En paralelo</span>
              <div className="seg">
                {['auto', 1, 2, 3, 4].map((w) => (
                  <button key={w} className={workers === w ? 'on' : ''} onClick={() => setWorkers(w)} disabled={running} title={w === 'auto' ? autoTip : `${w} navegador(es) renderizando tramos a la vez`}>
                    {w === 'auto' ? (plan ? `Auto (${plan.n})` : 'Auto') : w}
                  </button>
                ))}
              </div>
            </label>
          )}
          {!isHtml && (
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
          )}
        </div>
        {isHtml && htmlRes?.status === 'running' && <div className="warnbox">Exportando HTML…</div>}
        {isHtml && htmlRes?.status === 'done' && (
          <div className="warnbox ok">
            Listo:{' '}
            <a href={htmlRes.url} target="_blank" rel="noreferrer">
              {htmlRes.out}
              {htmlRes.single ? '' : '/'}
            </a>{' '}
            ({(htmlRes.bytes / 1048576).toFixed(1)} MB{htmlRes.single ? ', un archivo' : `, ${htmlRes.files} archivos de la escena`}){' '}
            <button className="btn tiny" onClick={() => window.open(htmlRes.url, '_blank')}>
              Abrir
            </button>
            <div className="dim">
              {htmlRes.single ? 'Se abre con doble clic (file://) o se sube tal cual.' : 'Subí la carpeta a un hosting estático (GitHub Pages, Netlify). Desde el disco (file://) la GPU no puede leer los archivos: para doble clic, "Un solo .html".'}
            </div>
            {htmlRes.warnings?.length ? <div className="dim">{htmlRes.warnings.join(' · ')}</div> : null}
          </div>
        )}
        {isHtml && htmlRes?.status === 'error' && <div className="warnbox bad">Falló: {htmlRes.error}</div>}
        {running && !isHtml && (
          <div className="progress">
            <div className="bar" style={{ width: pct + '%' }} />
            <span>
              cuadro {render.frame}/{render.frames}
              {render.frames && typeof render.workers === 'number' && render.workers > 1 ? ` · ${render.workers} en paralelo` : ''} · faltan ~{Math.round(render.eta || 0)}s
            </span>
          </div>
        )}
        {render.status === 'done' && !isHtml && (
          <div className="warnbox ok">
            Listo: <a href={render.url} target="_blank" rel="noreferrer">{render.outFile?.split('/').pop()}</a> ({render.frames} cuadros en {render.seconds?.toFixed(0)}s{render.workers > 1 ? `, ${render.workers} en paralelo` : ''})
            {render.warnings?.length ? <div className="dim">{render.warnings.join(' · ')}</div> : null}
          </div>
        )}
        {render.status === 'error' && !isHtml && <div className="warnbox bad">Falló: {render.error}</div>}
        {render.status === 'cancelled' && !isHtml && <div className="warnbox">Export cancelado: no quedó ningún archivo a medias.</div>}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            Cerrar
          </button>
          {isHtml ? (
            <button
              className="btn primary"
              disabled={htmlRunning}
              onClick={async () => {
                setHtmlRes({ status: 'running' });
                setHtmlRes(await studio.exportHtml(html));
              }}
            >
              Exportar HTML
            </button>
          ) : running ? (
            <button className="btn bad" onClick={studio.cancelRender}>
              Cancelar export
            </button>
          ) : (
            <button className="btn primary" onClick={() => studio.startRender({ quality, codec, workers, ...(range === 'loop' && loop ? { from: loop[0], to: loop[1] } : {}) })}>
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
