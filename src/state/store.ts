/**
 * A tiny typed store: state is a record of slices; `update(slice, patch)` merges a patch into one
 * slice and notifies that slice's listeners plus any global listeners. No dependencies.
 */
export type Listener<T> = (value: T, prev: T) => void;

export class Store<S extends Record<string, object>> {
  private state: S;
  private readonly sliceListeners = new Map<keyof S, Set<Listener<S[keyof S]>>>();
  private readonly anyListeners = new Set<(key: keyof S, state: S) => void>();
  private batchDepth = 0;
  private pending = new Map<keyof S, S[keyof S]>();

  constructor(initial: S) {
    this.state = initial;
  }

  get(): S {
    return this.state;
  }

  slice<K extends keyof S>(key: K): S[K] {
    return this.state[key];
  }

  /** Merge `patch` into slice `key`; no-op when nothing changes (shallow compare). */
  update<K extends keyof S>(key: K, patch: Partial<S[K]>): void {
    const prev = this.state[key];
    let changed = false;
    for (const k of Object.keys(patch) as (keyof S[K])[]) {
      if (!Object.is(prev[k], patch[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next = { ...prev, ...patch } as S[K];
    this.state = { ...this.state, [key]: next };
    if (this.batchDepth > 0) {
      if (!this.pending.has(key)) this.pending.set(key, prev);
      return;
    }
    this.emit(key, prev);
  }

  /** Replace a whole slice. */
  replace<K extends keyof S>(key: K, value: S[K]): void {
    const prev = this.state[key];
    this.state = { ...this.state, [key]: value };
    if (this.batchDepth > 0) {
      if (!this.pending.has(key)) this.pending.set(key, prev);
      return;
    }
    this.emit(key, prev);
  }

  /** Group several updates; listeners fire once per touched slice at the end. */
  batch(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) {
        const pending = this.pending;
        this.pending = new Map();
        for (const [key, prev] of pending) this.emit(key, prev);
      }
    }
  }

  private emit<K extends keyof S>(key: K, prev: S[K]): void {
    const value = this.state[key];
    for (const l of this.sliceListeners.get(key) ?? []) (l as Listener<S[K]>)(value, prev);
    for (const l of this.anyListeners) l(key, this.state);
  }

  on<K extends keyof S>(key: K, listener: Listener<S[K]>): () => void {
    let set = this.sliceListeners.get(key);
    if (!set) {
      set = new Set();
      this.sliceListeners.set(key, set);
    }
    set.add(listener as Listener<S[keyof S]>);
    return () => set!.delete(listener as Listener<S[keyof S]>);
  }

  onAny(listener: (key: keyof S, state: S) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }
}
