// Server local del estudio: panel + player + API sobre scene.json + cola de variantes + export.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openProject, catalog, validate, SKILL_DIR, Conflict } from './project.js';
import { reviewAction } from './shared/scene.js';
import { createQueue } from './generator.js';
import { createGuides } from './guide.js';
import { renderVideo } from './render.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

const PAGE = (title, script, css) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${css ? `<link rel="stylesheet" href="${css}">` : ''}
<style>html,body{margin:0;padding:0;background:#000}</style></head>
<body><div id="root"></div><script type="module" src="${script}"></script></body></html>`;

export function startServer({ projectDir, port = 0, host = '127.0.0.1', withQueue = true, log = console.log }) {
  const project = openProject(projectDir);
  const dist = path.join(SKILL_DIR, 'dist');
  const clients = new Set();
  let lastRev = project.rev();
  let render = { status: 'idle' };
  let stopRender = false;

  const send = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };

  const queue = withQueue ? createQueue(project, { onChange: (list) => send('queue', list) }) : null;
  const guides = withQueue ? createGuides(project, { queue, onChange: (g) => send('guide', g) }) : null;

  // cambios externos (Claude editando scene.json, el generador, otro tab)
  let watchTimer;
  const watcher = fs.watch(project.dir, (ev, file) => {
    if (file !== 'scene.json' && !String(file).startsWith('effects')) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      try {
        const rev = project.rev();
        if (rev !== lastRev) {
          lastRev = rev;
          send('scene', { rev });
          queue?.pump(); // pudo cambiar meta.generatorConcurrency
        }
        if (String(file).startsWith('effects')) send('presets', catalog(project));
      } catch {}
    }, 120);
  });

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => {
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  function serveFile(req, res, file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('no encontrado');
    }
    const stat = fs.statSync(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (!m[1] && m[2]) {
        start = stat.size - parseInt(m[2], 10);
        end = stat.size - 1;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const safeJoin = (root, rel) => {
    const f = path.resolve(root, decodeURIComponent(rel));
    return f.startsWith(path.resolve(root)) ? f : null;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        return res.end(PAGE('Comic Studio · ' + (project.read().scene.meta.title || ''), '/panel.js', '/panel.css'));
      }
      if (p === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      if (p === '/render.html') {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        return res.end(PAGE('render', '/render.js'));
      }
      if (p === '/panel.js' || p === '/panel.css' || p === '/render.js') return serveFile(req, res, path.join(dist, p.slice(1)));
      if (p.startsWith('/fonts/')) return serveFile(req, res, safeJoin(path.join(SKILL_DIR, 'fonts'), p.slice(7)));
      if (p.startsWith('/p/')) {
        const f = safeJoin(project.dir, p.slice(3));
        if (!f) return json(res, 403, { error: 'fuera del proyecto' });
        return serveFile(req, res, f);
      }

      // ---------- API ----------
      if (p === '/api/scene' && req.method === 'GET') {
        const { scene, rev } = project.read();
        lastRev = rev;
        return json(res, 200, { scene, rev });
      }
      if (p === '/api/scene' && req.method === 'PUT') {
        const body = await readBody(req);
        try {
          const rev = project.write(body.scene, body.baseRev);
          lastRev = rev;
          project.history(body.events);
          send('scene', { rev, by: body.clientId });
          return json(res, 200, { rev });
        } catch (e) {
          if (e instanceof Conflict) return json(res, 409, { error: e.message, ...project.read() });
          throw e;
        }
      }
      if (p === '/api/review' && req.method === 'POST') {
        // { target:{scene,clip?,sceneVariant?,variant}, action, note, baseRev }
        const body = await readBody(req);
        const { scene, rev } = project.read();
        if (body.baseRev && body.baseRev !== rev) return json(res, 409, { error: 'desactualizado', scene, rev });
        const ev = reviewAction(scene, body.target, body.action, body.note);
        const newRev = project.write(scene, rev);
        lastRev = newRev;
        project.history([ev]);
        send('scene', { rev: newRev, by: body.clientId });
        return json(res, 200, { scene, rev: newRev });
      }
      if (p === '/api/presets') return json(res, 200, catalog(project));
      if (p === '/api/validate') return json(res, 200, validate(project.read().scene, project));
      if (p === '/api/history') {
        const f = path.join(project.dir, 'history.jsonl');
        const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-300).map((l) => JSON.parse(l)) : [];
        return json(res, 200, lines);
      }
      if (p === '/api/requests' && req.method === 'GET') return json(res, 200, queue ? queue.list() : []);
      if (p === '/api/requests' && req.method === 'POST') {
        if (!queue) return json(res, 400, { error: 'cola deshabilitada' });
        const body = await readBody(req);
        return json(res, 200, queue.add(body));
      }
      if (p.startsWith('/api/requests/') && p.endsWith('/cancel') && req.method === 'POST') {
        queue?.cancel(p.split('/')[3]);
        return json(res, 200, { ok: true });
      }
      // ---------- modo guiado ----------
      if (p === '/api/guide' && req.method === 'GET') return json(res, 200, guides ? guides.open() : []);
      if (p === '/api/guide' && req.method === 'POST') {
        if (!guides) return json(res, 400, { error: 'modo guiado deshabilitado' });
        const body = await readBody(req);
        return json(res, 200, guides.create({ target: body.target, instruction: body.instruction }));
      }
      if (p.startsWith('/api/guide/')) {
        if (!guides) return json(res, 400, { error: 'modo guiado deshabilitado' });
        const [, , , id, action] = p.split('/');
        try {
          if (!action && req.method === 'GET') {
            const g = guides.get(id);
            return g ? json(res, 200, g) : json(res, 404, { error: 'sesión no encontrada' });
          }
          if (req.method !== 'POST') return json(res, 405, { error: 'método no permitido' });
          const body = await readBody(req);
          if (action === 'answer') return json(res, 200, guides.answer(id, body.answer));
          if (action === 'finish') return json(res, 200, guides.finish(id));
          if (action === 'retry') return json(res, 200, guides.retry(id));
          if (action === 'cancel') return json(res, 200, guides.cancel(id));
          if (action === 'apply') {
            const r = guides.apply(id, { count: body.count, kind: body.kind });
            if (r.rev) {
              lastRev = r.rev;
              send('scene', { rev: r.rev });
            }
            return json(res, 200, r);
          }
          return json(res, 404, { error: 'acción desconocida ' + action });
        } catch (e) {
          if (e.httpStatus) return json(res, e.httpStatus, { error: e.message });
          if (e instanceof Conflict) return json(res, 409, { error: e.message });
          throw e;
        }
      }
      if (p === '/api/render' && req.method === 'GET') return json(res, 200, render);
      if (p === '/api/render/cancel' && req.method === 'POST') {
        stopRender = true;
        return json(res, 200, { ok: true });
      }
      if (p === '/api/render' && req.method === 'POST') {
        if (render.status === 'running') return json(res, 409, { error: 'ya hay un export corriendo' });
        const body = await readBody(req);
        const { scene } = project.read();
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
        const name = `${(scene.meta.title || 'comic').replace(/[^\w-]+/g, '_')}_${body.quality || '1080'}_${stamp}.mp4`;
        const outFile = path.join(project.dir, 'exports', name);
        render = { status: 'running', quality: body.quality || '1080', codec: body.codec || 'h264', frame: 0, frames: 0, workers: body.workers || 'auto' };
        stopRender = false;
        send('render', render);
        renderVideo({
          serverUrl: `http://127.0.0.1:${server.address().port}`,
          meta: scene.meta,
          outFile,
          quality: body.quality,
          codec: body.codec,
          from: body.from,
          to: body.to,
          // 'auto' | 1..8 navegadores en paralelo (render.js)
          workers: body.workers && body.workers !== 'auto' ? +body.workers : 'auto',
          shouldStop: () => stopRender,
          onProgress: (pr) => {
            render = { ...render, ...pr };
            if (pr.frame % 4 === 0 || pr.frame === pr.frames) send('render', render);
          },
        })
          .then((r) => {
            render = { status: 'done', ...r, url: '/p/exports/' + path.basename(r.outFile) };
            project.history([{ ts: new Date().toISOString(), action: 'export', file: path.relative(project.dir, r.outFile), quality: body.quality, codec: body.codec }]);
            send('render', render);
          })
          .catch((e) => {
            render = { status: e.message === 'cancelado' ? 'cancelled' : 'error', error: e.message };
            send('render', render);
          });
        return json(res, 200, render);
      }
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ rev: lastRev })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      json(res, 404, { error: 'ruta desconocida ' + p });
    } catch (e) {
      if (e.httpStatus) return json(res, e.httpStatus, { error: e.message });
      log('[comic] error', e);
      json(res, 500, { error: String(e.message || e) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      const lan = host === '127.0.0.1' ? [] : Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${server.address().port}`);
      resolve({
        url,
        lan,
        project,
        close: () =>
          new Promise((r) => {
            watcher.close();
            for (const c of clients) c.end();
            server.close(() => r());
          }),
      });
    });
  });
}
