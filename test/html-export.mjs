#!/usr/bin/env node
// Test del export HTML (comic html): arma un proyecto chico (imagen con ken burns + cámara + VFX de nieve en GPU +
// globo + onomatopeya + efecto custom, y un video con transición wipe), lo exporta a carpeta y a un solo archivo,
// revisa qué viaja (solo lo activo, sin memoria de revisión ni rutas absolutas, solo los archivos usados) y abre
// el resultado con Playwright:
//   - carpeta por http (server estático): seek a varios t y comparación contra `comic snapshot` del mismo t;
//   - carpeta por file://: el navegador no deja leer los archivos → tiene que mostrar el aviso (hay VFX GPU);
//   - --single por file:// y por http: mismos cuadros que el snapshot;
//   - controles: play avanza en tiempo real, espacio pausa, → avanza un cuadro.
//   node test/html-export.mjs [--keep] [--webgl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { startServer } from '../src/server.js';
import { snapshots } from '../src/render.js';
import { serveStatic } from '../src/html-export.js';

const keep = process.argv.includes('--keep');
const forceWebGL = process.argv.includes('--webgl');
if (forceWebGL) process.env.COMIC_FORCE_WEBGL = '1';
const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-html-export-'));
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(dir, 'effects'), { recursive: true });

const W = 1280;
const H = 720;
let shapes = '';
for (let i = 0; i < 24; i++) shapes += `<line x1="${20 + i * 50}" y1="20" x2="${80 + i * 50}" y2="${H - 20}" stroke="#${i % 2 ? '123' : 'c21'}" stroke-width="${1 + (i % 3)}"/>`;
for (let i = 0; i < 5; i++) shapes += `<text x="80" y="${110 + i * 110}" font-family="Helvetica, Arial" font-size="${26 + i * 8}" fill="#111">WEB ${i} ¡PAF!</text>`;
const svg = (bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="#7fb5e8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
await sharp(Buffer.from(svg('#fbeec2')))
  .png()
  .toFile(path.join(dir, 'assets/img.png'));
await sharp(Buffer.from(svg('#e0e0e0')))
  .png()
  .toFile(path.join(dir, 'assets/unused.png'));
const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
};
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'assets/clip.mp4')]);
ff(['-i', path.join(dir, 'assets/clip.mp4'), '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', path.join(dir, 'assets/clip.proxy.webm')]);

// efecto custom (fx): un rótulo que se desliza, función pura de t
fs.writeFileSync(
  path.join(dir, 'effects/rotulo.js'),
  `export default { id: 'rotulo', kind: 'fx', label: 'Rótulo', params: [{ key: 'text', type: 'text', default: 'HOLA' }],
  build(ctx) { const d = document.createElement('div'); d.textContent = ctx.params.text;
    Object.assign(d.style, { position: 'absolute', left: '0', top: '40px', padding: '6px 14px', background: '#111', color: '#ff0', fontFamily: 'Bangers', fontSize: '42px' });
    ctx.mount(d, 'screen'); return { update(t) { d.style.transform = 'translateX(' + (40 + t * 300) + 'px)'; } }; } };\n`,
);
// otro efecto custom que no se usa: no tiene que viajar
fs.writeFileSync(path.join(dir, 'effects/sobra.js'), `export default { id: 'sobra', kind: 'fx', label: 'x', params: [], build() { return {}; } };\n`);

const clip = (id, track, preset, start, duration, params, extra = {}) => ({ id, track, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset, start, duration, params }], ...extra });
const scene = {
  meta: { title: 'html export test', width: W, height: H, fps: 24, background: '#101010', generatorModel: 'sonnet', maxVariants: 3, direction: { tono: 'secreto de dirección' } },
  assets: {
    img: { file: 'assets/img.png', type: 'image', w: W, h: H, source: '/Users/alguien/Desktop/original.png', description: 'descripción para el modelo' },
    clip: { file: 'assets/clip.mp4', proxy: 'assets/clip.proxy.webm', type: 'video', w: 640, h: 360, duration: 3, source: '/Users/alguien/clip.mov' },
    unused: { file: 'assets/unused.png', type: 'image', w: W, h: H },
  },
  scenes: [
    {
      id: 's1',
      active: 'v2',
      direction: { ritmo: 'secreto' },
      variants: [
        { id: 'v1', status: 'rejected', rejection: 'NO-VIAJA-rechazo', duration: 2, clips: [clip('p0', 'panel', 'panel', 0, 2, { asset: 'unused' })] },
        {
          id: 'v2',
          status: 'approved',
          note: 'NO-VIAJA-nota',
          approvedHash: 'x',
          duration: 2,
          clips: [
            clip('p1', 'panel', 'panel', 0, 2, { asset: 'img', rect: [60, 40, 1160, 640], kenBurns: { from: { zoom: 1, fx: 0.4, fy: 0.45 }, to: { zoom: 1.25, fx: 0.6, fy: 0.55 } } }),
            clip('cam', 'camera', 'camera', 0, 2, {
              keys: [
                { at: 0, cx: 640, cy: 360, w: 1280 },
                { at: 2, cx: 720, cy: 400, w: 900 },
              ],
            }),
            clip('nieve', 'vfx', 'snow', 0, 2, { target: 'p1' }),
            clip('globo', 'bubble', 'bubble', 0.3, 1.7, { text: '¡Hola web!', box: [700, 90, 380, 150], tail: [820, 330] }),
            clip('paf', 'ono', 'ono', 0.8, 1.0, { text: 'PAF', at: [330, 470], size: 160 }),
            clip('rot', 'fx', 'rotulo', 0.2, 1.6, { text: 'CUSTOM' }),
            // clip oculto: no viaja
            { id: 'oculto', track: 'fx', active: 'v1', variants: [{ id: 'v1', status: 'hidden', preset: 'sobra', start: 0, duration: 1, params: {} }] },
          ],
        },
      ],
    },
    {
      id: 's2',
      active: 'v1',
      variants: [
        {
          id: 'v1',
          status: 'draft',
          duration: 2,
          transition: { preset: 'wipe', duration: 0.5, params: { dir: 'left' } },
          clips: [clip('p2', 'panel', 'panel', 0, 2, { asset: 'clip', rect: [0, 0, W, H], border: 0 }), clip('flash', 'fx', 'flash', 0.6, 0.3, {})],
        },
      ],
    },
  ],
};
fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(scene, null, 1));

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) fails++;
};

// ---------- export por la CLI ----------
const cli = (...a) => spawnSync(process.execPath, [path.join(SKILL, 'bin/comic.js'), ...a], { encoding: 'utf8' });
const outDir = path.join(dir, 'exports', 'web');
const outSingle = path.join(dir, 'exports', 'uno.html');
let r = cli('html', dir, '--out', outDir, '--no-controls');
ok(r.status === 0, 'comic html (carpeta) ' + (r.status === 0 ? r.stdout.trim().split('\n')[0] : r.stderr));
r = cli('html', dir, '--out', outSingle, '--single');
ok(r.status === 0, 'comic html --single ' + (r.status === 0 ? r.stdout.trim().split('\n')[0] : r.stderr));
// carpeta con controles (para probar play/pausa)
const outCtrl = path.join(dir, 'exports', 'ctrl');
r = cli('html', dir, '--out', outCtrl, '--loop');
ok(r.status === 0, 'comic html con controles y loop');

// ---------- qué viaja ----------
const listFiles = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(d, e.name), base + e.name + '/') : [base + e.name]));
const files = listFiles(outDir).sort();
console.log('  carpeta: ' + files.join(', '));
for (const f of ['index.html', 'player.js', 'scene.json', 'effects.js', 'assets/img.png', 'assets/clip.proxy.webm']) ok(files.includes(f), `viaja ${f}`);
for (const f of ['assets/unused.png', 'assets/clip.mp4']) ok(!files.includes(f), `no viaja ${f}`);
ok(files.some((f) => f.startsWith('fonts/Bangers')) && files.some((f) => f.startsWith('fonts/ComicNeue')) && files.some((f) => f.startsWith('fonts/OFL')), 'fuentes usadas + licencia OFL');
const sj = fs.readFileSync(path.join(outDir, 'scene.json'), 'utf8');
for (const s of ['NO-VIAJA', 'secreto', '/Users/', 'descripción para el modelo', 'generatorModel', 'approvedHash', '"unused"', '"oculto"']) ok(!sj.includes(s), `scene.json sin ${s}`);
const eff = fs.readFileSync(path.join(outDir, 'effects.js'), 'utf8');
ok(eff.includes('rotulo') && !eff.includes('sobra'), 'effects.js: solo el efecto usado');
const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
ok(!/type="module"/.test(html), 'index.html sin módulos ES (script clásico)');
const singleSize = fs.statSync(outSingle).size;
console.log(`  tamaños: carpeta ${(listFiles(outDir).reduce((a, f) => a + fs.statSync(path.join(outDir, f)).size, 0) / 1048576).toFixed(2)} MB, single ${(singleSize / 1048576).toFixed(2)} MB`);

// ---------- referencia: comic snapshot (mismo player, página del exportador) ----------
const times = [0.25, 0.9, 1.6, 1.85, 2.6, 3.3];
const refDir = path.join(dir, 'ref');
const srv = await startServer({ projectDir: dir, withQueue: false, log: () => {} });
const ref = await snapshots({ serverUrl: srv.url, meta: scene.meta, times, outDir: refDir, scale: 1 });
await srv.close();
console.log(`  snapshot: VFX con ${ref.gpuBackend}${ref.warnings.length ? ' · ' + ref.warnings.join(' · ') : ''}`);

const raw = async (f) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const meanDiff = async (a, b) => {
  const A = await raw(a);
  const B = await raw(b);
  if (A.info.width !== B.info.width || A.info.height !== B.info.height) return { mean: Infinity, size: `${A.info.width}x${A.info.height} vs ${B.info.width}x${B.info.height}` };
  let s = 0;
  let mx = 0;
  for (let i = 0; i < A.data.length; i++) {
    const d = Math.abs(A.data[i] - B.data[i]);
    s += d;
    if (d > mx) mx = d;
  }
  return { mean: s / A.data.length, max: mx };
};

const args = ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', '--hide-scrollbars'];
let browser;
try {
  browser = await chromium.launch({ channel: 'chromium', args: [...args, '--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] });
} catch {
  browser = await chromium.launch({ args });
}

async function openWeb(url, { viewport = { width: W, height: H }, dpr = 1 } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
  if (forceWebGL) await ctx.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined }));
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('pageerror ' + e.message));
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__comicWeb?.ready || window.__comicError, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__comicError);
  const info = err
    ? null
    : await page.evaluate(() => ({
        backend: window.__comicWeb.gpuBackend,
        panels: window.__comicWeb.gpuPanels,
        blocked: window.__comicWeb.fileProtocolBlocked,
        errors: window.__comicWeb.errors,
        loadMs: window.__comicWeb.loadMs,
        duration: window.__comicWeb.duration,
      }));
  return { ctx, page, logs, err, info, wall: Date.now() - t0 };
}

async function compare(label, url) {
  const w = await openWeb(url + (url.includes('?') ? '&' : '?') + 'ui=0');
  if (w.err) {
    ok(false, `${label}: el player falló: ${w.err}`);
    await w.ctx.close();
    return;
  }
  console.log(`  ${label}: listo en ${w.wall} ms (carga ${w.info.loadMs} ms), VFX con ${w.info.backend}, ${w.info.panels} viñeta(s) GPU`);
  ok(Math.abs(w.info.duration - ref.duration) < 1e-6, `${label}: misma duración (${w.info.duration.toFixed(2)}s)`);
  ok(!w.info.blocked, `${label}: archivos cargados`);
  let worst = 0;
  for (const f of ref.files) {
    await w.page.evaluate((t) => window.__comicWeb.seek(t), f.t);
    const shot = path.join(dir, `web-${label.replace(/\W+/g, '_')}-${f.t.toFixed(2)}.png`);
    await w.page.screenshot({ path: shot });
    const d = await meanDiff(shot, f.file);
    worst = Math.max(worst, d.mean);
    ok(d.mean < 1, `${label} t=${f.t}: diferencia media ${d.mean.toFixed(4)}/255 (máx ${d.max ?? d.size})`);
  }
  ok(!w.logs.length, `${label}: sin errores en consola${w.logs.length ? ': ' + w.logs.join(' | ') : ''}`);
  await w.ctx.close();
  return worst;
}

// carpeta por http
const st = await serveStatic(outDir);
await compare('carpeta http', st.url);
await st.close();
// single por http y por file://
const st2 = await serveStatic(path.dirname(outSingle));
await compare('single http', st2.url + path.basename(outSingle));
await st2.close();
await compare('single file://', 'file://' + outSingle);

// carpeta por file://: hay VFX GPU → aviso claro en vez de un cuadro roto
{
  const w = await openWeb('file://' + path.join(outDir, 'index.html'));
  const msg = w.err ? '' : await w.page.evaluate(() => document.querySelector('.cw-msg')?.textContent || '');
  ok(!w.err && w.info.blocked && /servidor/.test(msg), `carpeta file://: ${w.err ? 'falló: ' + w.err : w.info.blocked ? 'muestra el aviso (abrir con servidor o --single)' : 'no avisó'}`);
  await w.ctx.close();
}

// controles: letterbox con otra proporción + devicePixelRatio 2, play/pausa/flechas
{
  const st3 = await serveStatic(outCtrl);
  const w = await openWeb(st3.url, { viewport: { width: 1000, height: 800 }, dpr: 2 });
  const box = await w.page.evaluate(() => {
    const r = document.querySelector('.cw-box').getBoundingClientRect();
    return { w: r.width, h: r.height, top: r.top, ctrl: !!document.querySelector('.cw-ctrl'), poster: !!document.querySelector('.cw-poster') };
  });
  ok(Math.abs(box.w - 1000) < 1 && Math.abs(box.h - 562.5) < 1 && Math.abs(box.top - 118.75) < 1, `letterbox 16:9 en 1000×800 (${box.w}×${box.h}, arriba ${box.top})`);
  ok(box.ctrl && box.poster, 'controles y botón de play visibles');
  await w.page.keyboard.press('Space');
  await w.page.waitForTimeout(1000);
  const t1 = await w.page.evaluate(() => ({ t: window.__comicWeb.time, playing: window.__comicWeb.playing }));
  ok(t1.playing && t1.t > 0.6 && t1.t < 1.4, `espacio reproduce en tiempo real (t=${t1.t.toFixed(3)} tras ~1 s)`);
  ok(Math.abs(t1.t * 24 - Math.round(t1.t * 24)) < 1e-6, 'tiempo cuantizado a meta.fps');
  await w.page.keyboard.press('Space');
  const t2 = await w.page.evaluate(() => window.__comicWeb.time);
  await w.page.keyboard.press('ArrowRight');
  await w.page.waitForTimeout(300);
  const t3 = await w.page.evaluate(() => ({ t: window.__comicWeb.time, playing: window.__comicWeb.playing }));
  ok(!t3.playing && Math.abs(t3.t - (t2 + 1 / 24)) < 1e-6, `pausa y → avanza un cuadro (${t2.toFixed(3)} → ${t3.t.toFixed(3)})`);
  const canvasW = await w.page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.cw-stage canvas')].map((c) => c.width)));
  ok(canvasW === Math.round(1000 * 2), `canvas GPU a la resolución del dispositivo (${canvasW} px de ancho, ventana 1000 × dpr 2)`);
  await w.ctx.close();
  await st3.close();
}

// --single con más de 50 MB: error claro (archivo disperso: truncate no ocupa disco)
{
  fs.truncateSync(path.join(dir, 'assets/img.png'), 51 * 1024 * 1024);
  const rr = cli('html', dir, '--out', path.join(dir, 'exports', 'grande.html'), '--single');
  ok(rr.status !== 0 && /50 MB/.test(rr.stderr), `--single > 50 MB: ${rr.stderr.trim().split('\n')[0]}`);
}

await browser.close();
if (keep) console.log('  archivos en ' + dir);
else fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n✗ ${fails} fallas` : '\n✓ export HTML ok');
process.exit(fails ? 1 : 0);
