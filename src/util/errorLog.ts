/**
 * A small ring buffer of recent runtime errors. `main.ts` feeds it from the global `error` and
 * `unhandledrejection` events and `App.notice()` from every error notice, so the `D` diagnostic
 * report can include what went wrong shortly before it was copied.
 */
export interface ErrorEntry {
  at: string;
  source: 'error' | 'unhandledrejection' | 'notice';
  message: string;
  stack: string | null;
}

const MAX = 20;
const entries: ErrorEntry[] = [];

export function recordError(source: ErrorEntry['source'], err: unknown): ErrorEntry {
  const e = err instanceof Error ? err : null;
  const entry: ErrorEntry = {
    at: new Date().toISOString(),
    source,
    message: e ? e.message : String(err),
    stack: e?.stack ?? null,
  };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  return entry;
}

export function recentErrors(): readonly ErrorEntry[] {
  return entries;
}

/** Errors that are expected in normal use and should never reach the user as a failure. */
export function isBenignError(err: unknown): boolean {
  const e = err as { message?: unknown; code?: unknown; name?: unknown } | null;
  if (!e) return false;
  if (e.code === 'cancelled' || e.name === 'AbortError') return true;
  const msg = typeof e.message === 'string' ? e.message : String(err);
  return /ResizeObserver loop|worker terminated/.test(msg);
}
