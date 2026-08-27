// Types for the dev relay so package tests can import it under strict TS.
export function createTwinRelay(options?: { port?: number; host?: string }): {
  host: string;
  /** The port actually bound. Read it after awaiting `ready`. */
  readonly port: number;
  /** Resolves once the socket is listening. */
  ready: Promise<unknown>;
  close: () => Promise<unknown>;
};
