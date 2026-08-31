import { ASSET_ROLES } from '@kino/schemas';

/**
 * The typed client the guest feed, capture detail and PIN gate are built
 * against.
 *
 * Every shape here mirrors what the API actually sends on the wire — never
 * guessed. The routes are `apps/api/src/routes/guest-rolls.ts` (the roll),
 * `guest-captures.ts` (the feed, one capture, reactions, render requests) and
 * `assets.ts` (asset content); the response shapes they return come from
 * `apps/api/src/rolls/rolls.ts` and `apps/api/src/captures/feed.ts`, which are
 * NOT under `routes/`. These are not the storage-side `@kino/schemas`
 * envelopes, which describe a different thing (a versioned persisted record,
 * not a guest response). The one piece of `@kino/schemas` reused here is the
 * `ASSET_ROLES` enum: an asset's `role` on the guest wire is the same string
 * that schema already names, so re-typing it by hand here would just be a
 * second copy that can drift.
 *
 * `Date` never appears below. Every timestamp crosses the wire as whatever
 * `JSON.stringify(Date)` produces — an ISO 8601 string — and this client keeps
 * it a string. Parsing it back into a `Date` is a presentation decision for
 * whichever component renders it, not something the client should decide once
 * for every caller.
 */

/** An asset role, taken from the one enum the guest feed and `@kino/schemas` share. */
export type AssetRole = (typeof ASSET_ROLES)[number];

/** `GET /api/rolls/:slug` — see `apps/api/src/rolls/rolls.ts#guestRollView`. */
export interface RollView {
  title: string;
  status: string;
  photoCount: number;
  downloadsEnabled: boolean;
  reactionsEnabled: boolean;
  createdAt: string;
  closedAt: string | null;
}

/** What the feed says about one asset: enough to pick a tile source, no more. */
export interface CaptureAssetSummary {
  role: AssetRole;
  assetId: string;
  frameIndex: number | null;
  width: number | null;
  height: number | null;
}

/** The detail view adds what a download control needs to label itself. */
export interface CaptureAssetDetail extends CaptureAssetSummary {
  mime: string;
  bytes: number | null;
}

/** The host's playback choice for one capture, in the KDP vocabulary. The
 * loop word is mapped through `kdpLoopToMediaLoop` before it reaches the
 * player — KDP's `sweep` is the player's `once`. */
export interface CapturePlayback {
  fps?: number;
  loop?: 'bounce' | 'continuous' | 'sweep';
  direction?: 'ltr' | 'rtl';
}

/** One item of `GET /api/rolls/:slug/captures` — see `apps/api/src/captures/feed.ts#CaptureView`. */
export interface CaptureView {
  captureId: string;
  mode: string;
  look: string | null;
  capturedAt: string;
  createdAt: string;
  frameCount: number;
  resolution: string;
  status: string;
  /** Null means the player's defaults. */
  playback: CapturePlayback | null;
  assets: CaptureAssetSummary[];
}

/** `GET /api/rolls/:slug/captures/:captureId` — the assets carry `mime`/`bytes`. */
export interface CaptureDetail extends Omit<CaptureView, 'assets'> {
  assets: CaptureAssetDetail[];
  reactionCount: number;
  reacted: boolean;
}

/** A page of the guest feed, exactly as `RollApi.listCaptures` promises it. */
export interface CaptureFeedPage {
  items: CaptureView[];
  nextCursor?: string;
  hasMore: boolean;
}

/** The `{code, message}` body every API error answers with (`routes/errors.ts`). */
interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
}

/**
 * A non-2xx response the client cannot make sense of any other way.
 *
 * `code` is the API's own error code (`ROLL_NOT_FOUND`, `INVALID_PIN`, ...)
 * when the body parsed as one, so a caller that cares can branch on it without
 * this client growing a subclass for every code the API might ever add.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isNoRollError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'ROLL_NOT_FOUND';
}

export function isMissingCaptureError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'CAPTURE_NOT_FOUND';
}

/**
 * `getRoll` throws this instead of a bare `ApiError` on a 401 `PIN_REQUIRED`,
 * so Task 30's PIN gate can route on `instanceof` rather than string-matching
 * an error code buried in a generic failure.
 */
export class PinRequiredError extends Error {
  constructor(
    public readonly slug: string,
    message = 'this roll is PIN protected',
  ) {
    super(message);
    this.name = 'PinRequiredError';
  }
}

/** The contract Tasks 27-31 are written against. */
export interface RollApi {
  getRoll(slug: string): Promise<RollView>;
  submitPin(slug: string, pin: string): Promise<void>;
  listCaptures(slug: string, cursor?: string): Promise<CaptureFeedPage>;
  getCapture(slug: string, id: string): Promise<CaptureDetail>;
  /**
   * `options.download` appends `?download=1` (`wantsDownload` in
   * `apps/api/src/captures/delivery.ts`), which asks the API for `Content-Disposition:
   * attachment` instead of the default inline response. An optional second
   * parameter, so the pinned single-argument signature Tasks 27-29 were
   * already written against keeps working unchanged.
   */
  assetUrl(assetId: string, options?: { download?: boolean }): string;
  react(slug: string, captureId: string): Promise<void>;
  /**
   * `POST .../renders` — asks the platform to produce a derivative it renders
   * lazily (`wiggle-mp4`, the social crops). Answers 202; the finished asset
   * arrives through the same `processing.completed` SSE path every other
   * derivative uses.
   */
  requestRender(slug: string, captureId: string, role: AssetRole): Promise<void>;
  events(slug: string, lastEventId?: string): EventSource;
}

/** Named per 03§7 / `routes/guest-events.ts` — never delivered through `onmessage`. */
const ROLL_EVENT_TYPES = [
  'roll.opened',
  'roll.closed',
  'capture.created',
  'capture.updated',
  'capture.hidden',
  'capture.deleted',
  'processing.completed',
] as const;

async function readErrorBody(res: Response): Promise<ApiErrorBody | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as ApiErrorBody) : null;
  } catch {
    return null;
  }
}

function errorCode(body: ApiErrorBody | null): string {
  return typeof body?.code === 'string' ? body.code : 'UNKNOWN_ERROR';
}

function errorMessage(body: ApiErrorBody | null, fallback: string): string {
  return typeof body?.message === 'string' ? body.message : fallback;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

/**
 * The one place a 401 becomes a `PinRequiredError`.
 *
 * `listCaptures`, `getCapture` and `getRoll` all sit behind the same
 * `guestRollAccess` preHandler and all answer `PIN_REQUIRED` once a host
 * rotates the roll's PIN mid-visit — the cookie every earlier request relied
 * on stops working immediately, not at the next page load. Checking here
 * once, rather than in each caller, is what makes that true everywhere Task
 * 30's PIN gate needs to catch it, not just on the roll's first load.
 *
 * `slug` is optional because `submitPin`'s own 401 (`INVALID_PIN`) is a
 * different failure — a wrong PIN, not a missing one — and never reaches
 * this branch regardless.
 */
async function requestJson<T>(input: string, init?: RequestInit, slug?: string): Promise<T> {
  const res = await fetch(input, { ...init, credentials: 'include' });

  if (res.status === 401) {
    const body = await readErrorBody(res);
    if (errorCode(body) === 'PIN_REQUIRED') {
      throw new PinRequiredError(slug ?? '', errorMessage(body, 'this roll is PIN protected'));
    }
    throw new ApiError(401, errorCode(body), errorMessage(body, 'unauthorized'));
  }

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new ApiError(res.status, errorCode(body), errorMessage(body, res.statusText));
  }

  // A 2xx with an empty body (e.g. a bare 204, or a stub in a test) is not a
  // JSON parse failure — `res.json()` on an empty string throws, which would
  // otherwise turn "nothing to report" into a confusing SyntaxError.
  const text = await res.text();
  if (text === '') return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Builds a `RollApi` against `baseUrl` (default: same origin — the production
 * layout puts roll-web and the API behind one host, see infra §Workstream 9).
 *
 * A factory rather than a bare singleton so tests can point a fresh instance
 * at a mocked `fetch` without reaching for module-reset tricks, and so a
 * future deployment with the API on a different origin has somewhere to pass
 * that in.
 */
export function createRollApi(baseUrl = ''): RollApi {
  // One stored id per roll slug, used only to resume `events()` after this
  // page reloads (a fresh EventSource has forgotten it) and to self-correct
  // if that resume attempt turns out to be stale. Never sent anywhere except
  // back to the API that issued it.
  const lastEventIds = new Map<string, string>();

  return {
    async getRoll(slug) {
      return requestJson<RollView>(
        joinUrl(baseUrl, `/api/rolls/${encodeURIComponent(slug)}`),
        undefined,
        slug,
      );
    },

    async submitPin(slug, pin) {
      await requestJson(joinUrl(baseUrl, `/api/rolls/${encodeURIComponent(slug)}/pin`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
    },

    async listCaptures(slug, cursor) {
      const params = new URLSearchParams();
      // `cursor` is opaque and round-tripped exactly as received — never
      // decoded, re-encoded, or otherwise touched. See
      // `apps/api/src/captures/feed.ts#decodeCursor` for why: its encoding is
      // an internal detail this client has no business depending on.
      if (cursor !== undefined) params.set('cursor', cursor);
      // `limit` is not exposed yet — the brief's `RollApi` shape names only
      // `(slug, cursor?)`, and the API defaults to `FEED_LIMIT_DEFAULT` (50)
      // on its own. A future task can add an optional third parameter if a
      // page size other than the default turns out to be needed.
      const qs = params.toString();

      const data = await requestJson<{
        items: CaptureView[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(
        joinUrl(
          baseUrl,
          `/api/rolls/${encodeURIComponent(slug)}/captures${qs === '' ? '' : `?${qs}`}`,
        ),
        undefined,
        slug,
      );

      return {
        items: data.items,
        nextCursor: data.nextCursor ?? undefined,
        hasMore: data.hasMore,
      };
    },

    async getCapture(slug, id) {
      return requestJson<CaptureDetail>(
        joinUrl(
          baseUrl,
          `/api/rolls/${encodeURIComponent(slug)}/captures/${encodeURIComponent(id)}`,
        ),
        undefined,
        slug,
      );
    },

    assetUrl(assetId, options) {
      // The API path, not a presigned URL: the browser follows the 302 from
      // `GET /api/assets/:id/content` itself. Fetching and blobbing this would
      // throw the presign's short expiry and its cache-control away for
      // nothing.
      const path = `/api/assets/${encodeURIComponent(assetId)}/content`;
      return joinUrl(baseUrl, options?.download === true ? `${path}?download=1` : path);
    },

    async requestRender(slug, captureId, role) {
      await requestJson(
        joinUrl(
          baseUrl,
          `/api/rolls/${encodeURIComponent(slug)}/captures/${encodeURIComponent(captureId)}/renders`,
        ),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role }),
        },
        slug,
      );
    },

    async react(slug, captureId) {
      await requestJson(
        joinUrl(
          baseUrl,
          `/api/rolls/${encodeURIComponent(slug)}/captures/${encodeURIComponent(captureId)}/react`,
        ),
        { method: 'POST' },
        slug,
      );
    },

    events(slug, lastEventId) {
      const resumeFrom = lastEventId ?? lastEventIds.get(slug);
      if (resumeFrom !== undefined) lastEventIds.set(slug, resumeFrom);
      else lastEventIds.delete(slug);

      const url = new URL(
        joinUrl(baseUrl, `/api/rolls/${encodeURIComponent(slug)}/events`),
        // A relative `baseUrl` (the common case — same origin as this page)
        // needs a base to resolve against; `window.location.href` supplies
        // exactly the origin `fetch` above already assumes implicitly. There
        // is no `window` under the test runner, so fall back to a dummy
        // origin there — nothing reads it, `EventSource` gets the full
        // string either way.
        typeof window === 'undefined' ? 'http://localhost' : window.location.href,
      );
      // Native EventSource cannot set a `Last-Event-ID` header on a first
      // connection — only the browser's own automatic reconnect does that —
      // so a resume from a stored id has to travel as a query parameter, which
      // `guest-events.ts#requestedLastEventId` accepts for exactly this reason.
      if (resumeFrom !== undefined) url.searchParams.set('lastEventId', resumeFrom);

      const source = new EventSource(url.toString(), { withCredentials: true });

      // Whether this connection ever reached OPEN. A genuine
      // `INVALID_LAST_EVENT_ID` (400) is answered before a single frame is
      // written, so a rejected resume never opens at all — it goes straight
      // to a hard close. Everything else that can hard-close an already-open
      // stream (the host rotates the PIN, the roll gets deleted, a 502
      // during a deploy) says nothing about whether the stored id itself was
      // bad, and must not be treated as if it did: `resumeFrom` alone is
      // "this connection started from a stored id", not "this connection
      // died BECAUSE of it" — conflating the two would delete a current,
      // valid id on every unrelated disconnect and silently lose the
      // replay for the gap that follows.
      let opened = false;
      source.addEventListener('open', () => {
        opened = true;
      });

      // The events are NAMED (`event: capture.created`, ...); `onmessage`
      // never fires for a named event, so tracking the latest id delivered —
      // for the next reload's resume — has to go through `addEventListener`
      // per type. One listener per name rather than a generic fallback: that
      // is the only API a named SSE stream offers.
      for (const type of ROLL_EVENT_TYPES) {
        source.addEventListener(type, (event) => {
          const id = (event as MessageEvent).lastEventId;
          if (id) lastEventIds.set(slug, id);
        });
      }

      source.addEventListener('error', () => {
        // Only a resume attempt (`resumeFrom` set) that hard-closed WITHOUT
        // ever opening looks like `INVALID_LAST_EVENT_ID` from here — native
        // EventSource never surfaces the status code itself. Clearing the
        // stored id in that one case lets the next attempt fall back to
        // live instead of wedging on the same rejected id forever.
        if (resumeFrom !== undefined && !opened && source.readyState === EventSource.CLOSED) {
          lastEventIds.delete(slug);
        }
      });

      return source;
    },
  };
}

/** The instance every route in this app shares — same origin as this page. */
export const rollApi: RollApi = createRollApi();
