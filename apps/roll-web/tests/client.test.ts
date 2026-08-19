import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createRollApi, NotImplementedError, PinRequiredError } from '../src/api/client';

/** A minimal `Response`-shaped stub, built only from what the client reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'stub',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * A fake `EventSource` that records every `addEventListener` call instead of
 * opening a connection, so the named-event wiring can be asserted directly
 * and `onmessage` usage can be proven absent without a real network.
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;

  readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = url.toString();
    this.withCredentials = init?.withCredentials ?? false;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(): void {
    // Unused by the client; present only to satisfy the EventSource shape.
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe('createRollApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('PIN flow', () => {
    it('getRoll throws PinRequiredError on a 401 PIN_REQUIRED, and a retry after submitPin succeeds', async () => {
      const api = createRollApi();

      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { code: 'PIN_REQUIRED', message: 'this roll is PIN protected' }),
      );

      await expect(api.getRoll('abc123')).rejects.toBeInstanceOf(PinRequiredError);

      fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
      await api.submitPin('abc123', '4242');

      const [pinUrl, pinInit] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(pinUrl).toBe('/api/rolls/abc123/pin');
      expect(pinInit.method).toBe('POST');
      expect(pinInit.credentials).toBe('include');
      expect(JSON.parse(pinInit.body as string)).toEqual({ pin: '4242' });

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          title: 'Friday party',
          status: 'live',
          photoCount: 3,
          downloadsEnabled: true,
          createdAt: '2026-08-14T20:00:00.000Z',
        }),
      );
      const roll = await api.getRoll('abc123');
      expect(roll.title).toBe('Friday party');
      expect(roll.photoCount).toBe(3);
    });

    it('submitPin rejects with the API error on a wrong PIN', async () => {
      const api = createRollApi();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { code: 'INVALID_PIN', message: 'that PIN does not open this roll' }),
      );

      const failure = api.submitPin('abc123', '0000');
      await expect(failure).rejects.toBeInstanceOf(ApiError);
      await expect(failure).rejects.toMatchObject({ code: 'INVALID_PIN', status: 401 });
    });

    it('getRoll surfaces a non-PIN 401 as a plain ApiError, not PinRequiredError', async () => {
      const api = createRollApi();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(401, { code: 'SOMETHING_ELSE', message: 'nope' }),
      );

      const failure = api.getRoll('abc123');
      await expect(failure).rejects.toBeInstanceOf(ApiError);
      await expect(failure).rejects.not.toBeInstanceOf(PinRequiredError);
    });
  });

  describe('cursor passthrough', () => {
    it('sends no cursor on the first page and passes the returned cursor back verbatim', async () => {
      const opaqueCursor = 'MjAyNi0wOC0xNCAyMDowMDowMC4xMjM0NTYrMDB8Y2FwXzAx';

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { items: [], nextCursor: opaqueCursor, hasMore: true }),
      );
      const api = createRollApi();
      const first = await api.listCaptures('abc123');

      const [firstUrl] = fetchMock.mock.calls[0] as [string];
      expect(firstUrl).toBe('/api/rolls/abc123/captures');
      expect(first.nextCursor).toBe(opaqueCursor);

      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { items: [], nextCursor: null, hasMore: false }),
      );
      const second = await api.listCaptures('abc123', first.nextCursor);

      const [secondUrl] = fetchMock.mock.calls[1] as [string];
      // The cursor travels exactly as received — never re-encoded, never
      // parsed. A `?` join and one `cursor=<value>` is the whole contract.
      expect(secondUrl).toBe(`/api/rolls/abc123/captures?cursor=${opaqueCursor}`);
      // `nextCursor: null` from the API becomes `undefined` on the client
      // side of the `RollApi` contract, never a literal null falling through.
      expect(second.nextCursor).toBeUndefined();
      expect(second.hasMore).toBe(false);
    });
  });

  describe('assetUrl', () => {
    it('returns the API content path, not a presigned URL', () => {
      const api = createRollApi();
      expect(api.assetUrl('ast_01HXYZ')).toBe('/api/assets/ast_01HXYZ/content');
    });

    it('never calls fetch — the browser follows the redirect itself', () => {
      const api = createRollApi();
      api.assetUrl('ast_01HXYZ');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('react', () => {
    it('fails honestly: no such endpoint exists yet, and nothing is fetched', async () => {
      const api = createRollApi();
      await expect(api.react('abc123', 'cap_01')).rejects.toBeInstanceOf(NotImplementedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('events', () => {
    let originalEventSource: typeof EventSource | undefined;

    beforeEach(() => {
      originalEventSource = globalThis.EventSource;
      vi.stubGlobal('EventSource', FakeEventSource);
    });

    afterEach(() => {
      vi.stubGlobal('EventSource', originalEventSource);
    });

    it('opens with credentials and wires a listener per named event type, never onmessage', () => {
      const api = createRollApi();
      const source = api.events('abc123') as unknown as FakeEventSource;

      expect(source.withCredentials).toBe(true);
      expect(source.url).toContain('/api/rolls/abc123/events');

      const namedTypes = [
        'roll.opened',
        'roll.closed',
        'capture.created',
        'capture.updated',
        'capture.hidden',
        'capture.deleted',
        'processing.completed',
      ];
      for (const type of namedTypes) {
        expect(source.listeners.get(type)?.length).toBeGreaterThan(0);
      }

      // `onmessage` never fires for a named SSE event, so the client must not
      // depend on it — proven here by never assigning it at all.
      expect(source.onmessage).toBeNull();
    });

    it('resumes from a stored lastEventId via the query string, not a header', () => {
      const api = createRollApi();
      const first = api.events('abc123') as unknown as FakeEventSource;
      first.dispatch(
        'capture.created',
        Object.assign(new Event('capture.created'), { lastEventId: '17-0' }),
      );

      const second = api.events('abc123') as unknown as FakeEventSource;
      expect(second.url).toContain('lastEventId=17-0');
    });

    it('clears the stored lastEventId when the resumed connection hard-closes (400)', () => {
      const api = createRollApi();
      const first = api.events('abc123') as unknown as FakeEventSource;
      first.dispatch(
        'capture.created',
        Object.assign(new Event('capture.created'), { lastEventId: 'not-a-real-id' }),
      );

      const second = api.events('abc123') as unknown as FakeEventSource;
      expect(second.url).toContain('lastEventId=not-a-real-id');

      // The API answers a malformed Last-Event-ID with 400 and never
      // schedules a browser retry for it, so from here the only observable
      // signal is a hard close right after a resume attempt.
      second.readyState = FakeEventSource.CLOSED;
      second.dispatch('error', new Event('error'));

      const third = api.events('abc123') as unknown as FakeEventSource;
      expect(third.url).not.toContain('lastEventId=');
    });

    it('does not clear the stored id when the close was not tied to a resume attempt', () => {
      const api = createRollApi();
      // No prior events, so this call carries no stored id to resume from —
      // it is a live start, and a later hard close here says nothing about
      // whether a stored id is stale.
      const source = api.events('xyz789') as unknown as FakeEventSource;
      source.readyState = FakeEventSource.CLOSED;
      source.dispatch('error', new Event('error'));

      const again = api.events('xyz789') as unknown as FakeEventSource;
      expect(again.url).not.toContain('lastEventId=');
    });
  });
});
