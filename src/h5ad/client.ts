/**
 * Main-thread client for the h5wasm worker: one promise per request, progress callbacks,
 * cancellation, and a typed `call()` over `RpcMethods`.
 */
import type { RpcErrorPayload, RpcMethods, RpcRequest, WorkerOutbound } from './rpc';
import type { ProgressEvent } from './types';

export class H5adClientError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'H5adClientError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProgressEvent) => void;
}

export interface CallOptions {
  onProgress?: (p: ProgressEvent) => void;
  signal?: AbortSignal;
}

export function createH5adWorker(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'spv-h5ad' });
}

export class H5adClient {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  onLog: ((level: 'info' | 'warn' | 'error', message: string) => void) | null = null;

  constructor(worker: Worker = createH5adWorker()) {
    this.worker = worker;
    this.readyPromise = new Promise((r) => (this.readyResolve = r));
    worker.onmessage = (e: MessageEvent<WorkerOutbound>) => this.handle(e.data);
    worker.onerror = (e) => {
      const err = new H5adClientError(`Worker error: ${e.message || 'unknown'}`, 'worker');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  /** Resolves once the worker module has executed (engine may still be loading). */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  private handle(msg: WorkerOutbound): void {
    if ('event' in msg) {
      if (msg.event === 'ready') this.readyResolve();
      else if (msg.event === 'progress') this.pending.get(msg.id)?.onProgress?.(msg.progress);
      else if (msg.event === 'log') this.onLog?.(msg.level, msg.message);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(toError(msg.error));
  }

  call<M extends keyof RpcMethods>(
    method: M,
    args: Parameters<RpcMethods[M]>[0],
    opts: CallOptions = {},
  ): Promise<ReturnType<RpcMethods[M]>> {
    const id = this.nextId++;
    return new Promise<ReturnType<RpcMethods[M]>>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new H5adClientError('cancelled', 'cancelled'));
        return;
      }
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress: opts.onProgress,
      });
      opts.signal?.addEventListener('abort', () => this.worker.postMessage({ cancel: id }), {
        once: true,
      });
      const req: RpcRequest = { id, method, args };
      this.worker.postMessage(req);
    });
  }

  /** Kill the worker outright (also frees the WASM heap). Pending calls reject. */
  terminate(): void {
    this.worker.terminate();
    const err = new H5adClientError('worker terminated', 'cancelled');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

function toError(e: RpcErrorPayload): H5adClientError {
  return new H5adClientError(e.message, e.code);
}
