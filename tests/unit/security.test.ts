import { describe, expect, it } from 'vitest';
import { csvCell, neutralizeFormula } from '../../src/util/csv';
import { unsafeUrlReason } from '../../src/util/safeUrl';

const BASE = 'https://user.github.io/spv/';

describe('unsafeUrlReason', () => {
  it('allows http(s) and site-relative targets', () => {
    expect(unsafeUrlReason('https://bucket.example.org/a.h5ad', BASE)).toBeNull();
    expect(unsafeUrlReason('http://localhost:4173/data/demo.h5ad', BASE)).toBeNull();
    expect(unsafeUrlReason('/spv/data/demo.h5ad', BASE)).toBeNull();
    expect(unsafeUrlReason('data/demo.h5ad', BASE)).toBeNull();
  });
  it('refuses every other scheme, credentials and garbage', () => {
    expect(unsafeUrlReason('javascript:alert(1)', BASE)).toMatch(/Only http\(s\).*javascript/);
    expect(unsafeUrlReason('data:application/octet-stream;base64,AAAA', BASE)).toMatch(/data/);
    expect(unsafeUrlReason('blob:https://user.github.io/uuid', BASE)).toMatch(/blob/);
    expect(unsafeUrlReason('file:///etc/passwd', BASE)).toMatch(/file/);
    expect(unsafeUrlReason('ftp://host/x.h5ad', BASE)).toMatch(/ftp/);
    expect(unsafeUrlReason('https://user:pw@host/x.h5ad', BASE)).toMatch(/credentials/);
    expect(unsafeUrlReason('http://[bad', BASE)).toMatch(/not a valid URL/);
    expect(unsafeUrlReason(`https://${'x'.repeat(200)}`, BASE)).toBeNull();
    expect(unsafeUrlReason('http://[' + 'x'.repeat(200), BASE)?.length).toBeLessThan(120);
  });
});

describe('csv export cells', () => {
  it('neutralises formula-leading text', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx'])
      expect(neutralizeFormula(s)).toBe(`'${s}`);
    expect(neutralizeFormula('cluster 3')).toBe('cluster 3');
    expect(neutralizeFormula('')).toBe('');
  });
  it('quotes CSV cells and flattens TSV cells', () => {
    expect(csvCell('a,b', ',')).toBe('"a,b"');
    expect(csvCell('say "hi"', ',')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak', ',')).toBe('"line\nbreak"');
    expect(csvCell('=HYPERLINK("x")', ',')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a\tb\nc', '\t')).toBe('a b c');
    expect(csvCell('=1', '\t')).toBe(`'=1`);
    expect(csvCell('plain', '\t')).toBe('plain');
  });
});
