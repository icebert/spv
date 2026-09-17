/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __spv: { ready: boolean; error: string | null; info(): any; app: any };
  }
}
export {};
