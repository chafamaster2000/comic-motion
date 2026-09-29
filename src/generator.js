// Cola de pedidos de variantes, resuelta con `claude -p` headless.
// Corre hasta meta.generatorConcurrency pedidos a la vez, uno por escena: dentro de una escena van en fila
// porque cada generación tiene que ver lo que salió (y lo que se rechazó) en la anterior.
// Cada pedido vive en .comic/requests/<id>.json; la salida del modelo en .comic/requests/<id>/out/*.json.
import fs from 'node:fs';
import path from 'node:path';
import { runClaude } from './claude.js';
import { SKILL_DIR, catalog, validate, mergeGenerated } from './project.js';
import { findTarget, activeVariant, reviewContext } from './shared/scene.js';

export function createQueue(project, { onChange }) {
  const dir = path.join(project.internal, 'requests');
  fs.mkdirSync(dir, { recursive: true });
  const reqs = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (r.status === 'running') r.status = 'queued'; // se cortó el server a mitad
    reqs.set(r.id, r);
  }
  const running = new Map(); // id → { child, sceneId }
  const save = (r) => {
    fs.writeFileSync(path.join(dir, r.id + '.json'), JSON.stringify(r, null, 2));
    onChange?.(list());
  };
  const list = () => [...reqs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  function add({ target, kind = 'variants', count, instruction = '', from }) {
    const { scene } = project.read();
    const { holder, level } = findTarget(scene, target);
    if (!holder) throw new Error('target no encontrado');
    const max = scene.meta.maxVariants || 3;
    const n = Math.max(1, Math.min(max, count || (kind === 'retouch' ? 1 : max)));
    const id = 'r' + Date.now().toString(36);
    const r = {
      id,
      kind,
      level,
      target: { scene: target.scene, clip: target.clip, sceneVariant: target.clip ? target.sceneVariant || activeVariant(scene.scenes.find((s) => s.id === target.scene))?.id : undefined },
      from: from || activeVariant(holder)?.id,
      count: n,
      instruction,
      status: 'queued',
      createdAt: new Date().toISOString(),
      results: [],
    };
    reqs.set(id, r);
    save(r);
    pump();
    return r;
  }

  function cancel(id) {
    const r = reqs.get(id);
    if (!r) return;
    if (r.status === 'queued') {
      r.status = 'cancelled';
      save(r);
    } else if (r.status === 'running' && running.has(id)) {
      running.get(id).child?.kill('SIGTERM');
      r.status = 'cancelled';
      save(r);
    }
  }

  function pump() {
    const { scene } = project.read();
    const limit = Math.max(1, Math.min(8, scene.meta.generatorConcurrency || 3));
    const busy = new Set([...running.values()].map((x) => x.sceneId));
    for (const next of list()) {
      if (running.size >= limit) break;
      if (next.status !== 'queued' || busy.has(next.target.scene)) continue;
      busy.add(next.target.scene);
      start(next);
    }
  }

  async function start(next) {
    running.set(next.id, { sceneId: next.target.scene });
    next.status = 'running';
    next.startedAt = new Date().toISOString();
    save(next);
    try {
      await runOne(next);
      if (next.status === 'running') next.status = 'done';
    } catch (e) {
      if (next.status !== 'cancelled') {
        next.status = 'error';
        next.error = String(e.message || e).slice(0, 2000);
      }
    }
    next.finishedAt = new Date().toISOString();
    save(next);
    running.delete(next.id);
    pump();
  }

  async function runOne(r) {
    const outDir = path.join(dir, r.id, 'out');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const { scene } = project.read();
    const { holder, level } = findTarget(scene, r.target);
    if (!holder) throw new Error('target ya no existe');
    writeCatalog(project);
    const fromVariant = holder.variants.find((v) => v.id === r.from) || activeVariant(holder);
    const brief = {
      request: { kind: r.kind, level, count: r.count, instruction: r.instruction },
      target: r.target,
      ...targetContext(scene, r.target, fromVariant),
      meta: scene.meta,
      assets: scene.assets,
    };
    fs.writeFileSync(path.join(dir, r.id, 'brief.json'), JSON.stringify(brief, null, 2));
    const prompt = [
      `Sos el generador de variantes de la skill comic-motion.`,
      `1. Leé ${path.join(SKILL_DIR, 'references', 'generator.md')} y seguí sus reglas al pie de la letra.`,
      `2. El pedido completo está en ${path.join(dir, r.id, 'brief.json')}. El catálogo de presets en ${path.join(project.internal, 'catalog.json')}. La escena entera en ${project.scenePath} (solo lectura).`,
      `3. Escribí exactamente ${r.count} archivo(s) JSON en ${outDir}/ llamados 1.json, 2.json, … (uno por variante, nivel "${level}").`,
      `No modifiques ningún otro archivo. Terminá con una línea de resumen.`,
    ].join('\n');
    const { child, done } = runClaude({ cwd: project.dir, prompt, model: scene.meta.generatorModel || 'sonnet', outDir, logFile: path.join(dir, r.id, 'claude.log') });
    running.get(r.id).child = child;
    const code = await done;
    if (r.status === 'cancelled') return;
    const files = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).sort() : [];
    if (!files.length) throw new Error(`claude terminó (código ${code}) sin escribir variantes. Ver .comic/requests/${r.id}/claude.log`);
    // integrar de a una, validando contra la escena más reciente (pudo cambiar mientras generaba).
    // De acá hasta project.write todo es sincrónico: otra generación que termine a la vez no puede intercalarse.
    const { scene: fresh, rev } = project.read();
    const problems = [];
    const baseErrors = new Set(validate(fresh, project).errors);
    for (const f of files) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
      } catch (e) {
        problems.push(`${f}: JSON inválido`);
        continue;
      }
      const trial = structuredClone(fresh);
      let v;
      try {
        v = mergeGenerated(trial, r.target, raw, { parent: fromVariant?.id, instruction: r.instruction, requestId: r.id });
      } catch (e) {
        problems.push(`${f}: ${e.message}`);
        continue;
      }
      const { errors } = validate(trial, project);
      const mine = errors.filter((e) => !baseErrors.has(e));
      if (mine.length) {
        problems.push(`${f}: ${mine.join('; ')}`);
        continue;
      }
      mergeGenerated(fresh, r.target, raw, { parent: fromVariant?.id, instruction: r.instruction, requestId: r.id });
      r.results.push(v.id);
    }
    if (r.results.length) {
      project.write(fresh, rev);
      project.history([{ ts: new Date().toISOString(), action: 'generate', target: r.target, request: r.id, instruction: r.instruction, variants: r.results }]);
    }
    if (problems.length) r.warnings = problems;
    if (!r.results.length) throw new Error('ninguna variante pasó la validación: ' + problems.join(' | '));
  }

  pump();
  return { add, cancel, list, pump };
}

// Lo que el modelo necesita saber del ítem: variante de partida, memoria de revisión de las hermanas
// y el resto de la escena (con la dirección de la escena). Lo usan el generador y el modo guiado.
export function targetContext(scene, target, fromVariant) {
  const { holder, level, sceneHolder, sceneVariant } = findTarget(scene, target);
  if (!holder) return {};
  const from = fromVariant || activeVariant(holder);
  const direction = sceneHolder.direction || undefined;
  return {
    from,
    siblings: reviewContext(holder),
    sceneContext:
      level === 'clip'
        ? { sceneId: sceneHolder.id, title: sceneHolder.title, direction, duration: sceneVariant.duration, stage: sceneVariant.stage, otherClips: (sceneVariant.clips || []).filter((c) => c.id !== holder.id).map((c) => ({ id: c.id, track: c.track, label: c.label, active: activeVariant(c) })) }
        : { sceneId: sceneHolder.id, title: sceneHolder.title, direction, index: scene.scenes.indexOf(sceneHolder), totalScenes: scene.scenes.length },
  };
}

export function writeCatalog(project) {
  const f = path.join(project.internal, 'catalog.json');
  fs.writeFileSync(f, JSON.stringify(catalog(project), null, 2));
  return f;
}
