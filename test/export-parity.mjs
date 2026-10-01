#!/usr/bin/env node
// Test del export en paralelo: el mismo tramo con workers=1 y workers=3 tiene que dar los MISMOS cuadros.
//   node test/export-parity.mjs [--keep]
// 1) ProRes (intra, cada cuadro se codifica solo): los cuadros decodificados tienen que ser idénticos bit a bit
//    (framemd5) entre 1 y 3 navegadores. Eso prueba que no hay saltos, duplicados ni diferencias de render.
// 2) H.264 con 3 tramos: cuenta exacta (ffprobe), timestamps parejos, cada tramo arranca en keyframe y cada cuadro
//    se parece a su par de ProRes (PSNR >= 38 dB) más que al cuadro vecino donde la imagen se mueve. Bit a bit no
//    puede dar: cada tramo es un GOP nuevo, así que x264 elige otros tipos de cuadro en las uniones.
// Escena: imagen con ken burns + cámara + VFX de nieve (GPU) + líneas de velocidad, y un video con transición wipe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { startServer } from '../src/server.js';
import { renderVideo, autoWorkers, resolveWorkers } from '../src/render.js';

const keep = process.argv.includes('--keep');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-export-parity-'));
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });

const W = 1600;
const H = 1000;
let shapes = '';
for (let i = 0; i < 30; i++) shapes += `<line x1="${20 + i * 50}" y1="20" x2="${80 + i * 50}" y2="${H - 20}" stroke="#${i % 2 ? '123' : 'c21'}" stroke-width="${1 + (i % 3)}"/>`;
for (let i = 0; i < 8; i++) shapes += `<text x="100" y="${120 + i * 100}" font-family="Helvetica, Arial" font-size="${24 + i * 6}" fill="#111">PARIDAD ${i} ¡PAF!</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#fbeec2"/><stop offset="1" stop-color="#7fb5e8"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(path.join(dir, 'assets/img.png'));
const mk = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', path.join(dir, 'assets/clip.mp4')]);
if (mk.status !== 0) throw new Error('ffmpeg no pudo generar el video de prueba: ' + mk.stderr);

const clip = (id, track, preset, start, duration, params) => ({ id, track, active: 'v1', variants: [{ id: 'v1', status: 'draft', preset, start, duration, params }] });
const scene = {
  meta: { title: 'export parity', width: 1920, height: 1080, fps: 30, background: '#101010' },
  assets: {
    img: { file: 'assets/img.png', type: 'image', w: W, h: H },
    clip: { file: 'assets/clip.mp4', type: 'video', w: 1280, h: 720, duration: 4 },
  },
  scenes: [
    {
      id: 's1',
      active: 'v1',
      variants: [
        {
          id: 'v1',
          status: 'draft',
          duration: 2,
          clips: [
            clip('p1', 'panel', 'panel', 0, 2, { asset: 'img', rect: [100, 60, 1720, 960], kenBurns: { from: { zoom: 1, fx: 0.4, fy: 0.45 }, to: { zoom: 1.3, fx: 0.6, fy: 0.55 } } }),
            clip('cam', 'camera', 'camera', 0, 2, { keys: [{ at: 0, cx: 960, cy: 540, w: 1920 }, { at: 2, cx: 1100, cy: 600, w: 1300 }] }),
            clip('nieve', 'vfx', 'snow', 0, 2, { target: 'p1' }),
            clip('vel', 'fx', 'speedLines', 0.5, 1.5, {}),
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
          clips: [clip('p2', 'panel', 'panel', 0, 2, { asset: 'clip', rect: [0, 0, 1920, 1080], border: 0 }), clip('flash', 'fx', 'flash', 0.6, 0.3, {})],
        },
      ],
    },
  ],
};
fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(scene, null, 1));

const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
  return r.stdout;
};
const md5s = (f) =>
  ff(['-i', f, '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop().trim());
const probe = (f, entries) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', f], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.trim().split('\n');

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

const srv = await startServer({ projectDir: dir, withQueue: false, log: () => {} });
const from = 1.2;
const to = 3.0; // 54 cuadros: cruza la transición wipe (2.0-2.5) y entra al video
const fps = 30;
const frames = Math.round((to - from) * fps);
try {
  const r = {};
  for (const [codec, w] of [['prores', 1], ['prores', 3], ['h264', 3]]) {
    const out = path.join(dir, `out_${codec}_w${w}.${codec === 'prores' ? 'mov' : 'mp4'}`);
    r[codec + w] = await renderVideo({ serverUrl: srv.url, meta: scene.meta, outFile: out, codec, from, to, workers: w });
    console.log(`  ${codec} workers=${r[codec + w].workers}: ${r[codec + w].frames} cuadros en ${r[codec + w].seconds.toFixed(1)}s${r[codec + w].warnings.length ? ' ⚠ ' + r[codec + w].warnings.join(' · ') : ''}`);
  }
  check(r.prores3.workers === 3 && r.h2643.workers === 3, 'se usaron 3 navegadores');
  check(r.prores1.frames === frames && r.prores3.frames === frames, `ffprobe: ${frames} cuadros en ambos ProRes`);

  const a = md5s(r.prores1.outFile);
  const b = md5s(r.prores3.outFile);
  const bad = a.map((m, i) => (m === b[i] ? -1 : i)).filter((i) => i >= 0);
  check(a.length === frames && b.length === frames && bad.length === 0, `ProRes workers=1 vs 3: ${frames - bad.length}/${frames} cuadros idénticos bit a bit${bad.length ? ' (difieren: ' + bad.slice(0, 8).join(',') + ')' : ''}`);
  // en el tramo de imagen (ken burns + nieve, hasta t=2) todo cuadro cambia: ahí no puede haber repetidos
  const img = Math.round((2 - from) * fps);
  const dups = a.slice(0, img).filter((m, i) => i > 0 && m === a[i - 1]).length;
  check(dups === 0, `ningún cuadro repetido en el tramo animado sin video (${img} cuadros)`);

  // H.264 en 3 tramos
  const h = r.h2643.outFile;
  const pk = probe(h, 'frame=key_frame,pts_time').map((l) => l.split(',').map(Number));
  check(pk.length === frames, `H.264 3 tramos: ${pk.length} cuadros decodificados (esperados ${frames})`);
  const deltas = pk.slice(1).map((p, i) => p[1] - pk[i][1]);
  check(deltas.every((d) => Math.abs(d - 1 / fps) < 1e-3), 'H.264: timestamps parejos (1/fps entre cuadros)');
  const bounds = [0, Math.round(frames / 3), Math.round((2 * frames) / 3)];
  check(bounds.every((i) => pk[i]?.[0] === 1), `H.264: keyframe al inicio de cada tramo (${bounds.join(', ')})`);
  const psnrOut = ff(['-i', h, '-i', r.prores1.outFile, '-lavfi', '[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]psnr=stats_file=-', '-f', 'null', '-']);
  const psnr = psnrOut
    .split('\n')
    .filter((l) => l.includes('psnr_avg'))
    .map((l) => parseFloat(l.match(/psnr_avg:([\d.inf]+)/)[1]));
  check(psnr.length === frames && Math.min(...psnr) >= 38, `H.264 vs ProRes cuadro a cuadro: PSNR mínimo ${Math.min(...psnr).toFixed(1)} dB (>= 38)`);
  // en las uniones: el cuadro i del H.264 se parece más a su par que al vecino (ni corrido ni repetido)
  const shifted = ff(['-i', h, '-i', r.prores1.outFile, '-lavfi', '[1:v]trim=start_frame=1,setpts=PTS-STARTPTS,format=yuv444p[b];[0:v]format=yuv444p[a];[a][b]psnr=stats_file=-', '-f', 'null', '-'])
    .split('\n')
    .filter((l) => l.includes('psnr_avg'))
    .map((l) => parseFloat(l.match(/psnr_avg:([\d.inf]+)/)[1]));
  const joins = bounds.slice(1).flatMap((i) => [i - 1, i]);
  check(joins.every((i) => psnr[i] > (shifted[i] ?? 0) + 3), `uniones ${joins.join(',')}: cada cuadro coincide con su par y no con el siguiente (${joins.map((i) => `${psnr[i].toFixed(1)} vs ${shifted[i]?.toFixed(1)}`).join('; ')})`);
} finally {
  await srv.close();
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  else console.log('archivos en ' + dir);
}
// workers 'auto': CPU, memoria (más justa a 4K) y largo del tramo; nunca menos de 1
{
  const GB = 2 ** 30;
  const m = (total, free) => ({ total: total * GB, free: free * GB });
  const cases = [
    [autoWorkers(1000, '1080', m(24, 4), 10).n, 4, '24 GB 1080'],
    [autoWorkers(1000, '4k', m(24, 4), 10).n, 4, '24 GB 4K'],
    [autoWorkers(1000, '1080', m(16, 2), 10).n, 4, '16 GB 1080'],
    [autoWorkers(1000, '4k', m(16, 2), 10).n, 3, '16 GB 4K'],
    [autoWorkers(1000, '1080', m(8, 1), 10).n, 2, '8 GB 1080'],
    [autoWorkers(1000, '4k', m(8, 1), 10).n, 1, '8 GB 4K'],
    [autoWorkers(1000, '4k', m(2, 0.2), 10).n, 1, '2 GB 4K (mínimo 1)'],
    [autoWorkers(1000, '1080', m(64, 40), 4).n, 2, '4 núcleos'],
    [autoWorkers(45, '1080', m(64, 40), 10).n, 2, '45 cuadros'],
    [resolveWorkers(3, 2), 2, 'explícito acotado a los cuadros'],
  ];
  const badW = cases.filter(([got, want]) => got !== want);
  check(!badW.length, `workers auto: ${cases.length - badW.length}/${cases.length} casos${badW.length ? ' (fallan: ' + badW.map(([g, w, n]) => `${n}: ${g}≠${w}`).join('; ') + ')' : ''}`);
}

console.log(failures ? `✗ ${failures} chequeo(s) fallaron` : '✓ export en paralelo exacto');
process.exit(failures ? 1 : 0);
