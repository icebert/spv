import fs from 'node:fs';
import path from 'node:path';
import type * as H5NodeNs from 'h5wasm/node';
import { H5wasmSource } from '../../src/h5ad/source';

export const FIXTURES = path.resolve(__dirname, '../fixtures');

type H5Node = typeof H5NodeNs;
let h5: H5Node | null = null;

export async function h5wasm(): Promise<H5Node> {
  if (!h5) {
    h5 = await import('h5wasm/node');
    const M = await h5.ready;
    M.activate_throwing_error_handler();
  }
  return h5;
}

export async function openFixture(name: string): Promise<H5wasmSource> {
  const mod = await h5wasm();
  const file = new mod.File(path.join(FIXTURES, name), 'r');
  if (file.file_id < 0n) throw new Error(`could not open ${name}`);
  return new H5wasmSource(file);
}

export function expected<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.expected.json`), 'utf8')) as T;
}

export const PY_DTYPE: Record<string, string> = {
  float32: '<f',
  float64: '<d',
  int32: '<i',
  int64: '<q',
  uint8: '<B',
};

export function closeArrays(actual: ArrayLike<number>, exp: (number | null)[], digits = 4): void {
  if (actual.length !== exp.length) throw new Error(`length ${actual.length} != ${exp.length}`);
  for (let i = 0; i < exp.length; i++) {
    const e = exp[i];
    const a = actual[i];
    if (e === null) {
      if (Number.isFinite(a)) throw new Error(`index ${i}: expected NaN, got ${a}`);
    } else if (Math.abs(a - e) > Math.pow(10, -digits) * Math.max(1, Math.abs(e))) {
      throw new Error(`index ${i}: ${a} != ${e}`);
    }
  }
}
