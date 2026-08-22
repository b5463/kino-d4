// Types for the dev relay so package tests can import it under strict TS.
export function createTwinRelay(options?: { port?: number; host?: string }): {
  host: string;
  port: number;
  close: () => Promise<unknown>;
};
