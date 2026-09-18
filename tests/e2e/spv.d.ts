/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __spv: {
      ready: boolean;
      error: string | null;
      version: string;
      build: string;
      errors(): readonly { at: string; source: string; message: string; stack: string | null }[];
      info(): any;
      app: any;
    };
  }
}
export {};
