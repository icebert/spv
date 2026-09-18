import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');
const BASE = process.env.VITE_BASE ?? '/';
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * `<short sha>[+] <date>`: the commit the bundle was built from ("+" = uncommitted changes) and
 * its commit date, so the same commit always yields the same stamp; the UTC build date is the
 * fallback when git is unavailable.
 */
function buildStamp(): string {
  const git = (args: string): string => {
    try {
      return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return '';
    }
  };
  const sha = (process.env.GITHUB_SHA || git('rev-parse HEAD')).slice(0, 7) || 'unknown';
  const dirty = !process.env.GITHUB_SHA && git('status --porcelain') !== '' ? '+' : '';
  const date = git('show -s --format=%cs HEAD') || new Date().toISOString().slice(0, 10);
  return `${sha}${dirty} ${date}`;
}

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
    // tests/fixtures/ is served at /fixtures/ in dev and preview only (never copied to dist)
    let dir = DATA_DIR;
    let prefix = '/data/';
    if (url.startsWith('/fixtures/')) {
      dir = FIXTURES_DIR;
      prefix = '/fixtures/';
    } else if (!url.startsWith('/data/')) return next();
    const rel = path.normalize(url.slice(prefix.length));
    if (rel === '' || rel.startsWith('..')) return next();
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
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

/**
 * The Content Security Policy is a <meta> tag in index.html because GitHub Pages cannot send
 * headers. The dev server injects CSS and its error overlay as inline <style> elements, so in
 * `serve` mode styles may be inline; builds and `vite preview` keep the strict policy.
 */
function devCsp(): Plugin {
  return {
    name: 'spv-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("style-src 'self';", "style-src 'self' 'unsafe-inline';");
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [serveDataDir(), devCsp()],
  define: {
    __SPV_VERSION__: JSON.stringify(PKG.version),
    __SPV_BUILD__: JSON.stringify(buildStamp()),
  },
  assetsInclude: ['**/*.so'],
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    // The only chunk over the default 500 kB is the h5wasm worker (JS + embedded WASM, ~4.8 MB,
    // ~1 MB gzipped): loaded lazily, in a worker, and not splittable. scripts/bundle_budget.mjs
    // enforces per-file budgets instead.
    chunkSizeWarningLimit: 5000,
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
