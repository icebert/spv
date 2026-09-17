import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const BASE = process.env.VITE_BASE ?? '/';

const MIME: Record<string, string> = {
  '.h5ad': 'application/octet-stream',
  '.h5': 'application/octet-stream',
  '.json': 'application/json',
};

/**
 * Serve the repo-root `data/` directory at `<base>/data/` in dev and preview (with HTTP Range
 * support, which Vite's static middleware lacks and which the lazy h5wasm loader relies on), and
 * copy `data/*.h5ad` + `data/*.json` into `dist/data/` on build. This avoids duplicating the demo
 * file in git and keeps `.h5ad` files out of the bundler's module graph.
 */
function serveDataDir(): Plugin {
  let outDir = 'dist';
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const rawUrl = (req.url ?? '').split('?')[0];
    let url = decodeURIComponent(rawUrl);
    if (BASE !== '/' && url.startsWith(BASE.replace(/\/$/, ''))) {
      url = url.slice(BASE.replace(/\/$/, '').length);
    }
    if (!url.startsWith('/data/')) return next();
    const rel = path.normalize(url.slice('/data/'.length));
    if (rel === '' || rel.startsWith('..')) return next();
    const file = path.join(DATA_DIR, rel);
    if (!file.startsWith(DATA_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile())
      return next();
    const stat = fs.statSync(file);
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        return;
      }
      if (m[1] === '') {
        start = Math.max(0, stat.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(end, Number(m[2]));
      }
      if (start > end || start >= stat.size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
  };
  return {
    name: 'spv-serve-data-dir',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
    closeBundle() {
      if (!fs.existsSync(DATA_DIR)) return;
      const dest = path.join(ROOT, outDir, 'data');
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(DATA_DIR)) {
        const src = path.join(DATA_DIR, name);
        if (!fs.statSync(src).isFile()) continue; // skips data/synthetic/
        if (!/\.(h5ad|h5|json)$/i.test(name)) continue;
        fs.copyFileSync(src, path.join(dest, name));
      }
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [serveDataDir()],
  assetsInclude: ['**/*.so'],
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['h5wasm', 'h5wasm-plugins'],
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
