#!/usr/bin/env node
// CLI de comic-motion. Ver SKILL.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openProject, newScene, validate, catalog, SKILL_DIR, checkGaps } from '../src/project.js';
import { EASES } from '../src/player/ease.js';
import { startServer } from '../src/server.js';
import { renderVideo, snapshots } from '../src/render.js';
import { ingest, detectPanels, cutout, ingestLayers, retagLayersAsset } from '../src/ingest.js';
import { annotateAssetBounds } from '../src/pixel-bounds.js';
import { listRecipes, applyRecipe } from '../src/recipes/index.js';
import { hoistPanelDefaults } from '../src/project.js';
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
  layers <dir> <scene_layout.json> [--exclude margins,…] [--scenes]
                                      viñetas por capas (PNGs de un PSD + layout): un asset type 'layers'
                                      por escena con roles, profundidad y clipTo automáticos (--scenes: y una escena por asset)
  panels <dir> <assetId>              detecta viñetas en una página → overlay numerado para revisar
  cutout <dir> <assetId>              recorta el personaje (BiRefNet, JS) → assets/<id>.cutout.png
  tags <dir> [assetId] [--reset]      alias semánticos de capas (@hero, @bg-main, @text-1…): ver/recalcular
                                      (conserva los tags editados a mano salvo --reset); también mide alfa,
                                      capas sólidas y el marco de las imágenes (límites de cámara)
  recipe <dir> <sceneId> <receta> [--target @hero] [--at s] [--duration s] [--replace-camera] [--activate] [--text T] [--dry]
                                      expande una receta de escena a clips normales (si la escena está aprobada,
                                      crea una variante nueva en draft). recipe --list: catálogo
  defaults <dir> [--hoist]            muestra meta.panelDefaults; --hoist sube los params repetidos en todas las viñetas
  check <dir>                         valida scene.json
  check <dir> --gaps [fps]            además: huecos de cámara (bordes vacíos, textos cortados, VFX fuera de su viñeta)
  status <dir>                        resumen de revisión: aprobado / rechazado / notas / pedidos
  presets                             catálogo de presets y params (markdown)
  snapshot <dir> --t 0.5,2,3.4 [--scale 0.5] [--scene s2]   cuadros PNG para mirar
  studio <dir> [--port 4777] [--open] [--lan]   levanta el panel (--lan: accesible desde la red local)
  render <dir> [--quality 1080|4k] [--codec h264|prores] [--fps 24|30|60] [--from s --to s] [--out f.mp4] [--workers auto|1-8]

  test de paridad DOM/GPU: node test/gpu-parity.mjs [--webgl] [--keep]
  test de paridad de capas vs el PSD: node test/layers-parity.mjs <scene_layout.json> [--webgl] [--keep]`;

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
    const kinds = ['transition', 'camera', 'panel', 'filter', 'vfx', 'fx', 'bubble', 'ono'];
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
  if (cmd === 'recipe' && (flags.list || !args.length)) {
    for (const r of listRecipes()) console.log(`- ${r.id.padEnd(14)} ${r.label} (${r.mood}): ${r.description}`);
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

  if (cmd === 'layers') {
    const layout = args[1];
    if (!layout || !fs.existsSync(layout)) die('pasá la ruta del scene_layout.json');
    const { scene, rev } = project.read();
    const exclude = typeof flags.exclude === 'string' ? flags.exclude.split(',').map((s) => s.trim()) : [];
    const res = await ingestLayers(project, scene, layout, { exclude, makeScenes: !!flags.scenes });
    project.write(scene, rev);
    const pad = (s, n) => String(s ?? '').padEnd(n);
    for (const r of res) {
      console.log(`\n✓ ${r.assetId}  layers ${r.asset.w}×${r.asset.h}  ${r.asset.layers.length} capas  preview ${r.asset.file}${r.sceneId ? `  → escena ${r.sceneId}` : ''}`);
      console.log('  ' + pad('capa', 22) + pad('rol', 11) + pad('depth', 7) + pad('clipTo', 22) + pad('tags', 20) + 'por qué');
      for (const d of r.decisions) {
        const why = [d.why];
        if (d.global) why.push('global');
        if (d.clip) why.push(`corte contra ${d.clip.bg}: ${d.clip.cutMask}px sobre el borde + ${d.clip.cutRect}px pegado/bajo divisor, fuera del fondo ${(d.clip.outside * 100).toFixed(1)}%${d.clipTo ? (d.breakout ? `, asoma ${d.breakout}px libres` : '') : ' → libre'}`);
        if (d.dividerOf) why.push(`pegado a ${d.dividerOf}`);
        if (d.attachedTo) why.push(`adorno de ${d.attachedTo}`);
        if (d.role === 'text') why.push(d.keepOrder ? `orden del PSD (se solapa con ${d.blockedBy.join(', ')})` : 'arriba de todo');
        console.log('  ' + pad(d.id, 22) + pad(d.role, 11) + pad(d.depth, 7) + pad(d.clipTo || '—', 22) + pad((d.tags.map((t) => '@' + t).join(' ') || '—') + (d.tagsKept ? '*' : ''), 20) + why.filter(Boolean).join('; '));
      }
    }
    console.log('\nRevisá roles y clipTo mirando la preview; se corrigen con params.layers de la viñeta (o en el asset).');
    return;
  }

  if (cmd === 'tags') {
    const { scene, rev } = project.read();
    const all = args[1] ? [args[1]] : Object.keys(scene.assets);
    const ids = all.filter((k) => scene.assets[k]?.type === 'layers' || (args[1] && scene.assets[k]?.type !== 'image'));
    // imágenes planas: solo los datos de límites de cámara (marco/canaleta del borde)
    const imgs = all.filter((k) => scene.assets[k]?.type === 'image');
    if (!ids.length && !imgs.length) die('no hay assets de capas (comic layers)');
    const pad = (s, n) => String(s ?? '').padEnd(n);
    for (const id of ids) {
      const a = scene.assets[id];
      if (a?.type !== 'layers') die(`${id} no es un asset de capas`);
      const res = await retagLayersAsset(project, a, { reset: !!flags.reset });
      console.log(`\n${id}`);
      console.log('  ' + pad('capa', 22) + pad('rol', 11) + pad('depth', 7) + 'tags');
      for (const r of res) {
        const l = a.layers.find((x) => x.id === r.id);
        console.log('  ' + pad(r.id, 22) + pad(l.role, 11) + pad(l.depth, 7) + (r.tags.map((t) => '@' + t).join(' ') || '—') + (r.kept ? `   (editados a mano; auto: ${r.auto.map((t) => '@' + t).join(' ') || '—'})` : ''));
      }
    }
    for (const id of imgs) {
      const e = await annotateAssetBounds(project.dir, scene.assets[id]);
      console.log(`\n${id} (imagen): ${e ? `marco ${e.color}, franja [${e.band.join(', ')}] px (límites de cámara)` : 'sin marco parejo en los bordes'}`);
    }
    project.write(scene, rev);
    console.log('\nSe usan como "@hero", "@bg-main", "@text-1"… en between, clipTo, params.layers y el target de move3d. Editá `tags` en la capa para corregir (se conservan).');
    return;
  }

  if (cmd === 'recipe') {
    const [, sceneId, name] = args;
    if (!sceneId || !name) die('uso: comic recipe <dir> <sceneId> <receta> (comic recipe --list)');
    const { scene, rev } = project.read();
    const r = applyRecipe(scene, sceneId, name, { target: flags.target, at: flags.at, duration: flags.duration, replaceCamera: !!flags['replace-camera'], activate: !!flags.activate, text: flags.text, direction: flags.direction });
    const { errors } = validate(scene, project);
    if (!flags.dry) project.write(scene, rev);
    console.log(`${flags.dry ? '(dry) ' : '✓ '}${r.summary}`);
    console.log(r.created ? `  la variante ${r.base} de ${sceneId} está aprobada (o había que sacar clips aprobados): ${flags.dry ? 'crearía' : 'creé'} ${r.variant} (draft, copia de ${r.base} + receta)${r.activated ? ' y la dejé activa' : `; la activa sigue siendo ${scene.scenes.find((s) => s.id === sceneId).active} (verla en el panel o con --activate)`}` : `  agregado a ${sceneId}/${r.variant} (draft)`);
    if (r.removed.length) console.log(`  cámaras sacadas: ${r.removed.join(', ')}`);
    for (const c of r.added) console.log(`  + ${c.track}/${c.id}  ${c.preset} @${c.start}s+${c.duration}s  ${JSON.stringify(c.params)}`);
    if (r.panelVariant) console.log(`  viñeta ${r.panelVariant.clip}: variante ${r.panelVariant.id} con ${JSON.stringify({ ...r.panelVariant.panel, layers: Object.keys(r.panelVariant.layers).length ? r.panelVariant.layers : undefined })}`);
    for (const n of r.notes) console.log('  ⚠ ' + n);
    for (const e of errors) console.log('  ✗ ' + e);
    return;
  }

  if (cmd === 'defaults') {
    const { scene, rev } = project.read();
    if (flags.hoist) {
      const r = hoistPanelDefaults(scene);
      project.write(scene, rev);
      console.log(`✓ subí a meta.panelDefaults: ${JSON.stringify(r.hoisted)}  (${r.variants} variantes de viñeta, ${r.restamped} aprobaciones re-selladas: el render no cambia)`);
    }
    console.log('meta.panelDefaults = ' + JSON.stringify(scene.meta.panelDefaults || {}));
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
    console.log(`✓ scene.json válido (${warnings.length} avisos)`);
    if (flags.gaps) {
      // huecos de cámara: muestrea cada escena (4 fps; --gaps 8 para más) sin navegador
      const fps = flags.gaps !== true && Number(flags.gaps) > 0 ? Number(flags.gaps) : 4;
      const g = checkGaps(project.read().scene, { fps });
      for (const w of g.warnings) console.log('⚠ ' + w);
      for (const l of g.lines) console.log('✗ ' + l);
      if (g.lines.length) process.exit(1);
      console.log(`✓ sin huecos de cámara (${fps} fps)`);
    }
    return;
  }

  if (cmd === 'status') {
    const { scene } = project.read();
    const layout = layoutScenes(scene);
    console.log(`${scene.meta.title} — ${layout.length} escenas, ${totalDuration(scene).toFixed(2)}s`);
    const dirLines = (d, pad) => Object.entries(d || {}).map(([k, v]) => `${pad}${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    if (scene.meta.direction && Object.keys(scene.meta.direction).length) console.log('\nDirección del proyecto:\n' + dirLines(scene.meta.direction, '   ').join('\n'));
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
      if (s.direction && Object.keys(s.direction).length) console.log('   dirección:\n' + dirLines(s.direction, '     ').join('\n'));
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
    const guideDir = path.join(project.internal, 'guides');
    if (fs.existsSync(guideDir)) {
      const open = fs
        .readdirSync(guideDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(guideDir, f), 'utf8')))
        .filter((g) => ['thinking', 'question', 'done', 'error'].includes(g.status));
      if (open.length) {
        console.log('\nGuiados abiertos:');
        for (const g of open) console.log(`   ${g.id} ${g.status} ${g.target ? JSON.stringify(g.target) : 'proyecto'} · ${g.transcript.length} respuesta(s)${g.instruction ? ` · “${g.instruction}”` : ''}`);
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
        fps: flags.fps ? +flags.fps : undefined,
        from: flags.from ? +flags.from : 0,
        to: flags.to ? +flags.to : undefined,
        workers: flags.workers && flags.workers !== 'auto' ? +flags.workers : 'auto',
        onProgress: (p) => {
          if (Date.now() - last > 2000 || p.frame === p.frames) {
            last = Date.now();
            process.stdout.write(`  cuadro ${p.frame}/${p.frames}  ${p.elapsed.toFixed(0)}s  eta ${p.eta.toFixed(0)}s${p.workers > 1 ? `  (${p.workers} en paralelo)` : ''}\n`);
          }
        },
      }),
    );
    for (const w of r.warnings) console.log('⚠ ' + w);
    return console.log(`✓ ${r.outFile}  (${r.frames} cuadros verificados con ffprobe, ${r.seconds.toFixed(1)}s, ${r.workers} en paralelo${r.gpuBackend ? ', VFX con ' + r.gpuBackend : ''})`);
  }

  if (cmd === 'studio') {
    ensureBuilt();
    const srv = await startServer({ projectDir: dir, port: +(flags.port || 4777), host: flags.lan ? '0.0.0.0' : '127.0.0.1' });
    console.log(`✓ Comic Studio en ${srv.url}  (proyecto ${project.dir})`);
    for (const u of srv.lan) console.log(`  en la red local: ${u}  (sin WebGPU fuera de localhost: el preview usa WebGL2)`);
    if (flags.open) {
      const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', srv.url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [srv.url]];
      spawn(c, a, { stdio: 'ignore', detached: true }).unref();
    }
    return; // queda corriendo
  }

  die('comando desconocido: ' + cmd + '\n\n' + HELP);
}

main().catch((e) => die(e.stack || e.message));
