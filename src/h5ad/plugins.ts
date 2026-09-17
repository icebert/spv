/**
 * Lazy loading of h5wasm-plugins compression filters. The package's own `install_plugins()`
 * fetches `.so` files relative to its module URL, which does not survive bundling, so each plugin
 * is imported as a Vite asset URL on demand and written to h5wasm's plugin search path.
 *
 * Filter ids are the HDF Group registered ids (verified against h5wasm-plugins' tests).
 */
export const PLUGIN_BY_FILTER_ID: Record<number, string> = {
  307: 'bz2',
  32000: 'lzf',
  32001: 'blosc',
  32004: 'lz4',
  32008: 'bshuf',
  32013: 'zfp',
  32015: 'zstd',
  32019: 'jpeg',
  32022: 'bitgroom',
  32023: 'bitround',
  32026: 'blosc2',
};

const PLUGIN_URLS: Record<string, () => Promise<{ default: string }>> = {
  bz2: () => import('h5wasm-plugins/plugins/libH5Zbz2.so?url'),
  lzf: () => import('h5wasm-plugins/plugins/libH5Zlzf.so?url'),
  blosc: () => import('h5wasm-plugins/plugins/libH5Zblosc.so?url'),
  lz4: () => import('h5wasm-plugins/plugins/libH5Zlz4.so?url'),
  bshuf: () => import('h5wasm-plugins/plugins/libH5Zbshuf.so?url'),
  zfp: () => import('h5wasm-plugins/plugins/libH5Zzfp.so?url'),
  zstd: () => import('h5wasm-plugins/plugins/libH5Zzstd.so?url'),
  jpeg: () => import('h5wasm-plugins/plugins/libH5Zjpeg.so?url'),
  bitgroom: () => import('h5wasm-plugins/plugins/libH5Zbitgroom.so?url'),
  bitround: () => import('h5wasm-plugins/plugins/libH5Zbitround.so?url'),
  blosc2: () => import('h5wasm-plugins/plugins/libH5Zblosc2.so?url'),
};

export interface PluginHost {
  get_plugin_search_paths(): string[];
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    analyzePath(path: string): { exists: boolean };
  };
}

export function pluginNameForFilter(id: number): string | null {
  return PLUGIN_BY_FILTER_ID[id] ?? null;
}

/** Fetch one plugin binary and place it where libhdf5 looks for dynamically loaded filters. */
export async function installPlugin(host: PluginHost, name: string): Promise<void> {
  const loader = PLUGIN_URLS[name];
  if (!loader) throw new Error(`No h5wasm plugin named ${name}`);
  const dir = host.get_plugin_search_paths()[0];
  const target = `${dir}/libH5Z${name}.so`;
  host.FS.mkdirTree(dir);
  if (host.FS.analyzePath(target).exists) return;
  const url = (await loader()).default;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Could not download compression plugin ${name} (HTTP ${res.status})`);
  host.FS.writeFile(target, new Uint8Array(await res.arrayBuffer()));
}
