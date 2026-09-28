#!/usr/bin/env node
// CLI de comic-motion. Ver SKILL.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openProject, newScene, validate, catalog, SKILL_DIR } from '../src/project.js';
import { EASES } from '../src/player/ease.js';
import { startServer } from '../src/server.js';
import { renderVideo, snapshots } from '../src/render.js';
import { ingest, detectPanels, cutout } from '../src/ingest.js';
import { activeVariant, isStale, layoutScenes, totalDuration } from '../src/shared/scene.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[k] = rest[++i];
    else flags[k] = true;
  } else args.push(a);
}

const die = (msg) => {
  console.error('✗ ' + msg);
  process.exit(1);
};

function ensureBuilt() {
  if (!fs.existsSync(path.join(SKILL_DIR, 'dist', 'panel.js'))) die(`falta el build: cd ${SKILL_DIR} && npm run build`);
}

const HELP = `comic <comando> <proyecto> [opciones]

  init <dir> [--title T] [--width 1920 --height 1080 --fps 24]   crea un proyecto
  ingest <dir> <archivos...>          copia imágenes/videos a assets/ (proxy webm + hoja de contacto)
  panels <dir> <assetId>              detecta viñetas en una página → overlay numerado para revisar
  cutout <dir> <assetId>              recorta el personaje (BiRefNet, JS) → assets/<id>.cutout.png
  check <dir>                         valida scene.json
  status <dir>                        resumen de revisión: aprobado / rechazado / notas / pedidos
  presets                             catálogo de presets y params (markdown)
  snapshot <dir> --t 0.5,2,3.4 [--scale 0.5] [--scene s2]   cuadros PNG para mirar
  studio <dir> [--port 4777] [--open]   levanta el panel
  render <dir> [--quality 1080|4k] [--codec h264|prores] [--from s --to s] [--out f.mp4]`;

async function withServer(dir, fn) {
  ensureBuilt();
  const srv = await startServer({ projectDir: dir, withQueue: false, log: () => {} });
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

async function main() {
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
  if (cmd === 'presets') {
    const { builtin } = catalog(null);
    const kinds = ['transition', 'camera', 'panel', 'filter', 'fx', 'bubble', 'ono'];
    for (const k of kinds) {
      console.log(`\n## ${k}`);
      for (const d of builtin.filter((x) => x.kind === k)) {
        console.log(`- **${d.id}** — ${d.label}`);
        for (const p of d.params) console.log(`    ${p.key}: ${p.type}${p.options ? ' [' + p.options.join('|') + ']' : ''}${p.min != null ? ` ${p.min}..${p.max}` : ''}${p.default !== undefined ? ' = ' + JSON.stringify(p.default) : ''}  — ${p.label}`);
      }
    }
    console.log('\neases: ' + EASES.join(', ') + ', steps:N, [x1,y1,x2,y2], {type:"spring",stiffness,damping}');
    return;
  }
  const dir = args[0];
  if (!dir) die('falta el directorio del proyecto');

  if (cmd === 'init') {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'scene.json');
    if (fs.existsSync(f)) die(`ya existe ${f}`);
    const scene = newScene({ title: flags.title || path.basename(path.resolve(dir)), width: +flags.width || 1920, height: +flags.height || 1080, fps: +flags.fps || 24 });
    fs.writeFileSync(f, JSON.stringify(scene, null, 2) + '\n');
    for (const d of ['assets', 'effects', 'exports']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '.comic/\nexports/\n*.proxy.webm\n');
    return console.log(`✓ proyecto creado en ${path.resolve(dir)}`);
  }

  const project = openProject(dir);

  if (cmd === 'ingest') {
    const files = args.slice(1);
    if (!files.length) die('pasá al menos un archivo');
    const { scene, rev } = project.read();
    const added = await ingest(project, scene, files);
    project.write(scene, rev);
    for (const a of added) {
      console.log(`✓ ${a.id}  ${a.type}  ${a.w}×${a.h}${a.duration ? `  ${a.duration}s` : ''}  → ${a.file}`);
      if (a.contactSheet) console.log(`    hoja de contacto: ${path.join(project.dir, a.contactSheet)}  (tiempos: ${a.contactTimes.join(', ')})`);
    }
    return;
  }

  if (cmd === 'panels') {
    const { scene } = project.read();
    const r = await detectPanels(project, scene, args[1], { minArea: flags.minArea ? +flags.minArea : undefined, threshold: flags.threshold ? +flags.threshold : undefined });
    console.log(`✓ ${r.panels.length} viñetas detectadas en ${r.asset} (${r.size.join('×')})`);
    for (const p of r.panels) console.log(`  ${p.n}: crop [${p.crop.join(', ')}]  relleno ${p.fill}`);
    console.log(`  overlay para revisar: ${path.join(project.dir, r.overlay)}`);
    return;
  }

  if (cmd === 'cutout') {
    const { scene, rev } = project.read();
    console.log('recortando (la primera vez descarga el modelo, ~200MB)…');
    const r = await cutout(project, scene, args[1], { model: flags.model });
    project.write(scene, rev);
    return console.log(`✓ ${path.join(project.dir, r.file)}`);
  }

  if (cmd === 'check') {
    const { errors, warnings } = validate(project.read().scene, project);
    for (const w of warnings) console.log('⚠ ' + w);
    for (const e of errors) console.log('✗ ' + e);
    if (errors.length) process.exit(1);
    return console.log(`✓ scene.json válido (${warnings.length} avisos)`);
  }

  if (cmd === 'status') {
    const { scene } = project.read();
    const layout = layoutScenes(scene);
    console.log(`${scene.meta.title} — ${layout.length} escenas, ${totalDuration(scene).toFixed(2)}s`);
    const line = (v, level) => {
      const st = isStale(v, level) ? 'approved (DESACTUALIZADO)' : v.status;
      const bits = [st];
      if (v.summary) bits.push(`“${v.summary}”`);
      if (v.instruction) bits.push(`pedido: ${v.instruction}`);
      if (v.note) bits.push(`nota: ${v.note}`);
      if (v.rejection) bits.push(`rechazo: ${v.rejection}`);
      return bits.join(' · ');
    };
    for (const e of layout) {
      const s = e.scene;
      console.log(`\n[${s.id}] ${s.title || ''}  ${e.start.toFixed(2)}–${e.end.toFixed(2)}s  activa=${activeVariant(s)?.id}`);
      for (const v of s.variants) if (v.status !== 'hidden') console.log(`   ${v.id}: ${line(v, 'scene')}`);
      for (const c of activeVariant(s).clips || []) {
        const av = activeVariant(c);
        console.log(`   · ${c.track}/${c.id} (${c.label || ''}) activa=${av?.id} ${av?.preset} @${(+av?.start).toFixed(3)}s+${(+av?.duration).toFixed(3)}s`);
        for (const v of c.variants) if (v.status !== 'hidden' && (v.note || v.rejection || v.status !== 'draft' || c.variants.length > 1)) console.log(`       ${v.id}: ${line(v, 'clip')}`);
      }
    }
    const reqDir = path.join(project.internal, 'requests');
    if (fs.existsSync(reqDir)) {
      const reqs = fs
        .readdirSync(reqDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(reqDir, f), 'utf8')))
        .filter((r) => r.status !== 'done' && r.status !== 'cancelled');
      if (reqs.length) {
        console.log('\nPedidos abiertos:');
        for (const r of reqs) console.log(`   ${r.id} ${r.status} ${r.kind} ${JSON.stringify(r.target)} “${r.instruction}” ${r.error || ''}`);
      }
    }
    return;
  }

  if (cmd === 'snapshot') {
    const { scene } = project.read();
    let times = String(flags.t || '0')
      .split(',')
      .map(Number);
    if (flags.scene) {
      const e = layoutScenes(scene).find((x) => x.scene.id === flags.scene);
      if (!e) die('escena no encontrada');
      times = times.map((t) => e.start + t);
    }
    const r = await withServer(dir, (srv) => snapshots({ serverUrl: srv.url, meta: scene.meta, times, outDir: path.join(project.internal, 'snapshots'), scale: +(flags.scale || 0.5) }));
    for (const w of r.warnings) console.log('⚠ ' + w);
    for (const f of r.files) console.log(`t=${f.t.toFixed(2)}s  ${f.file}`);
    return;
  }

  if (cmd === 'render') {
    const { scene } = project.read();
    const { errors } = validate(scene, project);
    if (errors.length) die('scene.json inválido:\n  ' + errors.join('\n  '));
    const q = flags.quality || '1080';
    const out = flags.out || path.join(project.dir, 'exports', `${(scene.meta.title || 'comic').replace(/[^\w-]+/g, '_')}_${q}.mp4`);
    let last = 0;
    const r = await withServer(dir, (srv) =>
      renderVideo({
        serverUrl: srv.url,
        meta: scene.meta,
        outFile: out,
        quality: q,
        codec: flags.codec || 'h264',
        from: flags.from ? +flags.from : 0,
        to: flags.to ? +flags.to : undefined,
        onProgress: (p) => {
          if (Date.now() - last > 2000 || p.frame === p.frames) {
            last = Date.now();
            process.stdout.write(`  cuadro ${p.frame}/${p.frames}  ${p.elapsed.toFixed(0)}s  eta ${p.eta.toFixed(0)}s\n`);
          }
        },
      }),
    );
    for (const w of r.warnings) console.log('⚠ ' + w);
    return console.log(`✓ ${r.outFile}  (${r.frames} cuadros en ${r.seconds.toFixed(1)}s)`);
  }

  if (cmd === 'studio') {
    ensureBuilt();
    const srv = await startServer({ projectDir: dir, port: +(flags.port || 4777) });
    console.log(`✓ Comic Studio en ${srv.url}  (proyecto ${project.dir})`);
    if (flags.open) {
      const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', srv.url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [srv.url]];
      spawn(c, a, { stdio: 'ignore', detached: true }).unref();
    }
    return; // queda corriendo
  }

  die('comando desconocido: ' + cmd + '\n\n' + HELP);
}

main().catch((e) => die(e.stack || e.message));
