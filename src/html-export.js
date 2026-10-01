// Export a HTML (`comic html`): el player web (dist/web.js) + la escena activa saneada + solo los archivos que usa.
//   carpeta (por defecto): index.html, player.js, scene.json, effects.js (si hay efectos custom), assets/, fonts/
//   --single: un .html con todo adentro (base64), para abrir con doble clic (file://) o mandar por mail.
// No abre navegador ni server: copia, sanea y escribe. El player web es el mismo de siempre (src/player).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { SKILL_DIR } from './project.js';
import { BUILTIN, withPanelDefaults } from './player/presets.js';
import { activeVariant } from './shared/scene.js';

export const SINGLE_MAX = 50 * 1024 * 1024; // --single: tope de lo embebido (antes del base64)
const MARK = 'comic-motion web export';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const mimeOf = (f) => (MIME[path.extname(f).toLowerCase()] || 'application/octet-stream').split(';')[0];

const FONT_FILES = { 'Comic Neue': ['ComicNeue-Bold.ttf', 'ComicNeue-Regular.ttf'], Bangers: ['Bangers-Regular.ttf'] };
const FONT_LICENSE = { 'Comic Neue': 'OFL-ComicNeue.txt', Bangers: 'OFL-Bangers.txt' };

// Claves que no hacen falta para reproducir: memoria de revisión, pedidos, notas, dirección del guiado,
// configuración del generador y datos del ingest (rutas de origen, descripciones para el modelo).
const META_DROP = ['generatorModel', 'guideModel', 'maxVariants', 'generatorConcurrency', 'direction'];
const SCENE_DROP = ['direction', 'notes'];
const VARIANT_DROP = ['status', 'note', 'notes', 'rejection', 'approvedHash', 'createdAt', 'instruction', 'summary', 'parent', 'request', 'requestId', 'guide', 'history'];
const ASSET_DROP = ['source', 'description', 'contactSheet', 'contactTimes', 'regions', 'panels', 'notes'];
const LAYER_DROP = ['tagsAuto'];

const omit = (o, keys) => {
  const r = { ...o };
  for (const k of keys) delete r[k];
  return r;
};
const absPathLike = (s) => typeof s === 'string' && (/^(\/(Users|home|private|var|tmp|Volumes|mnt)\/)|^[A-Za-z]:[\\/]|^file:\/\//.test(s) || /^~\//.test(s));

// Escena activa saneada + archivos que usa. files: Map rutaEnElExport → rutaAbsolutaDeOrigen.
export function prepareWebScene(scene, project) {
  const builtinIds = new Set(BUILTIN.map((d) => d.id));
  const customList = project.customEffects();
  const customById = Object.fromEntries(customList.map((c) => [c.id, c]));
  const usedPresets = new Set();
  const warnings = [];

  const scenes = [];
  for (const s of scene.scenes || []) {
    const v = activeVariant(s);
    if (!v) continue;
    const clips = [];
    for (const c of v.clips || []) {
      const av = activeVariant(c);
      if (!av || av.status === 'hidden') continue;
      usedPresets.add(av.preset);
      for (const f of av.params?.filters || []) if (f?.preset) usedPresets.add(f.preset);
      clips.push({ ...omit(c, ['variants', 'notes']), active: av.id, variants: [omit(av, VARIANT_DROP)] });
    }
    if (v.transition?.preset) usedPresets.add(v.transition.preset);
    scenes.push({ ...omit(s, [...SCENE_DROP, 'variants']), active: v.id, variants: [{ ...omit(v, [...VARIANT_DROP, 'clips']), clips }] });
  }
  const meta = omit(scene.meta || {}, META_DROP);

  // assets usados: cualquier valor de texto de los params que sea un id de asset (params.asset de las viñetas, y
  // lo que un efecto custom lea con ctx.asset(id))
  const assetIds = new Set(Object.keys(scene.assets || {}));
  const used = new Set();
  const depthOf = {};
  const walk = (x) => {
    if (typeof x === 'string') {
      if (assetIds.has(x)) used.add(x);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  for (const s of scenes)
    for (const c of s.variants[0].clips) {
      const av = c.variants[0];
      walk(av.params);
      if (c.track === 'panel') {
        const p = withPanelDefaults(meta, av.params || {});
        if (p.asset && p.depth) depthOf[p.asset] = true;
      }
    }

  const files = new Map();
  const taken = new Map(); // ruta en el export → origen (evita choques al aplanar rutas raras)
  const addFile = (rel) => {
    if (!rel || typeof rel !== 'string' || /^(https?:|data:|blob:)/.test(rel)) return rel;
    const src = path.resolve(project.dir, rel);
    if (!fs.existsSync(src)) {
      warnings.push(`falta el archivo ${rel}`);
      return rel;
    }
    // dentro del proyecto se conserva la ruta relativa; afuera (o absoluta) va a assets/<nombre>
    let out = path.relative(project.dir, src).split(path.sep).join('/');
    if (out.startsWith('..') || path.isAbsolute(out)) out = 'assets/' + path.basename(src);
    let k = 1;
    while (taken.has(out) && taken.get(out) !== src) out = out.replace(/(\.[^./]+)?$/, (e) => `-${k++}${e || ''}`);
    taken.set(out, src);
    files.set(out, src);
    return out;
  };

  const assets = {};
  for (const id of used) {
    const a0 = scene.assets[id];
    if (!a0) continue;
    const a = omit(a0, ASSET_DROP);
    // huellas de la medición de límites: alcanza con saber que se midió (bounds.js: hasFrameData)
    if (a.bounds && typeof a.bounds === 'object') a.bounds = { v: a.bounds.v, files: {} };
    if (a.type === 'video') {
      // el player usa el proxy webm; el original no viaja
      const f = addFile(a.proxy || a.file);
      a.file = f;
      if (a.proxy) a.proxy = f;
    } else if (a.type === 'layers') {
      a.file = addFile(a.file);
      a.layers = (a.layers || []).map((l0) => {
        const l = omit(l0, LAYER_DROP);
        l.file = addFile(l.file);
        if (l.clipMask?.file) l.clipMask = { ...l.clipMask, file: addFile(l.clipMask.file) };
        return l;
      });
    } else {
      a.file = addFile(a.file);
      if (depthOf[id]) {
        if (a.cutout) a.cutout = addFile(a.cutout);
        if (a.bgfill) a.bgfill = addFile(a.bgfill);
      } else {
        delete a.cutout;
        delete a.bgfill;
      }
    }
    assets[id] = a;
  }

  // efectos custom usados
  const effects = [];
  for (const id of usedPresets) {
    if (builtinIds.has(id)) continue;
    if (customById[id]) effects.push({ id, file: path.join(project.dir, customById[id].file) });
    else warnings.push(`preset desconocido ${id} (no hay effects/${id}.js)`);
  }

  // fuentes: las de los globos/onomatopeyas usados (los efectos custom pueden usar cualquiera: van todas)
  const fams = new Set();
  for (const s of scenes)
    for (const c of s.variants[0].clips) {
      const av = c.variants[0];
      if (c.track === 'bubble' || av.preset === 'bubble') fams.add(av.params?.font || 'Comic Neue');
      if (c.track === 'ono') fams.add(av.params?.font || 'Bangers');
      if (av.params?.font && FONT_FILES[av.params.font]) fams.add(av.params.font);
    }
  if (effects.length) Object.keys(FONT_FILES).forEach((f) => fams.add(f));
  const fonts = [];
  for (const fam of fams) {
    for (const f of FONT_FILES[fam] || []) {
      files.set('fonts/' + f, path.join(SKILL_DIR, 'fonts', f));
      fonts.push(f);
    }
    files.set('fonts/' + FONT_LICENSE[fam], path.join(SKILL_DIR, 'fonts', FONT_LICENSE[fam]));
  }

  const clean = { meta, assets, scenes };
  // nada de rutas absolutas del usuario
  const leaks = [];
  const scan = (x, where) => {
    if (absPathLike(x)) leaks.push(where);
    else if (Array.isArray(x)) x.forEach((y, i) => scan(y, `${where}[${i}]`));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) scan(y, `${where}.${k}`);
  };
  scan(clean, 'scene');
  for (const l of leaks) warnings.push(`ruta absoluta en ${l} (se exporta igual; revisala)`);
  return { scene: clean, files, effects, fonts, warnings };
}

async function bundleEffects(effects) {
  if (!effects.length) return '';
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    throw new Error('para exportar efectos custom hace falta esbuild (cd ' + SKILL_DIR + ' && npm install)');
  }
  const contents = effects.map((e, i) => `import e${i} from ${JSON.stringify(e.file)};`).join('\n') + `\nwindow.__comicEffects = [${effects.map((_, i) => 'e' + i).join(', ')}];\n`;
  const r = await esbuild.build({ stdin: { contents, resolveDir: SKILL_DIR, loader: 'js' }, bundle: true, format: 'iife', target: 'chrome120', minify: true, write: false, legalComments: 'none', logLevel: 'silent' });
  return r.outputFiles[0].text;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const jsonInScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
// dentro de <script> inline, "</script" cortaría el bloque
const jsInScript = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

function page({ title, scene, config, head = '', body = '' }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="${MARK}">
<link rel="icon" href="data:,">
<title>${esc(title)}</title>
<style>html,body{margin:0;height:100%;background:#000}</style>
${head}</head>
<body>
<div id="comic-app"></div>
<script id="comic-scene" type="application/json">${jsonInScript(scene)}</script>
<script id="comic-config" type="application/json">${jsonInScript(config)}</script>
${body}</body>
</html>
`;
}

const slug = (s) =>
  String(s || 'comic')
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'comic';

export function defaultHtmlOut(project, scene, single) {
  const base = slug(scene.meta?.title);
  return path.join(project.dir, 'exports', single ? `${base}.html` : `${base}_web`);
}

// ¿Es una carpeta exportada por nosotros? (para poder reemplazarla sin miedo)
export function isWebExportDir(dir) {
  const f = path.join(dir, 'index.html');
  if (!fs.existsSync(f)) return false;
  return fs.readFileSync(f, 'utf8').slice(0, 2000).includes(MARK);
}

const dirSize = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size;
  return n;
};

// opts: { out?, single?, quality ('1080'|'4k'), controls (true), autoplay (false), loop (false) }
export async function exportHtml(project, { out, single = false, quality = '4k', controls = true, autoplay = false, loop = false } = {}) {
  const webJs = path.join(SKILL_DIR, 'dist', 'web.js');
  if (!fs.existsSync(webJs)) throw new Error(`falta dist/web.js: cd ${SKILL_DIR} && npm run build`);
  const { scene: full } = project.read();
  const prep = prepareWebScene(full, project);
  const t0 = Date.now();
  out = path.resolve(out || defaultHtmlOut(project, full, single));
  if (single && !out.toLowerCase().endsWith('.html')) out += '.html';
  const list = [...prep.files].filter(([rel]) => !rel.endsWith('.txt')).map(([rel, src]) => ({ path: rel, size: fs.statSync(src).size, type: mimeOf(rel) }));
  const config = { v: 1, title: full.meta?.title || '', quality: quality === '1080' ? '1080' : '4k', controls: controls !== false, autoplay: !!autoplay, loop: !!loop, embedded: !!single, files: list, fonts: prep.fonts };
  const player = fs.readFileSync(webJs, 'utf8');
  const effectsJs = await bundleEffects(prep.effects);
  const title = full.meta?.title || 'comic';
  const assetBytes = list.reduce((a, f) => a + f.size, 0);

  if (single) {
    if (assetBytes > SINGLE_MAX) throw new Error(`--single: los archivos suman ${(assetBytes / 1048576).toFixed(0)} MB (tope ${SINGLE_MAX / 1048576} MB). Exportá a carpeta (sin --single) y subila a un hosting, o achicá los videos/imágenes.`);
    const blobs = list.map((f) => `<script type="application/octet-stream" data-path="${esc(f.path)}">${fs.readFileSync(prep.files.get(f.path)).toString('base64')}</script>`).join('\n');
    const licenses = [...prep.files].filter(([rel]) => rel.endsWith('.txt')).map(([, src]) => fs.readFileSync(src, 'utf8').replace(/--/g, '- -'));
    const html = page({
      title,
      scene: prep.scene,
      config,
      body: `${blobs}\n${effectsJs ? `<script>${jsInScript(effectsJs)}</script>\n` : ''}<script>${jsInScript(player)}</script>\n${licenses.length ? `<!-- Fuentes embebidas bajo SIL Open Font License:\n${licenses.join('\n')}\n-->\n` : ''}`,
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + '.tmp', html);
    fs.renameSync(out + '.tmp', out);
    return { out, single: true, bytes: fs.statSync(out).size, assetBytes, files: list.length, effects: prep.effects.map((e) => e.id), warnings: prep.warnings, seconds: (Date.now() - t0) / 1000 };
  }

  // carpeta: si ya existe, solo se reemplaza si es un export nuestro (o está vacía)
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) throw new Error(`${out} existe y no es una carpeta`);
    if (fs.readdirSync(out).length && !isWebExportDir(out)) throw new Error(`${out} ya existe y no es un export HTML de comic-motion: elegí otra carpeta con --out`);
  }
  const tmp = out + '.tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const [rel, src] of prep.files) {
      const dst = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // clon copy-on-write si el disco lo permite (APFS): no ocupa espacio extra
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
    }
    fs.writeFileSync(path.join(tmp, 'player.js'), player);
    if (effectsJs) fs.writeFileSync(path.join(tmp, 'effects.js'), effectsJs);
    fs.writeFileSync(path.join(tmp, 'scene.json'), JSON.stringify(prep.scene, null, 1) + '\n');
    fs.writeFileSync(path.join(tmp, 'index.html'), page({ title, scene: prep.scene, config, body: `${effectsJs ? '<script src="effects.js"></script>\n' : ''}<script src="player.js"></script>\n` }));
    fs.rmSync(out, { recursive: true, force: true });
    fs.renameSync(tmp, out);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { out, single: false, index: path.join(out, 'index.html'), bytes: dirSize(out), assetBytes, files: list.length, effects: prep.effects.map((e) => e.id), warnings: prep.warnings, seconds: (Date.now() - t0) / 1000 };
}

// Server estático mínimo para mirar un export (comic html --serve). Rangos para los videos.
export function serveStatic(dir, { port = 0, host = '127.0.0.1' } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.resolve(root, '.' + p);
    if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404);
      return res.end('no encontrado');
    }
    const size = fs.statSync(f).size;
    const type = MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? +m[1] : size - +m[2];
      const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(() => r())) })));
}
