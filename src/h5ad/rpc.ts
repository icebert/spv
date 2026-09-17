/**
 * Worker RPC protocol shared by `worker.ts` (server) and `client.ts` (main thread). Pure types plus
 * the tiny helper that finds transferable buffers in a result object.
 */
import type {
  ColumnData,
  CoordinateSpec,
  DecodedImage,
  GeneVector,
  GraphEdges,
  MoranI,
  ProgressEvent,
  SpatialData,
  Summary,
} from './types';

export type OpenSource =
  | { kind: 'url'; url: string; name?: string; mode?: 'auto' | 'lazy' | 'full' }
  | { kind: 'file'; file: File }
  | { kind: 'buffer'; buffer: ArrayBuffer; name: string };

export type LoadMode = 'lazy' | 'full' | 'workerfs' | 'memfs';

export interface OpenResult {
  summary: Summary;
  loadMode: LoadMode;
  bytesTotal: number | null;
  timings: { engineMs: number; loadMs: number; summaryMs: number };
  pluginsInstalled: string[];
}

export interface LoadStats {
  loadMode: LoadMode | null;
  bytesTotal: number | null;
  /** Bytes actually fetched so far (lazy mode) or the file size (full modes). */
  bytesDownloaded: number | null;
  heapBytes: number;
  csrIndexBytes: number;
}

export interface RpcMethods {
  open(src: OpenSource): OpenResult;
  getSummary(arg: null): Summary;
  /** `null` = the detected defaults. */
  getSpatial(spec: CoordinateSpec | null): SpatialData;
  getObsColumn(name: string): ColumnData;
  /** `null` = the var index; otherwise a `var` column name. */
  getVarNames(column: string | null): string[];
  getGeneVector(req: { matrix: string; index: number }): GeneVector;
  getImage(req: { library: string; key: string; maxSide: number }): DecodedImage;
  getGraphEdges(req: { key: string; maxEdges: number }): GraphEdges;
  getMoranI(arg: null): MoranI | null;
  getCategoryColors(req: { column: string; n: number }): string[] | null;
  getObsIndex(rows: number[]): string[];
  getLoadStats(arg: null): LoadStats;
  close(arg: null): void;
}

export type RpcMethodName = keyof RpcMethods;

export interface RpcRequest {
  id: number;
  method: RpcMethodName;
  args: unknown;
}

export interface RpcCancel {
  cancel: number;
}

export interface RpcErrorPayload {
  message: string;
  code: string | null;
  name: string;
}

export type RpcResponse =
  { id: number; ok: true; result: unknown } | { id: number; ok: false; error: RpcErrorPayload };

export type RpcEvent =
  | { event: 'progress'; id: number; progress: ProgressEvent }
  | { event: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { event: 'ready' };

export type WorkerOutbound = RpcResponse | RpcEvent;
export type WorkerInbound = RpcRequest | RpcCancel;

/** Collect distinct ArrayBuffers of typed arrays nested (≤ 3 levels) in a result for transfer. */
export function collectTransferables(
  value: unknown,
  depth = 0,
  out: Set<ArrayBuffer> = new Set(),
): ArrayBuffer[] {
  if (depth > 3 || value === null || typeof value !== 'object') return [...out];
  if (ArrayBuffer.isView(value)) {
    if (
      value.buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength
    ) {
      out.add(value.buffer);
    }
    return [...out];
  }
  if (Array.isArray(value)) {
    if (value.length < 64) for (const v of value) collectTransferables(v, depth + 1, out);
    return [...out];
  }
  for (const v of Object.values(value as Record<string, unknown>))
    collectTransferables(v, depth + 1, out);
  return [...out];
}
