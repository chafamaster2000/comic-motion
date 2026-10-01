// Export determinístico: Playwright congela el player en cada cuadro y ffmpeg arma el video.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { layoutScenes } from './shared/scene.js';

const CODECS = {
  // final: solo en el archivo final (en el export en paralelo, al unir los tramos)
  h264: { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p'], final: ['-movflags', '+faststart'] },
  prores: { ext: 'mov', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'], final: [] },
};

const RAFS = Number.isFinite(+process.env.COMIC_RENDER_RAFS) && process.env.COMIC_RENDER_RAFS !== '' ? +process.env.COMIC_RENDER_RAFS : 1;

async function launchBrowser() {
  // Chromium completo con GPU (Metal / D3D11): los filtros SVG corren ~8× más rápido que en el headless-shell por CPU
  const args = ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', '--hide-scrollbars'];
  try {
    const angle = { darwin: 'metal', win32: 'd3d11' }[process.platform];
    return await chromium.launch({ channel: 'chromium', args: [...args, '--enable-gpu', '--ignore-gpu-blocklist', ...(angle ? [`--use-angle=${angle}`] : [])] });
  } catch {
    return await chromium.launch({ args });
  }
}

// shared: navegador ya abierto (la página va en un contexto propio y close() cierra solo ese contexto)
async function openPage(serverUrl, meta, scale, shared) {
  const browser = shared || (await launchBrowser());
  const context = await browser.newContext({ viewport: { width: Math.round(meta.width * scale), height: Math.round(meta.height * scale) }, deviceScaleFactor: 1 });
  const close = () => (shared ? context.close() : browser.close()).catch(() => {});
  try {
    return await preparePage(context, serverUrl, scale, browser, close);
  } catch (e) {
    await close();
    throw e;
  }
}

async function preparePage(context, serverUrl, scale, browser, close) {
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  // COMIC_FORCE_WEBGL=1 fuerza el backend WebGL2 de three (para probar la caída sin WebGPU)
  await page.goto(serverUrl + '/render.html?scale=' + scale + (process.env.COMIC_FORCE_WEBGL === '1' ? '&webgl=1' : ''), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__comicReady || window.__comicError, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.__comicError);
  if (err) throw new Error('el player falló: ' + err + '\n' + logs.join('\n'));
  const info = await page.evaluate(() => ({ duration: window.__comic.duration, fps: window.__comic.fps, errors: window.__comic.errors, gpuBackend: window.__comic.gpuBackend, gpuPanels: window.__comic.gpuPanels }));
  info.gpuWarnings = [];
  if (info.gpuPanels > 0 && info.gpuBackend === 'webgl2') info.gpuWarnings.push('VFX con WebGL2 (sin WebGPU)');
  if (info.gpuPanels > 0 && !info.gpuBackend) info.gpuWarnings.push('VFX sin GPU: las viñetas con VFX se dibujan con DOM y sin efectos');
  const cdp = await page.context().newCDPSession(page);
  // captura PNG sin pérdida con compresión rápida (3× más rápida que page.screenshot)
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true })).data, 'base64');
  return { browser, close, page, info, logs, shot };
}

// Cuántos navegadores en paralelo. 'auto' toma el mínimo entre:
//  - CPU: la mitad de los núcleos, hasta 4 (medido en una M4: más de 4 no rinde porque la captura PNG y x264 compiten);
//  - RAM: un tramo (Chromium con GPU + su ffmpeg) ocupa ~1.25 GB a 1080 y ~1.5 GB a 4K (RSS medido con 4 en paralelo
//    sobre una página de capas); se presupuesta con margen 1.5 GB y 2.5 GB (AUTO_GB) contra lo disponible, que es
//    max(os.freemem(), la mitad de os.totalmem()): en macOS freemem no cuenta la caché que se libera sola, así que
//    solo no alcanza. 24 GB → 4 a 1080 y a 4K; 16 GB → 4 y 3; 8 GB → 2 y 1.
//  - uno cada 30 cuadros como mucho (abrir un navegador cuesta ~2 s).
// Siempre al menos 1. Un número explícito se respeta (hasta 8).
const AUTO_GB = { '1080': 1.5, '4k': 2.5 };
export function autoWorkers(frames = Infinity, quality = '1080', mem = { total: os.totalmem(), free: os.freemem() }, cpus = os.cpus().length) {
  const GB = 2 ** 30;
  const per = AUTO_GB[quality] || AUTO_GB['1080'];
  const availGB = Math.max(mem.free, mem.total / 2) / GB;
  const byCpu = Math.min(4, Math.max(1, Math.floor(cpus / 2)));
  const byMem = Math.max(1, Math.floor(availGB / per));
  const byFrames = Math.max(1, Math.ceil(frames / 30));
  const n = Math.max(1, Math.min(byCpu, byMem, byFrames));
  const limit = n === byMem && byMem < byCpu ? 'memoria' : n === byFrames && byFrames < byCpu ? 'cuadros' : 'núcleos';
  return { n, limit, byCpu, byMem, availGB: Math.round(availGB * 10) / 10, perWorkerGB: per };
}
export function resolveWorkers(workers, frames, quality = '1080') {
  const auto = workers === undefined || workers === null || workers === 'auto' || workers === 0;
  let n = auto ? autoWorkers(frames, quality).n : Math.floor(+workers);
  if (!Number.isFinite(n) || n < 1) n = 1;
  return Math.max(1, Math.min(n, 8, frames));
}

// Un navegador renderiza los cuadros [i0, i1) y los codifica a file. El tiempo de cada cuadro es from + i/fps,
// igual que en un export en serie: el render es función pura de t, así que da los mismos píxeles.
async function renderRange({ serverUrl, meta, scale, fps, from, i0, i1, file, args, onFrame, shouldStop, onOpen, shared }) {
  const { close, page, info, logs, shot } = await openPage(serverUrl, meta, scale, shared);
  onOpen?.(close);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...args, '-r', String(fps), file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr += d));
  ff.stdin.on('error', () => {}); // si ffmpeg muere, el error sale por el código de salida
  const ffDone = new Promise((res) => ff.on('exit', res));
  // si el navegador muere, Playwright puede quedar esperando para siempre: cortamos nosotros
  let onDead;
  const dead = new Promise((_, rej) => (onDead = (why) => rej(new Error(`el navegador del tramo ${i0}-${i1} ${why}`))));
  dead.catch(() => {});
  page.on('crash', () => onDead('se colgó (crash)'));
  page.on('close', () => onDead('se cerró'));
  page.context().browser()?.on('disconnected', () => onDead('se cerró'));
  ff.on('exit', (c) => c !== 0 && onDead(`perdió su ffmpeg (${c}): ${ffErr}`));
  let timer;
  const guard = (p) => Promise.race([p, dead, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`un cuadro tardó más de 2 min (tramo ${i0}-${i1})`)), 120000)))]).finally(() => clearTimeout(timer));
  let written = 0;
  try {
    for (let i = i0; i < i1; i++) {
      if (shouldStop()) throw new Error('cancelado');
      // 1 rAF (antes 2): la captura ya fuerza un cuadro nuevo; medido bit a bit igual. COMIC_RENDER_RAFS=2 vuelve a lo anterior
      await guard(page.evaluate(([tt, rafs]) => window.__comic.seek(tt, { rafs }), [from + i / fps, RAFS]));
      const buf = await guard(shot());
      if (!ff.stdin.write(buf)) await guard(new Promise((r) => ff.stdin.once('drain', r)));
      written++;
      onFrame();
    }
    ff.stdin.end();
    const code = await ffDone;
    if (code !== 0) throw new Error('ffmpeg falló: ' + ffErr);
  } catch (e) {
    ff.stdin.destroy();
    ff.kill('SIGKILL');
    throw e;
  } finally {
    // close() de un navegador muerto también puede colgarse
    await Promise.race([close(), new Promise((r) => setTimeout(r, 5000))]);
  }
  if (written !== i1 - i0) throw new Error(`se capturaron ${written} cuadros de ${i1 - i0}`);
  return { info, logs };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} falló: ${err}`))));
  });
}

// quality: '1080' | '4k'  → escala del devicePixelRatio relativo a meta.width
// workers: 'auto' | n. Con n > 1 el tramo se parte en n tramos contiguos de cuadros, cada uno en su navegador y su
// ffmpeg (mismo códec y parámetros, cada tramo arranca en keyframe) y se unen con el concat demuxer sin recodificar.
export async function renderVideo({ serverUrl, meta, outFile, quality = '1080', codec = 'h264', fps: fpsOverride, from = 0, to, workers = 'auto', onProgress, shouldStop }) {
  const scale = quality === '4k' ? 3840 / meta.width : 1920 / meta.width;
  const fps = fpsOverride || meta.fps || 24;
  const c = CODECS[codec] || CODECS.h264;
  if (!outFile.endsWith('.' + c.ext)) outFile = outFile.replace(/\.[a-z0-9]+$/i, '') + '.' + c.ext;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const duration = await sceneDuration(serverUrl);
  const end = Math.min(to ?? duration, duration);
  const frames = Math.max(1, Math.round((end - from) * fps));
  const n = resolveWorkers(workers, frames, quality);
  const t0 = Date.now();

  let failed = null;
  const stop = () => !!failed || !!shouldStop?.();
  let done = 0;
  const onFrame = () => {
    done++;
    const elapsed = (Date.now() - t0) / 1000;
    onProgress?.({ frame: done, frames, elapsed, eta: (elapsed / done) * (frames - done), workers: n });
  };
  // tramos contiguos por número de cuadro
  const parts = [];
  for (let k = 0; k < n; k++) parts.push([Math.round((k * frames) / n), Math.round(((k + 1) * frames) / n)]);
  const tmp = n > 1 ? fs.mkdtempSync(path.join(os.tmpdir(), 'comic-render-')) : null;
  const files = parts.map((_, k) => (n > 1 ? path.join(tmp, `part${String(k).padStart(2, '0')}.${c.ext}`) : outFile));
  const closers = new Set();
  // COMIC_RENDER_SHARED=1: un solo navegador con un contexto por tramo (para medir; ver README)
  let shared = null;
  let results;
  try {
    if (n > 1 && process.env.COMIC_RENDER_SHARED === '1') shared = await launchBrowser();
    const settled = await Promise.allSettled(
      parts.map(([i0, i1], k) =>
        renderRange({ serverUrl, meta, scale, fps, from, i0, i1, file: files[k], args: n > 1 ? c.args : [...c.args, ...c.final], onFrame, shouldStop: stop, shared, onOpen: (c) => closers.add(c) }).catch((e) => {
          // el primer error corta a todos los demás
          if (!failed) failed = e;
          throw e;
        }),
      ),
    );
    if (failed || settled.some((r) => r.status === 'rejected')) throw failed || settled.find((r) => r.status === 'rejected').reason;
    results = settled.map((r) => r.value);
    if (n > 1) {
      const list = path.join(tmp, 'list.txt');
      fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...c.final, outFile]);
    }
  } catch (e) {
    if (shouldStop?.() && e.message !== 'cancelado') e = new Error('cancelado');
    // sin archivo a medias (en serie ffmpeg escribe directo en outFile)
    fs.rmSync(outFile, { force: true });
    throw e;
  } finally {
    await Promise.race([Promise.all([...closers].map((c) => c())), new Promise((r) => setTimeout(r, 5000))]);
    if (shared) await shared.close().catch(() => {});
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  const seconds = (Date.now() - t0) / 1000;
  // el archivo tiene que tener exactamente los cuadros pedidos: ni salteados ni duplicados
  if (done !== frames) throw new Error(`se capturaron ${done} cuadros de ${frames}`);
  const counted = await countFrames(outFile);
  if (counted !== frames) throw new Error(`el video tiene ${counted} cuadros y se esperaban ${frames} (${outFile})`);
  const info = results[0].info;
  const pageErrors = results.flatMap((r) => r.logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]')));
  return { outFile, frames, seconds, workers: n, gpuBackend: info.gpuBackend, warnings: [...new Set([...info.errors, ...info.gpuWarnings, ...pageErrors])] };
}

// Duración de la escena sin abrir un navegador: la misma cuenta que el player (layoutScenes).
async function sceneDuration(serverUrl) {
  const { scene } = await (await fetch(serverUrl + '/api/scene')).json();
  const l = layoutScenes(scene);
  return l.length ? Math.max(...l.map((e) => e.end)) : 0;
}

// Cuenta los cuadros reales del archivo con ffprobe (-count_frames).
export function countFrames(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (c) => {
      const n = parseInt(out.trim(), 10);
      if (c !== 0 || !Number.isFinite(n)) reject(new Error('ffprobe falló: ' + err));
      else resolve(n);
    });
  });
}

// Cuadros sueltos para revisar (Claude los mira con Read). times: segundos.
export async function snapshots({ serverUrl, meta, times, outDir, scale = 0.5 }) {
  const { browser, page, info, logs } = await openPage(serverUrl, meta, scale);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const t of times) {
    const tt = Math.min(Math.max(0, t), info.duration);
    await page.evaluate((x) => window.__comic.seek(x), tt);
    const f = path.join(outDir, `t${tt.toFixed(2).replace('.', '_')}.png`);
    await page.screenshot({ path: f });
    files.push({ t: tt, file: f });
  }
  await browser.close();
  return { files, duration: info.duration, gpuBackend: info.gpuBackend, warnings: [...info.errors, ...info.gpuWarnings, ...logs.filter((l) => /pageerror|\[error\]/.test(l))] };
}
