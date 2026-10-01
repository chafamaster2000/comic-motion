import { build } from 'esbuild';

const common = { bundle: true, format: 'esm', target: 'chrome120', logLevel: 'info', loader: { '.jsx': 'jsx' }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } };

await Promise.all([
  build({ ...common, entryPoints: { panel: 'src/panel/main.jsx' }, outdir: 'dist', minify: true, external: ['/fonts/*'] }),
  build({ ...common, entryPoints: { render: 'src/render-entry.js' }, outdir: 'dist', minify: false }),
  // player web del export HTML (comic html): script clásico (IIFE), no módulo ES, para que también ande desde file://
  build({ ...common, format: 'iife', entryPoints: { web: 'src/web-entry.js' }, outdir: 'dist', minify: true, legalComments: 'none' }),
]);
