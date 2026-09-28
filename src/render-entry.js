// Página headless del exportador y de los snapshots.
import { createPlayer, loadCustomEffects } from './player/player.js';

async function main() {
  const q = new URLSearchParams(location.search);
  const [{ scene }, presets] = await Promise.all([fetch('/api/scene').then((r) => r.json()), fetch('/api/presets').then((r) => r.json())]);
  const customDefs = await loadCustomEffects(presets.custom.map((c) => c.url));
  const root = document.getElementById('root');
  // zoom (no transform): Chrome rasteriza a la resolución final, nítido en 4K
  const scale = parseFloat(q.get('scale') || '1');
  if (scale !== 1) root.style.zoom = String(scale);
  const player = createPlayer(root, { scene, baseUrl: '/p/', fontBase: '/fonts/', customDefs });
  await document.fonts.load("700 40px 'Comic Neue'");
  await document.fonts.load("40px 'Bangers'");
  window.__comic = {
    duration: player.duration(),
    fps: scene.meta.fps || 24,
    errors: player.errors,
    seek: (t) => player.seek(t),
  };
  if (q.has('t')) await player.seek(parseFloat(q.get('t')));
  window.__comicReady = true;
}

main().catch((e) => {
  window.__comicError = String(e?.stack || e);
  console.error(e);
});
