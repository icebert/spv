/**
 * Lazy HTTP range loading for h5wasm, replacing Emscripten's `FS.createLazyFile`.
 *
 * The built-in loader trusts whatever the browser hands back for a `Range` request. Safari's URL
 * cache ignores byte ranges: once a partial response for a URL is cached, a later request for a
 * *different* range of the same URL can be answered with the cached bytes. HDF5 then silently
 * reads another part of the file — coordinates of the wrong cells, whole sections at the wrong z.
 * A server that ignores `Range` and returns the entire file with status 200 was mishandled the
 * same way (the first megabyte was reused for every chunk).
 *
 * This loader
 *   - gives every chunk its own URL (`?spv_range=<from>-<to>`) unless the URL already has a query
 *     string (a signed URL must not be altered), so URL-keyed caches stay correct;
 *   - verifies each response: 206 with a matching `Content-Range` (or the exact length when the
 *     header is not readable cross-origin), or 200 with the whole file, which is then sliced here;
 *   - retries once with a cache-busting parameter and then fails loudly instead of returning
 *     garbage;
 *   - copies blocks with `subarray`/`set` instead of one byte at a time.
 */
import { ReaderError } from './reader';

export const DEFAULT_CHUNK_SIZE = 1 << 20;
export const RANGE_PARAM = 'spv_range';
export const NOCACHE_PARAM = 'spv_nocache';

export interface RangeResponse {
  status: number;
  body: Uint8Array;
  contentRange: string | null;
}

/** Synchronous range fetch: sync XHR inside a Web Worker (HDF5 reads are synchronous). */
export type RangeFetcher = (url: string, from: number, to: number) => RangeResponse;

export interface LazyRangeOptions {
  url: string;
  /** File size in bytes (known from the async pre-flight). */
  size: number;
  fetchRange: RangeFetcher;
  chunkSize?: number;
  /** Key every chunk by its own URL; default: only when `url` has no query string. */
  perChunkUrls?: boolean;
}

export function parseContentRange(
  header: string | null,
): { from: number; to: number; total: number | null } | null {
  if (!header) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header);
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

export function withParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

export class LazyRangeReader {
  readonly url: string;
  readonly size: number;
  readonly chunkSize: number;
  readonly perChunkUrls: boolean;
  private readonly chunks: (Uint8Array | undefined)[];
  private full: Uint8Array | null = null;
  private readonly fetchRange: RangeFetcher;
  bytesDownloaded = 0;
  requests = 0;

  constructor(opts: LazyRangeOptions) {
    this.url = opts.url;
    this.size = opts.size;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.perChunkUrls = opts.perChunkUrls ?? !opts.url.includes('?');
    this.fetchRange = opts.fetchRange;
    this.chunks = new Array<Uint8Array | undefined>(Math.ceil(this.size / this.chunkSize));
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  chunkUrl(from: number, to: number, nocache = false): string {
    if (!this.perChunkUrls) return this.url;
    let u = withParam(this.url, RANGE_PARAM, `${from}-${to}`);
    if (nocache) u = withParam(u, NOCACHE_PARAM, String(Date.now()));
    return u;
  }

  /** Copy up to `length` bytes at `position` into `buffer[offset…]`; returns the count (0 at EOF). */
  read(buffer: Uint8Array, offset: number, length: number, position: number): number {
    if (position >= this.size || length <= 0) return 0;
    const n = Math.min(length, this.size - position);
    if (this.full) {
      buffer.set(this.full.subarray(position, position + n), offset);
      return n;
    }
    let done = 0;
    while (done < n) {
      const pos = position + done;
      const k = Math.floor(pos / this.chunkSize);
      const chunk = this.chunk(k);
      const start = pos - k * this.chunkSize;
      const take = Math.min(n - done, chunk.length - start);
      buffer.set(chunk.subarray(start, start + take), offset + done);
      done += take;
    }
    return n;
  }

  /** Chunk `k` (fetching and verifying it on first use). */
  chunk(k: number): Uint8Array {
    const from = k * this.chunkSize;
    const to = Math.min(this.size, from + this.chunkSize) - 1;
    if (this.full) return this.full.subarray(from, to + 1);
    let c = this.chunks[k];
    if (!c) {
      c = this.fetchVerified(from, to);
      if (this.full) {
        this.bytesDownloaded = this.size;
        return c;
      }
      this.chunks[k] = c;
      this.bytesDownloaded += c.length;
    }
    return c;
  }

  private fetchVerified(from: number, to: number): Uint8Array {
    const want = to - from + 1;
    let problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = this.chunkUrl(from, to, attempt > 0);
      let res: RangeResponse;
      try {
        res = this.fetchRange(url, from, to);
      } catch (err) {
        throw new ReaderError(
          `Could not fetch bytes ${from}-${to} of ${this.url}: ${(err as Error).message}`,
          'missing',
        );
      }
      this.requests++;
      const { status, body } = res;
      if (status === 206) {
        const cr = parseContentRange(res.contentRange);
        if (cr) {
          if (
            cr.from === from &&
            cr.to === to &&
            body.length === want &&
            (cr.total === null || cr.total === this.size)
          )
            return body;
          problem = `asked for bytes ${from}-${to}, got "${res.contentRange}" (${body.length} bytes)`;
        } else if (body.length === want) {
          // Content-Range is not readable cross-origin unless the server exposes it; the length
          // is the only check left.
          return body;
        } else {
          problem = `asked for ${want} bytes, got ${body.length}`;
        }
      } else if (status === 200) {
        if (body.length === this.size) {
          // The server (or a cache) ignored Range and sent the whole file: keep all of it.
          this.full = body;
          return body.subarray(from, to + 1);
        }
        if (body.length === want) return body;
        problem = `status 200 with ${body.length} bytes (the file has ${this.size})`;
      } else if ((status >= 200 && status < 300) || status === 304) {
        problem = `unexpected HTTP status ${status}`;
      } else {
        throw new ReaderError(
          `HTTP ${status} while reading bytes ${from}-${to} of ${this.url}`,
          'missing',
        );
      }
    }
    throw new ReaderError(
      `The server or the browser cache returned the wrong bytes for ${this.url} (${problem}). ` +
        'Safari is known to answer range requests from a URL-keyed cache; empty the browser cache ' +
        'and reload, or serve the file with "Cache-Control: no-store".',
      'missing',
    );
  }
}

/** The bits of an Emscripten MEMFS node this module touches. */
export interface EmNode {
  contents: unknown;
  usedBytes: number;
  stream_ops: Record<string, unknown>;
}

export interface LazyFsHost {
  createFile(
    parent: string,
    name: string,
    properties: object,
    canRead: boolean,
    canWrite: boolean,
  ): EmNode;
}

/**
 * Create a read-only file at `parent/name` whose reads are served by `reader`. Same wiring as
 * Emscripten's `FS.createLazyFile` (a MEMFS node with overridden `stream_ops.read` and a
 * `usedBytes` getter), minus its XHR.
 */
export function mountLazyFile(
  FS: LazyFsHost,
  parent: string,
  name: string,
  reader: LazyRangeReader,
): EmNode {
  const node = FS.createFile(parent, name, {}, true, false);
  node.contents = reader;
  Object.defineProperty(node, 'usedBytes', { get: () => reader.size, configurable: true });
  node.stream_ops = {
    ...node.stream_ops,
    read: (
      _stream: unknown,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => reader.read(buffer, offset, length, position),
    write: () => {
      throw new Error('lazy files are read-only');
    },
    mmap: () => {
      throw new Error('mmap is not supported on lazy files');
    },
  };
  return node;
}

/** Synchronous XHR range fetch (Web Workers only). */
export function xhrRangeFetcher(): RangeFetcher {
  return (url, from, to) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Range', `bytes=${from}-${to}`);
    xhr.responseType = 'arraybuffer';
    xhr.send(null);
    const buf = xhr.response as ArrayBuffer | null;
    return {
      status: xhr.status,
      body: new Uint8Array(buf ?? new ArrayBuffer(0)),
      contentRange: xhr.getResponseHeader('Content-Range'),
    };
  };
}
