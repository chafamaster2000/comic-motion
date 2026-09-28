// Export determinístico: Playwright congela el player en cada cuadro y ffmpeg arma el video.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const CODECS = {
  h264: { ext: 'mp4', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'] },
  prores: { ext: 'mov', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'] },
};

async function openPage(serverUrl, meta, scale) {
  // Chromium completo con GPU (Metal / D3D11): los filtros SVG corren ~8× más rápido que en el headless-shell por CPU
  const args = ['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb', '--hide-scrollbars'];
  let browser;
  try {
    const angle = { darwin: 'metal', win32: 'd3d11' }[process.platform];
    browser = await chromium.launch({ channel: 'chromium', args: [...args, '--enable-gpu', '--ignore-gpu-blocklist', ...(angle ? [`--use-angle=${angle}`] : [])] });
  } catch {
    browser = await chromium.launch({ args });
  }
  const page = await browser.newPage({ viewport: { width: Math.round(meta.width * scale), height: Math.round(meta.height * scale) }, deviceScaleFactor: 1 });
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
  return { browser, page, info, logs, shot };
}

// quality: '1080' | '4k'  → escala del devicePixelRatio relativo a meta.width
export async function renderVideo({ serverUrl, meta, outFile, quality = '1080', codec = 'h264', fps: fpsOverride, from = 0, to, onProgress, shouldStop }) {
  const scale = quality === '4k' ? 3840 / meta.width : 1920 / meta.width;
  const { browser, page, info, logs, shot } = await openPage(serverUrl, meta, scale);
  const fps = fpsOverride || meta.fps || 24;
  const end = Math.min(to ?? info.duration, info.duration);
  const frames = Math.max(1, Math.round((end - from) * fps));
  const c = CODECS[codec] || CODECS.h264;
  if (!outFile.endsWith('.' + c.ext)) outFile = outFile.replace(/\.[a-z0-9]+$/i, '') + '.' + c.ext;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-', ...c.args, '-r', String(fps), outFile], { stdio: ['pipe', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', (d) => (ffErr += d));
  const ffDone = new Promise((res) => ff.on('exit', res));
  let written = 0;
  const t0 = Date.now();
  try {
    for (let i = 0; i < frames; i++) {
      if (shouldStop?.()) throw new Error('cancelado');
      const t = from + i / fps;
      await page.evaluate((tt) => window.__comic.seek(tt), t);
      const buf = await shot();
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      written++;
      const elapsed = (Date.now() - t0) / 1000;
      onProgress?.({ frame: i + 1, frames, elapsed, eta: (elapsed / (i + 1)) * (frames - i - 1) });
    }
  } catch (e) {
    ff.stdin.destroy();
    ff.kill('SIGKILL');
    await browser.close();
    throw e;
  }
  ff.stdin.end();
  const code = await ffDone;
  await browser.close();
  if (code !== 0) throw new Error('ffmpeg falló: ' + ffErr);
  const seconds = (Date.now() - t0) / 1000;
  // el archivo tiene que tener exactamente los cuadros pedidos: ni salteados ni duplicados
  if (written !== frames) throw new Error(`se capturaron ${written} cuadros de ${frames}`);
  const counted = await countFrames(outFile);
  if (counted !== frames) throw new Error(`el video tiene ${counted} cuadros y se esperaban ${frames} (${outFile})`);
  const pageErrors = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
  return { outFile, frames, seconds, gpuBackend: info.gpuBackend, warnings: [...info.errors, ...info.gpuWarnings, ...pageErrors] };
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
