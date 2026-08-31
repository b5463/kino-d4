import { ApiError, type CaptureAssetSummary } from './client';

export const HOST_TOKEN_STORAGE_KEY = 'kino.hostToken';

export interface HostRollView {
  rollId: string;
  slug: string;
  title: string;
  status: string;
  privacy: string;
  hasPin: boolean;
  downloadsEnabled: boolean;
  reactionsEnabled: boolean;
  deviceSerial: string | null;
  guestUrl: string;
  createdAt: string;
  closedAt: string | null;
  counts: { captures: number; pending: number; hidden: number };
  guests: number;
}

export interface HostCaptureView {
  captureId: string;
  mode: string;
  look: string | null;
  capturedAt: string;
  createdAt: string;
  frameCount: number;
  resolution: string;
  status: string;
  assets: CaptureAssetSummary[];
  visible: boolean;
  deletedAt: string | null;
  purgeAfter: string | null;
}

export interface HostCapturePage {
  items: HostCaptureView[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ModerationView {
  captureId: string;
  visible: boolean;
  deletedAt: string | null;
  purgeAfter: string | null;
}

export type HostRollEvent =
  | { type: 'roll.opened' | 'roll.closed' }
  | {
      type: 'capture.created' | 'capture.updated' | 'capture.hidden' | 'capture.deleted';
      captureId: string;
    }
  | { type: 'processing.completed'; captureId: string; role: string };

export interface HostApi {
  resolveSession(): Promise<HostRollView>;
  getRoll(rollId: string): Promise<HostRollView>;
  updateRoll(
    rollId: string,
    patch: Partial<Pick<HostRollView, 'title' | 'downloadsEnabled' | 'status'>> & {
      pin?: string | null;
    },
  ): Promise<HostRollView>;
  listCaptures(rollId: string, cursor?: string): Promise<HostCapturePage>;
  hide(captureId: string): Promise<ModerationView>;
  unhide(captureId: string): Promise<ModerationView>;
  deleteCapture(captureId: string): Promise<ModerationView>;
  regenerateSlug(rollId: string): Promise<{ slug: string; guestUrl: string }>;
  startExport(rollId: string): Promise<{ jobId: string }>;
  getExport(rollId: string, jobId: string): Promise<{ status: string; url?: string }>;
  assetUrl(assetId: string): string;
  events(rollId: string, onEvent: (event: HostRollEvent) => void): () => void;
}

/**
 * Accepts a deep-link token exactly once, moves it to tab-scoped storage, and
 * strips it from browser history before any other request or render can leak it.
 */
export function consumeHostToken(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.sessionStorage,
): string | null {
  const params = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '');
  const fromHash = params.get('token');
  if (fromHash !== null && /^hrt_[A-Za-z0-9_-]+$/.test(fromHash)) {
    storage.setItem(HOST_TOKEN_STORAGE_KEY, fromHash);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return fromHash;
  }
  return storage.getItem(HOST_TOKEN_STORAGE_KEY);
}

export function storeHostToken(
  token: string,
  storage: Pick<Storage, 'setItem'> = window.sessionStorage,
): boolean {
  if (!/^hrt_[A-Za-z0-9_-]+$/.test(token.trim())) return false;
  storage.setItem(HOST_TOKEN_STORAGE_KEY, token.trim());
  return true;
}

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
}

export function createHostApi(token: string, baseUrl = ''): HostApi {
  const headers = (): HeadersInit => ({ authorization: `Bearer ${token}` });

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers(), ...init?.headers },
    });
    if (!res.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        // A proxy may answer HTML; the status still remains useful.
      }
      throw new ApiError(
        res.status,
        typeof body?.code === 'string' ? body.code : 'UNKNOWN_ERROR',
        typeof body?.message === 'string' ? body.message : res.statusText,
      );
    }
    const text = await res.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  const json = (body: unknown): RequestInit => ({
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    resolveSession: () => request('/api/host/session'),
    getRoll: (rollId) => request(`/api/host/rolls/${encodeURIComponent(rollId)}`),
    updateRoll: (rollId, patch) =>
      request(`/api/host/rolls/${encodeURIComponent(rollId)}`, json(patch)),
    async listCaptures(rollId, cursor) {
      const params = new URLSearchParams();
      if (cursor !== undefined) params.set('cursor', cursor);
      const suffix = params.size === 0 ? '' : `?${params.toString()}`;
      const page = await request<{
        items: HostCaptureView[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/api/host/rolls/${encodeURIComponent(rollId)}/captures${suffix}`);
      return { ...page, nextCursor: page.nextCursor ?? undefined };
    },
    hide: (captureId) =>
      request(`/api/host/captures/${encodeURIComponent(captureId)}/hide`, { method: 'POST' }),
    unhide: (captureId) =>
      request(`/api/host/captures/${encodeURIComponent(captureId)}/unhide`, { method: 'POST' }),
    deleteCapture: (captureId) =>
      request(`/api/host/captures/${encodeURIComponent(captureId)}`, { method: 'DELETE' }),
    regenerateSlug: (rollId) =>
      request(`/api/host/rolls/${encodeURIComponent(rollId)}/regenerate-slug`, { method: 'POST' }),
    startExport: (rollId) =>
      request(`/api/host/rolls/${encodeURIComponent(rollId)}/export`, { method: 'POST' }),
    getExport: (rollId, jobId) =>
      request(
        `/api/host/rolls/${encodeURIComponent(rollId)}/export/${encodeURIComponent(jobId)}`,
      ),
    assetUrl: (assetId) => `${baseUrl}/api/assets/${encodeURIComponent(assetId)}/content`,
    events(rollId, onEvent) {
      const controller = new AbortController();
      void keepEventStreamOpen(
        `${baseUrl}/api/host/rolls/${encodeURIComponent(rollId)}/events`,
        headers(),
        controller.signal,
        onEvent,
      );
      return () => controller.abort();
    },
  };
}

/**
 * Reconnect bounds, the same ones `hooks/useRollEvents.ts` uses for the guest
 * stream. A fixed 3 s retry hammered a down API twenty times a minute per open
 * dashboard and never backed off; a deploy or an API restart is exactly when
 * that matters.
 */
export const HOST_EVENT_RECONNECT_MIN_MS = 1_000;
export const HOST_EVENT_RECONNECT_MAX_MS = 30_000;

/**
 * The delay before the next attempt: exponential, capped, and jittered.
 *
 * The jitter is not decoration. Every host dashboard open on a roll reconnects
 * off the same event — the API going away — so without it they all come back in
 * the same instant, repeatedly.
 */
export function hostReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const backoff = Math.min(
    HOST_EVENT_RECONNECT_MIN_MS * 2 ** Math.max(0, attempt),
    HOST_EVENT_RECONNECT_MAX_MS,
  );
  // Full jitter over the window: anywhere in [backoff/2, backoff).
  return Math.round(backoff / 2 + random() * (backoff / 2));
}

async function keepEventStreamOpen(
  url: string,
  headers: HeadersInit,
  signal: AbortSignal,
  onEvent: (event: HostRollEvent) => void,
): Promise<void> {
  let lastEventId: string | undefined;
  let attempt = 0;
  while (!signal.aborted) {
    try {
      lastEventId = await readEventStream(url, headers, signal, onEvent, lastEventId);
      // The stream ran and then ended on its own (a server-side idle close),
      // which is not a failure — the next attempt starts from the short delay.
      attempt = 0;
    } catch {
      // A deploy or sleeping laptop closes the stream. The durable event id is
      // sent back on reconnect so moderation changes during the gap replay.
      attempt += 1;
    }
    if (!signal.aborted) await abortableDelay(hostReconnectDelayMs(attempt), signal);
  }
}

async function readEventStream(
  url: string,
  headers: HeadersInit,
  signal: AbortSignal,
  onEvent: (event: HostRollEvent) => void,
  resumeFrom?: string,
): Promise<string | undefined> {
  const endpoint = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.href);
  if (resumeFrom !== undefined) endpoint.searchParams.set('lastEventId', resumeFrom);
  const res = await fetch(endpoint.toString(), { headers, signal });
  if (!res.ok || res.body === null) throw new Error(`host event stream failed (${String(res.status)})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let lastEventId = resumeFrom;
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return lastEventId;
    buffer += value;
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      const id = frame
        .split('\n')
        .find((line) => line.startsWith('id: '))
        ?.slice(4);
      if (id !== undefined) lastEventId = id;
      if (data !== undefined) onEvent(JSON.parse(data) as HostRollEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }
  return lastEventId;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
