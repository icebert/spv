import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './spv.d';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/demo.meta.json'), 'utf8'));
const BASE = process.env.VITE_BASE ?? '/spv/';
const fixtureUrl = (name: string) => `#url=${encodeURIComponent(`${BASE}fixtures/${name}`)}`;

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__spv && (window.__spv.ready || window.__spv.error),
    null,
    { timeout: 150_000 },
  );
  expect(await page.evaluate(() => window.__spv.error)).toBeNull();
}

const info = (page: Page) => page.evaluate(() => window.__spv.info());

/** Fraction of canvas pixels that are drawn (alpha > 0 in a transparent-background screenshot). */
async function drawnFraction(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const blob: Blob = await window.__spv.app.viewer.screenshot({ scale: 1, transparent: true });
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n / (d.length / 4);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test.describe('demo dataset', () => {
  test('loads via #dataset=demo and matches data/demo.meta.json', async ({ page }) => {
    await page.goto('#dataset=demo');
    await waitReady(page);
    const i = await info(page);
    expect(i.n).toBe(meta.n_obs);
    expect(i.summary.nVars).toBe(meta.n_vars);
    expect(i.summary.library).toBe(meta.library.key);
    expect(i.summary.spatial).toBe(meta.spatial.key);
    expect(i.sections).toEqual(meta.sections.sections.map((s: { name: string }) => s.name));
    expect(i.images.total).toBe(
      meta.sections.sections.filter((s: { has_image: boolean }) => s.has_image).length,
    );
    expect(i.legend.key).toBe(meta.suggested.default_color_by.key);
    expect(i.legend.n).toBe(
      meta.obs.columns.find((c: { name: string }) => c.name === meta.suggested.default_color_by.key)
        .n_categories,
    );
    expect(await drawnFraction(page)).toBeGreaterThan(0.01);
    await expect(page.locator('.spv-topbar')).toContainText('SPV');
    await expect(page).toHaveTitle('SPV — Spatial Viewer');
    await shot(page, 'stack');
  });

  test('colours by a gene, by a category, and toggles legend entries', async ({ page }) => {
    await page.goto('#dataset=demo');
    await waitReady(page);
    const gene = meta.suggested.gene_examples[0];
    await page.getByRole('tab', { name: 'Color' }).click();
    await page.fill('input[placeholder^="Search"]', gene.name);
    await page.waitForSelector('.spv-panel.spv-active .spv-autocomplete-item');
    await page.keyboard.press('Enter');
    await page.waitForFunction((g) => window.__spv.info().colorbar?.label === g, gene.name, {
      timeout: 60_000,
    });
    const cb = (await info(page)).colorbar;
    expect(cb.vmax).toBeGreaterThan(cb.vmin);
    expect(cb.vmax).toBeLessThanOrEqual(gene.max + 1e-6);
    await expect(page.locator('.spv-colorbar-float')).toContainText(gene.name);
    await shot(page, 'gene');
    // back to a categorical column through the UI select
    const col = meta.suggested.default_color_by.key;
    await page.locator('.spv-panel.spv-active select.spv-input').first().selectOption(`obs:${col}`);
    await page.waitForFunction((c) => window.__spv.info().legend?.key === c, col);
    const before = (await info(page)).legend;
    expect(before.hidden).toEqual([]);
    await page.locator('.spv-legend-row').first().click();
    await page.waitForFunction(() => window.__spv.info().legend.hidden.length === 1);
    expect((await info(page)).legend.hidden).toEqual([0]);
    await page
      .locator('.spv-legend-row')
      .nth(1)
      .click({ modifiers: ['Shift'] });
    await page.waitForFunction((n) => window.__spv.info().legend.hidden.length === n - 1, before.n);
    await page.getByRole('button', { name: 'Show all' }).first().click();
    await page.waitForFunction(() => window.__spv.info().legend.hidden.length === 0);
    await shot(page, 'legend');
  });

  test('steps sections, cycles all layout modes and hides a section', async ({ page }) => {
    await page.goto('#dataset=demo');
    await waitReady(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect((await info(page)).current).toBe(2);
    await expect(page.locator('.spv-section-name')).toContainText(meta.sections.sections[2].name);
    const seen: string[] = [];
    for (let k = 0; k < 4; k++) {
      await page.keyboard.press('l');
      await page.waitForTimeout(150);
      const i = await info(page);
      seen.push(i.layout);
      expect(await drawnFraction(page)).toBeGreaterThan(0.005);
      await shot(page, `layout-${i.layout}`);
    }
    expect(seen).toEqual(['stack-normalized', 'tile', 'single', 'stack']);
    await page.evaluate(() => window.__spv.app.toggleSection(0, false));
    expect((await info(page)).hiddenSections).toEqual([0]);
    await page.getByRole('tab', { name: 'Sections' }).click();
    await expect(page.locator('.spv-panel.spv-active')).toContainText('15 of 16 shown');
    await page.waitForFunction(() => location.hash.includes('hs=0'));
  });

  test('hover tooltip names the section once, with the colour value and extra fields', async ({
    page,
  }) => {
    await page.goto('#dataset=demo&hs=0-11%2C13-15');
    await waitReady(page);
    const canvas = page.locator('.spv-viewport canvas').first();
    const box = (await canvas.boundingBox())!;
    // sweep the mouse across the middle of the view until a cell is under the cursor
    let text = '';
    for (let k = 0; k < 40 && !text; k++) {
      await page.mouse.move(box.x + box.width * (0.3 + 0.01 * k), box.y + box.height * 0.5);
      await page.waitForTimeout(60);
      text = await page
        .locator('.spv-tooltip')
        .evaluate((el) => (el.style.display === 'none' ? '' : (el.textContent ?? '')));
    }
    expect(text).toContain('section');
    expect(text).toContain('slice13');
    expect(text.match(/slice13/g)?.length).toBe(1);
    expect(text).toContain('seurat_clusters');
  });

  test('lazy loading keys every range request by URL and the coordinate buffer is intact', async ({
    page,
  }) => {
    const ranges: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('spv_range=')) ranges.push(r.url());
    });
    // the state from the Safari report: only slice13 shown
    await page.goto('#dataset=demo&hs=0-11%2C13-15&c=obs%3Aseurat_clusters');
    await waitReady(page);
    expect(ranges.length).toBeGreaterThan(0);
    for (const u of ranges) expect(u).toMatch(/[?&]spv_range=\d+-\d+$/);
    expect(new Set(ranges).size).toBe(ranges.length); // one URL per chunk, never re-requested
    await page.evaluate(() => window.__spv.app.viewer.render());
    const report: string = await page.evaluate(() => window.__spv.app.drawnSectionsReport());
    expect(report).toContain('Drawn: slice13');
    expect(report).toContain('Drawn on screen: slice13');
    expect(report).toContain('slice13: 5,412 cells all at z 558');
    expect(report).not.toContain('corrupt');
    expect(report).toContain('loaded lazy');
    // one Points draw + the axes gizmo; every vertex submitted exactly once
    const batches = Math.ceil(meta.n_obs / 65536); // sub-1 MiB vertex buffers (Safari workaround)
    expect(report).toMatch(new RegExp(`Frame: ${batches + 1} draw calls, 103,085 point vertices`));
    // what the canvas shows sits where the CPU projects the visible cells (point radius margin)
    const box = (re: RegExp) => {
      const m = re.exec(report);
      expect(m, `${re} in ${report}`).not.toBeNull();
      return m!.slice(1, 5).map(Number);
    };
    const gpu = box(/Drawn on screen: .*footprint x (\d+)–(\d+), y (\d+)–(\d+)/);
    const cpu = box(/Expected footprint .*: x (\d+)–(\d+), y (\d+)–(\d+)/);
    for (let k = 0; k < 4; k++) expect(Math.abs(gpu[k] - cpu[k])).toBeLessThanOrEqual(12);
    // every drawn cell sits where the CPU projects it, before and after a re-upload
    expect(report).toMatch(/^Displaced cells \(GPU centroid[^:]*: 0 of [\d,]+ drawn/m);
    expect(report).toMatch(
      /^After re-uploading all vertex attributes: displaced cells \(GPU centroid[^:]*: 0 of/m,
    );
    expect(report).toMatch(/drawn although the CPU hides them: 0$/m);
  });

  test('share link restores layout, colour and camera', async ({ page, context }) => {
    await page.goto('#dataset=demo');
    await waitReady(page);
    const gene = meta.suggested.gene_examples[1].name;
    await page.evaluate((g) => {
      window.__spv.app.store.update('layout', { mode: 'tile' });
      window.__spv.app.colorByGene(g);
    }, gene);
    await page.waitForFunction((g) => window.__spv.info().colorbar?.label === g, gene, {
      timeout: 60_000,
    });
    const link: string = await page.evaluate(() => window.__spv.app.shareLink());
    expect(link).toContain('lm=tile');
    expect(link).toContain(encodeURIComponent(`gene:${gene}`));
    const page2 = await context.newPage();
    await page2.goto(link);
    await waitReady(page2);
    await page2.waitForFunction((g) => window.__spv.info().colorbar?.label === g, gene, {
      timeout: 60_000,
    });
    const i = await info(page2);
    expect(i.layout).toBe('tile');
    expect(i.color.key).toBe(gene);
  });

  test('switching datasets three times leaves GPU memory at baseline', async ({ page }) => {
    // Measure only after the default colouring has uploaded its textures and a frame was drawn.
    const settle = async (n: number) => {
      await page.waitForFunction(
        (k) =>
          window.__spv.ready && window.__spv.info().n === k && window.__spv.info().legend !== null,
        n,
        { timeout: 120_000 },
      );
      await page.evaluate(() => window.__spv.app.viewer.render());
      return info(page);
    };
    await page.goto('#dataset=demo');
    await waitReady(page);
    const baseline = await settle(meta.n_obs);
    for (let k = 0; k < 3; k++) {
      await page.evaluate((u) => window.__spv.app.openUrl(u), `${BASE}fixtures/visium_align.h5ad`);
      await settle(8);
      await page.waitForFunction(() => window.__spv.info().images.loaded === 1);
      await page.evaluate(() => window.__spv.app.openFromManifest('demo'));
      await settle(meta.n_obs);
    }
    const after = await settle(meta.n_obs);
    expect(after.renderer.geometries).toBe(baseline.renderer.geometries);
    expect(after.renderer.textures).toBe(baseline.renderer.textures);
    expect(after.images.bytes).toBe(0);
  });
});

test.describe('fixtures', () => {
  test('tissue images load, can be toggled, and sit on their spots', async ({ page }) => {
    await page.goto(fixtureUrl('visium_align.h5ad'));
    await waitReady(page);
    await page.waitForFunction(() => window.__spv.info().images.loaded === 1);
    const i = await info(page);
    expect(i.images.total).toBe(1);
    expect(i.images.bytes).toBe(64 * 64 * 4);
    expect(i.sections).toEqual(['A']);
    // top-down orthographic single view: red marker (image top-left) must be in the upper half
    await page.evaluate(() => window.__spv.app.store.update('layout', { mode: 'single' }));
    await page.waitForTimeout(400);
    const redAbove = await page.evaluate(async () => {
      const blob: Blob = await window.__spv.app.viewer.screenshot({ scale: 1, transparent: true });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          if (d[o] > 180 && d[o + 1] < 80 && d[o + 2] < 80 && d[o + 3] > 200) {
            sy += y;
            n++;
          }
        }
      }
      return n > 50 && sy / n < c.height / 2;
    });
    expect(redAbove).toBe(true);
    await shot(page, 'align');
    await page.keyboard.press('i');
    await page.waitForFunction(() => window.__spv.info().images.enabled === false);
    await page.keyboard.press('i');
    await page.waitForFunction(() => window.__spv.info().images.enabled === true);
  });

  test('two-library Visium-like file: uns/spatial ordering, in_tissue filter, both image formats', async ({
    page,
  }) => {
    await page.goto(fixtureUrl('visium2.h5ad'));
    await waitReady(page);
    await page.waitForFunction(() => window.__spv.info().images.loaded === 2);
    const i = await info(page);
    expect(i.sections).toEqual(['V1_A', 'V1_B']);
    expect(i.visible).toBeLessThan(i.n); // in_tissue == 0 spots hidden by default
    await page.getByRole('tab', { name: 'Filter' }).click();
    await page.getByText('Show only in_tissue == 1').click();
    await page.waitForFunction((n) => window.__spv.info().visible === n, i.n);
  });

  test('shows a readable error for a missing file and for a non-HDF5 file', async ({ page }) => {
    await page.goto(`#url=${encodeURIComponent(`${BASE}data/does-not-exist.h5ad`)}`);
    await page.waitForFunction(
      () => window.__spv && (window.__spv.ready || window.__spv.error),
      null,
      { timeout: 60_000 },
    );
    const err = (await page.evaluate(() => window.__spv.error)) ?? '';
    expect(err).toMatch(/not found|HTML page|not an HDF5/i);
    await expect(page.locator('.spv-toast.spv-error')).toBeVisible();
    await page.goto(`#url=${encodeURIComponent(`${BASE}data/datasets.json`)}`);
    await page.reload();
    await page.waitForFunction(
      () => window.__spv && (window.__spv.ready || window.__spv.error),
      null,
      { timeout: 60_000 },
    );
    expect(await page.evaluate(() => window.__spv.error)).toMatch(/not an HDF5/i);
  });
});

test.describe('nice-to-haves', () => {
  test('spatial graph overlay loads from obsp, honours the edge cap and custom keys', async ({
    page,
  }) => {
    await page.goto(fixtureUrl('visium2.h5ad'));
    await waitReady(page);
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByText('Show spatial graph edges').click();
    await page.waitForFunction(() => window.__spv.info().graph !== null, null, { timeout: 60_000 });
    let g = (await info(page)).graph;
    expect(g.key).toBe('custom_connectivities'); // first *_connectivities key alphabetically
    expect(g.nEdges).toBe(g.nTotal);
    await page.evaluate(() =>
      window.__spv.app.store.update('graph', { key: 'spatial_connectivities', maxEdges: 1000 }),
    );
    await page.waitForFunction(() => window.__spv.info().graph?.key === 'spatial_connectivities');
    g = (await info(page)).graph;
    expect(g.nEdges).toBe(76); // 60 spots × 2 nearest neighbours, symmetrised and deduplicated
    expect(g.subsampled).toBe(false);
    await page.waitForFunction(() => location.hash.includes('gr=spatial_connectivities'));
    await shot(page, 'graph');
    await page.evaluate(() => window.__spv.app.store.update('graph', { enabled: false }));
    await page.waitForFunction(() => window.__spv.info().graph === null);
  });

  test('manual alignment moves a section, survives the share link, and can be reset', async ({
    page,
    context,
  }) => {
    await page.goto(fixtureUrl('visium2.h5ad'));
    await waitReady(page);
    await page.evaluate(() => {
      window.__spv.app.store.update('layout', { mode: 'tile' });
      window.__spv.app.setAlignment(1, { dx: 20, dy: -10, rot: 15, fx: true, fy: false });
    });
    await page.waitForFunction(() => location.hash.includes('al='));
    const link: string = await page.evaluate(() => window.__spv.app.shareLink());
    const page2 = await context.newPage();
    await page2.goto(link);
    await waitReady(page2);
    const al = (await info(page2)).alignment;
    expect(al['1']).toEqual({ dx: 20, dy: -10, dz: 0, rot: 15, fx: true, fy: false });
    await page2.evaluate(() => window.__spv.app.resetAlignment());
    expect((await info(page2)).alignment).toEqual({});
  });

  test("Moran's I list is offered when uns/moranI exists and colours by the picked gene", async ({
    page,
  }) => {
    await page.goto(fixtureUrl('visium2.h5ad'));
    await waitReady(page);
    await page.getByRole('tab', { name: 'Color' }).click();
    await page.click('summary:has-text("Top spatially variable")');
    const rows = page.locator('.spv-panel.spv-active details .spv-legend-row');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBe(10);
    const gene = ((await rows.first().locator('span').first().textContent()) ?? '').trim();
    await rows.first().click();
    await page.waitForFunction((g) => window.__spv.info().colorbar?.label === g, gene, {
      timeout: 30_000,
    });
    expect((await info(page)).color.source).toBe('gene');
  });
});

test.describe('nice-to-haves 5-7', () => {
  test('two-gene blend colours by both genes and round-trips through the URL', async ({ page }) => {
    const [a, b] = meta.suggested.gene_examples.map((g: { name: string }) => g.name);
    await page.goto(`#dataset=demo&c=${encodeURIComponent(`gene:${a}`)}`);
    await waitReady(page);
    await page.waitForFunction((g) => window.__spv.info().colorbar?.label === g, a, {
      timeout: 60_000,
    });
    await page.getByRole('tab', { name: 'Color' }).click();
    await page.getByPlaceholder('Second gene…').fill(b);
    await page.waitForSelector('.spv-panel.spv-active .spv-autocomplete-item');
    await page.keyboard.press('Enter');
    await page.waitForFunction((l) => window.__spv.info().colorbar?.label === l, `${a} + ${b}`, {
      timeout: 60_000,
    });
    expect((await info(page)).color.gene2).toBe(b);
    await page.waitForFunction((g) => location.hash.includes(`c2=${g}`), b);
    await expect(page.locator('.spv-colorbar-float')).toContainText(b);
    await shot(page, 'blend');
    await page.locator('.spv-panel.spv-active').getByRole('button', { name: 'Clear' }).click();
    await page.waitForFunction((g) => window.__spv.info().colorbar?.label === g, a);
  });

  test('histogram handles set an explicit range', async ({ page }) => {
    const gene = meta.suggested.gene_examples[0].name;
    await page.goto(`#dataset=demo&c=${encodeURIComponent(`gene:${gene}`)}`);
    await waitReady(page);
    await page.waitForFunction((g) => window.__spv.info().colorbar?.label === g, gene, {
      timeout: 60_000,
    });
    await page.getByRole('tab', { name: 'Color' }).click();
    const h = (await info(page)).histogram;
    expect(h.bins.length).toBe(64);
    expect(h.bins.reduce((x: number, y: number) => x + y, 0)).toBe(meta.n_obs);
    const canvas = page.locator('canvas[style*="ew-resize"]');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__spv.info().color.rangeMode === 'absolute');
    const c = (await info(page)).color;
    expect(c.vmax).toBeGreaterThan(c.vmin);
    expect(c.vmax).toBeLessThan(meta.suggested.gene_examples[0].max);
  });

  test('lasso and box selection dim the rest and export CSV with the section column', async ({
    page,
  }) => {
    await page.goto('#dataset=demo');
    await waitReady(page);
    await page.keyboard.press('x');
    await page.waitForFunction(() => window.__spv.app.selectMode === true);
    await expect(page.locator('.spv-selection-bar')).toContainText('Select mode');
    const canvas = page.locator('.spv-viewport canvas').first();
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width * 0.55;
    const cy = box.y + box.height * 0.5;
    await page.mouse.move(cx + 100, cy);
    await page.mouse.down();
    for (let a = 0; a <= 360; a += 30)
      await page.mouse.move(
        cx + 100 * Math.cos((a * Math.PI) / 180),
        cy + 100 * Math.sin((a * Math.PI) / 180),
      );
    await page.mouse.up();
    await page.waitForFunction(() => window.__spv.info().selection > 0);
    const lasso = (await info(page)).selection;
    expect(lasso).toBeGreaterThan(100);
    await shot(page, 'lasso');
    // box selection replaces the lasso
    await page.keyboard.down('Shift');
    await page.mouse.move(cx - 60, cy - 40);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 40, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForFunction((n) => window.__spv.info().selection !== n, lasso);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.spv-selection-bar').getByRole('button', { name: 'CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('spv-demo-selection.csv');
    const text = fs.readFileSync((await download.path())!, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines[0].split(',').slice(0, 3)).toEqual(['cell_index', 'row', 'section']);
    expect(lines.length - 1).toBe((await info(page)).selection);
    expect(lines[1].split(',')[2]).toMatch(/^slice\d+$/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__spv.info().selection === 0);
  });
});

const synthetic = path.join(ROOT, 'data/synthetic/synthetic_40k.h5ad');
test.describe('presentation mode and small screens', () => {
  test('hiding the sidebar shows a clickable legend on the viewport', async ({ page }) => {
    await page.goto('#dataset=demo');
    await waitReady(page);
    const float = page.locator('.spv-legend-float');
    await expect(float).toBeHidden();
    await page.keyboard.press('h');
    await expect(float).toBeVisible();
    const n = (await info(page)).legend.n as number;
    await expect(float.locator('.spv-legend-row')).toHaveCount(Math.min(n, 48));
    await float.locator('.spv-legend-row').first().click();
    await page.waitForFunction(() => window.__spv.info().legend.hidden.length === 1);
    await page.keyboard.press('h');
    await expect(float).toBeHidden();
  });

  test('a phone-width layout never grows past the screen, with or without the sidebar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.goto('#dataset=demo');
    await waitReady(page);
    const size = () =>
      page.evaluate(() => ({
        app: document.getElementById('app')!.scrollWidth,
        view: document.querySelector('.spv-viewport')!.clientWidth,
      }));
    await page.getByRole('tab', { name: 'Color' }).click();
    expect((await size()).app).toBeLessThanOrEqual(420);
    await page.keyboard.press('h');
    await page.waitForFunction(() => document.querySelector('.spv-viewport')!.clientWidth === 420);
    expect((await size()).app).toBeLessThanOrEqual(420);
  });
});

test.describe('native 3-D synthetic dataset', () => {
  test.skip(!fs.existsSync(synthetic), 'run scripts/make_synthetic_demo.py to enable');
  test('takes the native-3D path with obsm/spatial3d', async ({ page }) => {
    await page.goto(`#url=${encodeURIComponent(`${BASE}data/synthetic/synthetic_40k.h5ad`)}`);
    await waitReady(page);
    const i = await info(page);
    expect(i.summary.spatial).toBe('obsm/spatial3d');
    expect(i.sections.length).toBeGreaterThan(1);
    expect(await drawnFraction(page)).toBeGreaterThan(0.01);
    await shot(page, 'synthetic');
  });
});
