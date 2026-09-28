// Estado del estudio sincronizado con el server: scene.json + rev, cola, export, presets.
import { useCallback, useEffect, useRef, useState } from 'react';

const clientId = Math.random().toString(36).slice(2);

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function useStudio() {
  const [scene, setSceneState] = useState(null);
  const [presets, setPresets] = useState({ builtin: [], custom: [] });
  const [requests, setRequests] = useState([]);
  const [render, setRender] = useState({ status: 'idle' });
  const [validation, setValidation] = useState({ errors: [], warnings: [] });
  const [toast, setToast] = useState(null);
  const [saveState, setSaveState] = useState('saved'); // saved | dirty | saving | error
  const rev = useRef(null);
  const sceneRef = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const saving = useRef(null);

  const notify = useCallback((msg, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToast({ msg, kind, id });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), kind === 'info' ? 3500 : 7000);
  }, []);

  const apply = useCallback((s, r) => {
    sceneRef.current = s;
    if (r) rev.current = r;
    setSceneState(s);
  }, []);

  const refreshValidation = useCallback(() => {
    api('GET', '/api/validate').then((r) => r.ok && setValidation(r.data));
  }, []);

  const load = useCallback(async () => {
    const r = await api('GET', '/api/scene');
    if (r.ok) apply(r.data.scene, r.data.rev);
    refreshValidation();
  }, [apply, refreshValidation]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (saving.current) await saving.current;
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    saving.current = (async () => {
      const r = await api('PUT', '/api/scene', { scene: sceneRef.current, baseRev: rev.current, clientId });
      if (r.ok) {
        rev.current = r.data.rev;
        setSaveState(dirty.current ? 'dirty' : 'saved');
        refreshValidation();
      } else if (r.status === 409) {
        apply(r.data.scene, r.data.rev);
        setSaveState('saved');
        notify('scene.json cambió afuera (Claude o el generador): recargué la versión nueva y descarté tu último cambio.', 'warn');
      } else {
        setSaveState('error');
        notify('No pude guardar: ' + (r.data.error || r.status), 'error');
      }
    })();
    await saving.current;
    saving.current = null;
  }, [apply, notify, refreshValidation]);

  // edición local optimista + guardado con debounce
  const edit = useCallback(
    (mutator) => {
      const next = structuredClone(sceneRef.current);
      mutator(next);
      sceneRef.current = next;
      setSceneState(next);
      dirty.current = true;
      setSaveState('dirty');
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 450);
    },
    [flush],
  );

  const review = useCallback(
    async (target, action, note) => {
      await flush();
      const r = await api('POST', '/api/review', { target, action, note, baseRev: rev.current, clientId });
      if (r.ok) {
        apply(r.data.scene, r.data.rev);
        refreshValidation();
      } else if (r.status === 409) {
        apply(r.data.scene, r.data.rev);
        notify('La escena había cambiado; recargada. Repetí la acción.', 'warn');
      } else notify(r.data.error || 'error', 'error');
    },
    [apply, flush, notify, refreshValidation],
  );

  const requestVariants = useCallback(
    async (body) => {
      await flush();
      const r = await api('POST', '/api/requests', body);
      if (!r.ok) notify(r.data.error || 'no se pudo encolar', 'error');
      else notify(`Pedido encolado: ${r.data.count} variante(s)`);
    },
    [flush, notify],
  );

  const cancelRequest = useCallback((id) => api('POST', `/api/requests/${id}/cancel`), []);

  const startRender = useCallback(
    async (opts) => {
      await flush();
      const r = await api('POST', '/api/render', opts);
      if (!r.ok) notify(r.data.error || 'no se pudo exportar', 'error');
      else setRender(r.data);
    },
    [flush, notify],
  );
  const cancelRender = useCallback(() => api('POST', '/api/render/cancel'), []);

  useEffect(() => {
    load();
    api('GET', '/api/presets').then((r) => r.ok && setPresets(r.data));
    api('GET', '/api/requests').then((r) => r.ok && setRequests(r.data));
    api('GET', '/api/render').then((r) => r.ok && setRender(r.data));
    const es = new EventSource('/api/events');
    es.addEventListener('scene', (e) => {
      const d = JSON.parse(e.data);
      if (d.by === clientId || d.rev === rev.current) return;
      if (dirty.current) return; // nuestro próximo guardado va a chocar (409) y recargar
      load();
    });
    es.addEventListener('queue', (e) => setRequests(JSON.parse(e.data)));
    es.addEventListener('render', (e) => setRender(JSON.parse(e.data)));
    es.addEventListener('presets', (e) => setPresets(JSON.parse(e.data)));
    const beforeUnload = (e) => {
      if (dirty.current) {
        flush();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      es.close();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [load, flush]);

  return { scene, presets, requests, render, validation, toast, saveState, edit, review, requestVariants, cancelRequest, startRender, cancelRender, notify, flush };
}
