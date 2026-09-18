// Fails when the production bundle grows past its budget. Run after `vite build`:
//   node scripts/bundle_budget.mjs [dist]
// Sizes are raw bytes on disk (what `ls dist/assets` shows), so the numbers do not depend on
// the compressor a host happens to use. Adjust a budget deliberately, in the same commit as the
// change that needs it.
import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2] ?? 'dist';
const assets = path.join(dist, 'assets');
if (!fs.existsSync(assets)) {
  console.error(`No ${assets}/ directory; run "npm run build" first.`);
  process.exit(2);
}
const files = fs.readdirSync(assets);
const total = (re) =>
  files.filter((f) => re.test(f)).reduce((n, f) => n + fs.statSync(path.join(assets, f)).size, 0);

const budgets = [
  ['main script', /^index-.*\.js$/, 900_000],
  ['stylesheet', /^index-.*\.css$/, 40_000],
  ['h5wasm worker (JS + embedded WASM)', /^worker-.*\.js$/, 5_500_000],
  ['fonts', /\.woff2$/, 80_000],
  ['compression plugins', /\.so$/, 5_000_000],
  ['all assets (data/ excluded)', /./, 12_000_000],
];

let over = false;
for (const [name, re, limit] of budgets) {
  const n = total(re);
  const ok = n <= limit;
  over ||= !ok;
  console.log(
    `${ok ? 'ok  ' : 'OVER'} ${name}: ${(n / 1000).toFixed(0)} kB (budget ${(limit / 1000).toFixed(0)} kB)`,
  );
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html is missing');
  over = true;
}
if (over) {
  console.error('Bundle budget exceeded.');
  process.exit(1);
}
