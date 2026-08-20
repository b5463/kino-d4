import {
  RollServerError,
  type CredentialledRollServerClient,
} from './RollServerClient';

interface ErrorBody {
  code?: unknown;
  message?: unknown;
}

/** Browser HTTP implementation of Studio's one Roll-server seam. */
export class HttpRollServerClient implements CredentialledRollServerClient {
  readonly baseUrl: string;
  private deviceId: string | null = null;
  private deviceToken: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  useDeviceCredential(deviceId: string, deviceToken: string): void {
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
  }

  async testConnection(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const started = performance.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/healthz`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return { ok: false, error: `Server answered ${String(response.status)}.` };
      const body = (await response.json()) as { ok?: unknown };
      return body.ok === true
        ? { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)) }
        : { ok: false, error: 'Server dependencies are not ready.' };
    } catch (caught) {
      return { ok: false, error: caught instanceof Error ? caught.message : String(caught) };
    }
  }

  async registerDevice(
    serial: string,
    product: string,
    hardwareRevision: string,
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const registered = await this.request<{ deviceId: string; deviceToken: string }>(
      '/api/studio/devices/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serial, product, hardwareRevision }),
      },
    );
    this.useDeviceCredential(registered.deviceId, registered.deviceToken);
    return registered;
  }

  async createRoll(opts: {
    title: string;
    pin?: string;
    downloadsEnabled: boolean;
  }): Promise<{ rollId: string; slug: string; guestUrl: string; hostUrl: string }> {
    if (this.deviceToken === null || this.deviceId === null) {
      throw new RollServerError('DEVICE_NOT_REGISTERED', 'Register this KINO with the Roll server first.');
    }
    return this.request('/api/device/rolls', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.deviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (caught) {
      throw new RollServerError(
        'SERVER_UNREACHABLE',
        caught instanceof Error ? caught.message : String(caught),
      );
    }
    if (!response.ok) {
      let body: ErrorBody | null = null;
      try {
        body = (await response.json()) as ErrorBody;
      } catch {
        // Preserve the HTTP status when a proxy returns a non-JSON body.
      }
      throw new RollServerError(
        typeof body?.code === 'string' ? body.code : `HTTP_${String(response.status)}`,
        typeof body?.message === 'string' ? body.message : response.statusText,
      );
    }
    return (await response.json()) as T;
  }
}
