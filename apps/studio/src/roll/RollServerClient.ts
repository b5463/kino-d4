// The Roll server seam.
//
// Everything else on the Roll page is device-side KDP. This is the one place
// Studio talks to `kino.acronym.sk`; `HttpRollServerClient` is the live
// implementation and this module retains the explicit offline/demo stub.
//
// 05 §13 / 03 §27: Wi-Fi credentials are provisioned straight to the camera
// over KDP and are never an argument to anything in this file.

export const DEFAULT_ROLL_SERVER_URL = 'https://kino.acronym.sk';

/** Error code every stub rejection carries, and what the page matches on. */
export const SERVER_NOT_CONFIGURED = 'SERVER_NOT_CONFIGURED';

export interface RollServerClient {
  baseUrl: string;
  testConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  /** The returned token is shown once and then written to the device. */
  registerDevice(
    serial: string,
    product: string,
    hardwareRevision: string,
  ): Promise<{ deviceId: string; deviceToken: string }>;
  createRoll(opts: {
    title: string;
    pin?: string;
    downloadsEnabled: boolean;
  }): Promise<{ rollId: string; slug: string; guestUrl: string; hostUrl: string }>;
}

/** A client that can carry the just-issued device credential in memory. */
export interface CredentialledRollServerClient extends RollServerClient {
  useDeviceCredential(deviceId: string, deviceToken: string): void;
}

export function acceptsDeviceCredential(
  client: RollServerClient,
): client is CredentialledRollServerClient {
  return 'useDeviceCredential' in client && typeof client.useDeviceCredential === 'function';
}

export class RollServerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RollServerError';
    this.code = code;
  }
}

export function isServerNotConfigured(err: unknown): boolean {
  return err instanceof RollServerError && err.code === SERVER_NOT_CONFIGURED;
}

/**
 * Explicit offline/demo client. A stub that quietly succeeded would be worse
 * than none at all.
 */
export class StubRollServerClient implements RollServerClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_ROLL_SERVER_URL) {
    this.baseUrl = baseUrl;
  }

  private refuse(): never {
    throw new RollServerError(
      SERVER_NOT_CONFIGURED,
      `${SERVER_NOT_CONFIGURED} — no Roll server is configured for ${this.baseUrl}. Uploads stay queued on the camera.`,
    );
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    return {
      ok: false,
      error: `${SERVER_NOT_CONFIGURED} — no Roll server is configured for ${this.baseUrl}.`,
    };
  }

  async registerDevice(): Promise<{ deviceId: string; deviceToken: string }> {
    this.refuse();
  }

  async createRoll(): Promise<{ rollId: string; slug: string; guestUrl: string; hostUrl: string }> {
    this.refuse();
  }
}

let client: RollServerClient = new StubRollServerClient();

export function getRollServerClient(): RollServerClient {
  return client;
}

/** Swapped after a server URL is tested, or by a test that needs a live server. */
export function setRollServerClient(next: RollServerClient) {
  client = next;
}

/** Point the stub at a different base URL without changing the seam. */
export function setRollServerUrl(baseUrl: string) {
  client = client instanceof StubRollServerClient ? new StubRollServerClient(baseUrl) : client;
}
