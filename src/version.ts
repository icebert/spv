/**
 * Version and build stamp, injected at build time by vite.config.ts (`define`). They appear in the
 * Help dialog, on `window.__spv.version` and at the top of the `D` diagnostic report so that a
 * pasted report always says which build produced it. Under vitest (no `define`) both fall back.
 */
export const VERSION: string = typeof __SPV_VERSION__ === 'string' ? __SPV_VERSION__ : '0.0.0';
export const BUILD: string = typeof __SPV_BUILD__ === 'string' ? __SPV_BUILD__ : 'dev';

export function versionLine(): string {
  return `SPV ${VERSION}, build ${BUILD}`;
}
