/**
 * Natural sort key for section names: digits (including negative decimals such as the
 * "-0.29" in "Bregma_-0.29") compare numerically, everything else case-insensitively, so
 * "S2" < "S10" and "slice1" < "slice2" < "slice10".
 */
export type NaturalKey = (number | string)[];

const TOKEN = /(-?\d+(?:\.\d+)?)/;

export function naturalKey(s: string): NaturalKey {
  return s
    .split(TOKEN)
    .filter((p) => p !== '')
    .map((p) => (TOKEN.test(p) && !Number.isNaN(Number(p)) ? Number(p) : p.toLowerCase()));
}

export function compareNatural(a: string, b: string): number {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1; // numbers sort before text
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return ka.length - kb.length;
}

export function naturalSort(names: readonly string[]): string[] {
  return [...names].sort(compareNatural);
}
