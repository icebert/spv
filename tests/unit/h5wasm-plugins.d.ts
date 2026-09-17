declare module 'h5wasm-plugins' {
  export const plugin_names: string[];
  export const base_url: string;
  export function install_plugins(
    module: unknown,
    names?: string[],
    newPluginPath?: string | null,
  ): Promise<void>;
  export function list_plugins(module: unknown): string[];
  export function install_local_plugins(module: unknown): void;
}
