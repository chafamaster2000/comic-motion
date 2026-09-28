import { build } from 'esbuild';

const common = { bundle: true, format: 'esm', target: 'chrome120', logLevel: 'info', loader: { '.jsx': 'jsx' }, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } };

await Promise.all([
  build({ ...common, entryPoints: { panel: 'src/panel/main.jsx' }, outdir: 'dist', minify: true, external: ['/fonts/*'] }),
  build({ ...common, entryPoints: { render: 'src/render-entry.js' }, outdir: 'dist', minify: false }),
]);
