import { describe, expect, it } from 'vitest';
import { manifestEntries } from '../../src/state/manifest';

describe('dataset manifest', () => {
  it('keeps entries with id, name and url and counts the rest', () => {
    const { entries, skipped } = manifestEntries({
      datasets: [
        { id: 'demo', name: 'Demo', url: 'demo.h5ad' },
        { id: '', name: 'No id', url: 'x.h5ad' },
        { id: 'nourl', name: 'No URL' },
        null,
        'text',
        { id: 'ok', name: 'Ok', url: 'https://example.org/a.h5ad', size_bytes: 12 },
      ],
    });
    expect(entries.map((e) => e.id)).toEqual(['demo', 'ok']);
    expect(skipped).toBe(4);
  });

  it('rejects a manifest whose datasets field is not a list', () => {
    expect(() => manifestEntries({ datasets: {} })).toThrow(/not a list/);
    expect(() => manifestEntries(null)).toThrow(/not a list/);
    expect(() => manifestEntries([])).toThrow(/not a list/);
    expect(manifestEntries({ datasets: [] })).toEqual({ entries: [], skipped: 0 });
  });
});
