// Modo guiado (grill) desde el panel: una pregunta por turno, resuelta con `claude -p` headless.
// Cada sesión vive en .comic/guides/<id>.json; su material de trabajo en .comic/guides/<id>/
// (guide.json con el estado para el modelo, t<N>/turn.json con la salida de cada turno, t<N>.log).
// Los turnos no pasan por la cola de variantes: son interactivos. Uno a la vez por sesión.
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './project.js';
import { runClaude } from './claude.js';
import { targetContext, writeCatalog } from './generator.js';
import { findTarget, activeVariant } from './shared/scene.js';

const OPEN = ['thinking', 'question', 'done', 'error'];

export function createGuides(project, { queue, onChange }) {
  const dir = path.join(project.internal, 'guides');
  fs.mkdirSync(dir, { recursive: true });
  const sessions = new Map();
  const children = new Map(); // id → child del turno en curso
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (g.status === 'thinking') {
        g.status = 'error';
        g.error = 'El server se reinició a mitad del turno. Reintentá.';
      }
      sessions.set(g.id, g);
    } catch {}
  }

  // seq sube en cada guardado: el panel descarta estados viejos que lleguen tarde (respuesta HTTP vs SSE)
  const save = (g) => {
    g.seq = (g.seq || 0) + 1;
    fs.writeFileSync(path.join(dir, g.id + '.json'), JSON.stringify(g, null, 2));
    onChange?.(g);
    return g;
  };
  const get = (id) => sessions.get(id) || null;
  const list = () => [...sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const must = (id, ...allowed) => {
    const g = sessions.get(id);
    if (!g) throw httpError(404, 'sesión guiada no encontrada: ' + id);
    if (allowed.length && !allowed.includes(g.status)) throw httpError(409, `la sesión está en "${g.status}"`);
    return g;
  };

  function normTarget(scene, target) {
    if (!target || !target.scene) return null;
    const t = { scene: target.scene };
    if (target.clip) {
      t.clip = target.clip;
      t.sceneVariant = target.sceneVariant || activeVariant(scene.scenes.find((s) => s.id === target.scene))?.id;
    }
    if (!findTarget(scene, t).holder) throw httpError(400, 'target no encontrado: ' + JSON.stringify(target));
    return t;
  }

  function create({ target = null, instruction = '' } = {}) {
    const { scene } = project.read();
    const g = {
      id: 'g' + Date.now().toString(36),
      target: normTarget(scene, target),
      instruction: String(instruction || '').trim(),
      transcript: [],
      status: 'thinking',
      turn: 0,
      createdAt: new Date().toISOString(),
    };
    sessions.set(g.id, g);
    runTurn(g, { finish: false });
    return g;
  }

  function answer(id, text) {
    const g = must(id, 'question', 'done');
    const a = String(text ?? '').trim();
    if (g.status === 'question') {
      if (!a) throw httpError(400, 'falta la respuesta');
      g.transcript.push({ question: g.question.question, answer: a });
    } else {
      // "Seguir preguntando" desde el resumen
      g.transcript.push({ question: `Propuesta de cierre: ${g.result.summary}`, answer: a || 'Todavía no cierres: seguí preguntando lo que falte definir.' });
    }
    runTurn(g, { finish: false });
    return g;
  }

  function finish(id) {
    const g = must(id, 'question', 'error');
    runTurn(g, { finish: true });
    return g;
  }

  function retry(id) {
    const g = must(id, 'error');
    runTurn(g, { finish: !!g.finish });
    return g;
  }

  function cancel(id) {
    const g = must(id);
    children.get(id)?.kill('SIGTERM');
    children.delete(id);
    g.status = 'cancelled';
    delete g.question;
    return save(g);
  }

  // Aplica el cierre: guarda la dirección y, si hay instrucción y target, encola el pedido.
  function apply(id, { count, kind } = {}) {
    const g = must(id, 'done');
    const res = g.result;
    const { scene, rev } = project.read();
    let newRev = null;
    const dir0 = res.direction && Object.keys(res.direction).length ? res.direction : null;
    if (dir0) {
      if (!g.target) scene.meta.direction = { ...(scene.meta.direction || {}), ...dir0 };
      else {
        const s = scene.scenes.find((x) => x.id === g.target.scene);
        if (!s) throw httpError(409, 'la escena ya no existe');
        s.direction = { ...(s.direction || {}), ...dir0 };
      }
      newRev = project.write(scene, rev);
      project.history([{ ts: new Date().toISOString(), action: 'direction', target: g.target, direction: dir0, guide: g.id }]);
    }
    let request = null;
    if (g.target && res.instruction) {
      if (!queue) throw httpError(400, 'cola deshabilitada');
      const max = scene.meta.maxVariants || 3;
      request = queue.add({
        target: g.target,
        kind: kind === 'retouch' || kind === 'variants' ? kind : res.kind,
        count: Math.max(1, Math.min(max, +count || res.count)),
        instruction: res.instruction,
      });
    }
    g.status = 'applied';
    g.applied = { at: new Date().toISOString(), direction: dir0, request: request?.id || null };
    save(g);
    return { session: g, request, rev: newRev };
  }

  function buildContext(scene, target) {
    const base = { meta: scene.meta, assets: scene.assets };
    if (!target) {
      return {
        ...base,
        scenes: scene.scenes.map((s) => {
          const v = activeVariant(s);
          return {
            id: s.id,
            title: s.title,
            direction: s.direction,
            active: v?.id,
            duration: v?.duration,
            approved: s.variants.some((x) => x.status === 'approved'),
            note: v?.note,
            rejection: v?.rejection,
            clips: (v?.clips || []).map((c) => {
              const cv = activeVariant(c);
              return { id: c.id, track: c.track, label: c.label, preset: cv?.preset, status: cv?.status, note: cv?.note };
            }),
          };
        }),
      };
    }
    const { sceneHolder } = findTarget(scene, target);
    return { ...targetContext(scene, target), direction: sceneHolder?.direction || {}, ...base };
  }

  async function runTurn(g, { finish }) {
    g.turn += 1;
    g.status = 'thinking';
    g.finish = !!finish;
    g.turnStartedAt = new Date().toISOString();
    delete g.question;
    delete g.result;
    delete g.error;
    delete g.log;
    save(g);
    const gdir = path.join(dir, g.id);
    const outDir = path.join(gdir, 't' + g.turn);
    const logFile = path.join(gdir, `t${g.turn}.log`);
    const turnNo = g.turn;
    const t0 = Date.now();
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      const { scene } = project.read();
      if (g.target && !findTarget(scene, g.target).holder) throw new Error('el target ya no existe en scene.json');
      const guideFile = path.join(gdir, 'guide.json');
      fs.writeFileSync(guideFile, JSON.stringify({ target: g.target, instruction: g.instruction, transcript: g.transcript, finish: g.finish, context: buildContext(scene, g.target) }, null, 2));
      const catalogFile = writeCatalog(project);
      const turnFile = path.join(outDir, 'turn.json');
      const prompt = [
        `Sos el entrevistador del modo guiado de la skill comic-motion (turno ${g.turn}, headless desde el panel).`,
        `1. Leé ${path.join(SKILL_DIR, 'references', 'guiado.md')} y seguí sus reglas y la sección "Modo panel" al pie de la letra.`,
        `2. La sesión está en ${guideFile} (target, instruction, transcript, finish, context). El catálogo de presets en ${catalogFile}. La escena entera en ${project.scenePath} (solo lectura). Mirá las imágenes que necesites para recomendar (el archivo del asset o su contactSheet si es video).`,
        `3. Escribí exactamente un archivo: ${turnFile}, con "type": "question" (una sola pregunta, 2 a 4 opciones, la recomendada primera) o "type": "done".`,
        g.finish ? `El usuario pidió cerrar ya ("finish": true): turn.json tiene que ser "done"; completá lo que falte con tus recomendaciones y decí en el summary cuáles asumiste.` : '',
        `No modifiques ningún otro archivo. Terminá con una línea de resumen.`,
      ]
        .filter(Boolean)
        .join('\n');
      const { scene: s2 } = project.read();
      const model = s2.meta.guideModel || s2.meta.generatorModel || 'sonnet';
      const { child, done } = runClaude({ cwd: project.dir, prompt, model, outDir, logFile, timeoutMs: 8 * 60 * 1000 });
      children.set(g.id, child);
      const code = await done;
      children.delete(g.id);
      if (g.status !== 'thinking' || g.turn !== turnNo) return; // cancelada
      const rel = path.relative(project.dir, logFile);
      if (!fs.existsSync(turnFile)) throw Object.assign(new Error(`claude terminó (código ${code}) sin escribir turn.json`), { log: rel });
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(turnFile, 'utf8'));
      } catch (e) {
        throw Object.assign(new Error('turn.json no es JSON válido: ' + e.message), { log: rel });
      }
      const turn = normalizeTurn(raw, { maxVariants: s2.meta.maxVariants || 3, finish: g.finish });
      g.turnSeconds = Math.round((Date.now() - t0) / 100) / 10;
      if (turn.type === 'question') {
        g.status = 'question';
        g.question = turn;
      } else {
        g.status = 'done';
        g.result = turn;
      }
      save(g);
    } catch (e) {
      children.delete(g.id);
      if (g.status !== 'thinking' || g.turn !== turnNo) return;
      g.status = 'error';
      g.error = String(e.message || e).slice(0, 2000);
      g.log = e.log || path.relative(project.dir, logFile);
      g.turnSeconds = Math.round((Date.now() - t0) / 100) / 10;
      save(g);
    }
  }

  return { create, answer, finish, retry, cancel, apply, get, list, open: () => list().filter((g) => OPEN.includes(g.status)) };
}

// Valida y normaliza la salida del modelo. Tira error con un mensaje útil si no sirve.
export function normalizeTurn(raw, { maxVariants = 3, finish = false } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('turn.json vacío');
  if (raw.type === 'question') {
    if (finish) throw new Error('se pidió cerrar (finish) y el modelo devolvió otra pregunta');
    const question = String(raw.question || '').trim();
    if (!question) throw new Error('question sin texto');
    let options = (Array.isArray(raw.options) ? raw.options : [])
      .map((o) => (typeof o === 'string' ? { label: o } : o))
      .filter((o) => o && String(o.label || '').trim())
      .map((o) => ({ label: String(o.label).trim(), description: o.description ? String(o.description).trim() : undefined, recommended: !!o.recommended }));
    if (options.length < 2) throw new Error('la pregunta necesita de 2 a 4 opciones con label');
    options = options.slice(0, 4);
    const rec = options.findIndex((o) => o.recommended);
    options.forEach((o) => (o.recommended = false));
    if (rec > 0) options.unshift(options.splice(rec, 1)[0]);
    options[0].recommended = true;
    for (const o of options) if (!o.description) delete o.description;
    return { type: 'question', question, why: raw.why ? String(raw.why).trim() : undefined, options };
  }
  if (raw.type === 'done') {
    const summary = String(raw.summary || '').trim();
    if (!summary) throw new Error('done sin summary');
    let direction;
    if (raw.direction && typeof raw.direction === 'object' && !Array.isArray(raw.direction)) {
      direction = {};
      for (const [k, v] of Object.entries(raw.direction)) {
        if (v == null || v === '') continue;
        direction[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
    }
    const kind = raw.kind === 'retouch' ? 'retouch' : 'variants';
    const n = Math.round(+raw.count);
    const count = Math.max(1, Math.min(maxVariants, Number.isFinite(n) && n > 0 ? n : kind === 'retouch' ? 1 : maxVariants));
    const instruction = raw.instruction ? String(raw.instruction).trim() : '';
    return { type: 'done', summary, direction: direction && Object.keys(direction).length ? direction : undefined, instruction: instruction || undefined, kind, count };
  }
  throw new Error(`turn.json con type desconocido: ${JSON.stringify(raw.type)} (question | done)`);
}

function httpError(code, msg) {
  return Object.assign(new Error(msg), { httpStatus: code });
}
