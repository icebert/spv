import { describe, expect, it } from 'vitest';
import {
  LazyRangeReader,
  NOCACHE_PARAM,
  RANGE_PARAM,
  mountLazyFile,
  parseContentRange,
  withParam,
  type EmNode,
  type RangeFetcher,
  type RangeResponse,
} from '../../src/h5ad/lazyFile';
import { ReaderError } from '../../src/h5ad/reader';

function pattern(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 7 + (i >> 8)) & 255;
  return d;
}

type Behaviour = 'ok' | 'ignore-range' | 'url-cache' | 'no-content-range' | 'short' | 'wrong-once';

/** A fake server (or cache); `log` records every URL requested. */
function server(data: Uint8Array, behaviour: Behaviour) {
  const log: string[] = [];
  const cache = new Map<string, RangeResponse>();
  let wrongServed = false;
  const fetchRange = (url: string, from: number, to: number): RangeResponse => {
    log.push(url);
    const body = data.slice(from, to + 1);
    const ok: RangeResponse = {
      status: 206,
      body,
      contentRange: `bytes ${from}-${to}/${data.length}`,
    };
    switch (behaviour) {
      case 'ok':
        return ok;
      case 'ignore-range':
        return { status: 200, body: data.slice(), contentRange: null };
      case 'no-content-range':
        return { status: 206, body, contentRange: null };
      case 'short':
        return { status: 206, body: body.subarray(0, body.length - 1), contentRange: null };
      case 'wrong-once': {
        if (!wrongServed && from > 0) {
          wrongServed = true;
          return {
            status: 206,
            body: data.slice(0, to - from + 1),
            contentRange: `bytes 0-${to - from}/${data.length}`,
          };
        }
        return ok;
      }
      case 'url-cache': {
        // Safari: the cache is keyed by URL only, so the first response for a URL is replayed for
        // every later request to that URL whatever its Range header says.
        const hit = cache.get(url);
        if (hit) return hit;
        cache.set(url, ok);
        return ok;
      }
    }
  };
  return { fetchRange, log };
}

function readAll(reader: LazyRangeReader, size: number, step: number): Uint8Array {
  const out = new Uint8Array(size);
  let pos = 0;
  while (pos < size) {
    const n = reader.read(out, pos, step, pos);
    if (n === 0) break;
    pos += n;
  }
  return out;
}

const URL = 'https://host/x.h5ad';

describe('LazyRangeReader', () => {
  const data = pattern(2500);
  const make = (fetchRange: RangeFetcher, url = URL) =>
    new LazyRangeReader({ url, size: data.length, chunkSize: 1000, fetchRange });

  it('reads windows across chunk boundaries and keys every chunk by its own URL', () => {
    const { fetchRange, log } = server(data, 'ok');
    const r = make(fetchRange);
    expect(r.chunkCount).toBe(3);
    const buf = new Uint8Array(20);
    expect(r.read(buf, 0, 20, 990)).toBe(20);
    expect([...buf]).toEqual([...data.subarray(990, 1010)]);
    expect(r.read(buf, 0, 20, 2490)).toBe(10); // clamped at EOF
    expect([...buf.subarray(0, 10)]).toEqual([...data.subarray(2490, 2500)]);
    expect(r.read(buf, 0, 20, 2500)).toBe(0);
    expect(readAll(r, data.length, 333)).toEqual(data);
    expect(r.requests).toBe(3);
    expect(r.bytesDownloaded).toBe(2500);
    expect(log).toEqual([
      `${URL}?${RANGE_PARAM}=0-999`,
      `${URL}?${RANGE_PARAM}=1000-1999`,
      `${URL}?${RANGE_PARAM}=2000-2499`,
    ]);
  });

  it('accepts a server that ignores Range and keeps the whole file', () => {
    const { fetchRange } = server(data, 'ignore-range');
    const r = make(fetchRange);
    expect(readAll(r, data.length, 700)).toEqual(data);
    expect(r.requests).toBe(1);
    expect(r.bytesDownloaded).toBe(data.length);
  });

  it('is immune to a URL-keyed cache that ignores byte ranges', () => {
    const { fetchRange } = server(data, 'url-cache');
    expect(readAll(make(fetchRange), data.length, 1000)).toEqual(data);
  });

  it('leaves a URL with a query string alone and refuses wrong bytes instead of using them', () => {
    const { fetchRange, log } = server(data, 'url-cache');
    const signed = `${URL}?X-Amz-Signature=abc`;
    const r = make(fetchRange, signed);
    const buf = new Uint8Array(10);
    expect(r.read(buf, 0, 10, 0)).toBe(10);
    expect(() => r.read(buf, 0, 10, 1000)).toThrow(ReaderError);
    expect(() => r.read(buf, 0, 10, 1000)).toThrow(/wrong bytes/);
    expect(log.every((u) => u === signed)).toBe(true);
  });

  it('retries a mismatching Content-Range once with a cache-busting parameter', () => {
    const { fetchRange, log } = server(data, 'wrong-once');
    const r = make(fetchRange);
    expect(readAll(r, data.length, 1000)).toEqual(data);
    expect(r.requests).toBe(4);
    expect(log.filter((u) => u.includes(`${NOCACHE_PARAM}=`))).toHaveLength(1);
  });

  it('without Content-Range only the exact length is accepted', () => {
    const ok = make(server(data, 'no-content-range').fetchRange);
    expect(readAll(ok, data.length, 1000)).toEqual(data);
    const short = make(server(data, 'short').fetchRange);
    expect(() => short.read(new Uint8Array(1), 0, 1, 0)).toThrow(/wrong bytes/);
  });

  it('parses Content-Range and appends query parameters', () => {
    expect(parseContentRange('bytes 0-999/2500')).toEqual({ from: 0, to: 999, total: 2500 });
    expect(parseContentRange('bytes 5-9/*')).toEqual({ from: 5, to: 9, total: null });
    expect(parseContentRange('items 0-1/2')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
    expect(withParam('https://h/a', 'k', '1-2')).toBe('https://h/a?k=1-2');
    expect(withParam('https://h/a?x=1', 'k', 'v w')).toBe('https://h/a?x=1&k=v%20w');
  });
});

describe('mountLazyFile', () => {
  it('wires a read-only node whose reads and size come from the reader', () => {
    const data = pattern(3000);
    const r = new LazyRangeReader({
      url: URL,
      size: data.length,
      chunkSize: 1024,
      fetchRange: server(data, 'ok').fetchRange,
    });
    const calls: unknown[] = [];
    const node: EmNode = {
      contents: null,
      usedBytes: 0,
      stream_ops: {
        llseek: () => 0,
        read: () => {
          throw new Error('MEMFS read must be replaced');
        },
      },
    };
    const FS = {
      createFile: (...args: unknown[]) => {
        calls.push(args);
        return node;
      },
    };
    expect(mountLazyFile(FS, '/', 'x.h5ad', r)).toBe(node);
    expect(calls).toEqual([['/', 'x.h5ad', {}, true, false]]);
    expect(node.usedBytes).toBe(3000);
    expect(typeof node.stream_ops.llseek).toBe('function'); // MEMFS ops are kept
    const read = node.stream_ops.read as (
      stream: unknown,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => number;
    const buf = new Uint8Array(16);
    expect(read(null, buf, 4, 8, 1020)).toBe(8);
    expect([...buf.subarray(4, 12)]).toEqual([...data.subarray(1020, 1028)]);
    expect(() => (node.stream_ops.write as () => void)()).toThrow(/read-only/);
  });
});
