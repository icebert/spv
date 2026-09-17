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
    await page.goto('#dataset=demo');
    await waitReady(page);
    const baseline = await info(page);
    for (let k = 0; k < 3; k++) {
      await page.evaluate((u) => window.__spv.app.openUrl(u), `${BASE}fixtures/visium_align.h5ad`);
      await page.waitForFunction(() => window.__spv.info().n === 8);
      await page.waitForFunction(() => window.__spv.info().images.loaded === 1);
      await page.evaluate(() => window.__spv.app.openFromManifest('demo'));
      await page.waitForFunction(
        (n) => window.__spv.info().n === n && window.__spv.ready,
        meta.n_obs,
        { timeout: 120_000 },
      );
    }
    const after = await info(page);
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

const synthetic = path.join(ROOT, 'data/synthetic/synthetic_40k.h5ad');
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
