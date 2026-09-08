import { ASSET_ROLES } from './roles';
import type {
  AssetRole,
  CaptureAssetDetail,
  CaptureAssetSummary,
  CaptureDetail,
  CapturePlayback,
  CaptureView,
} from './client';

/**
 * Shape checks for what the guest API sends. `@kino/schemas` describes the
 * STORED capture and asset (`kino.capture`, `kino.asset`: versioned envelopes
 * with `id`, `captureUuid`, `deviceId`), not the guest wire view, so the only
 * piece of it that applies here is the asset role list (`./roles`). Everything
 * else is checked by hand against the wire types in `client.ts`.
 *
 * The bar is "will the page render it without throwing", not "is every field
 * exactly right": a wrong string in `mode` shows an odd tile, a missing
 * `assets` array takes the whole feed down.
 *
 * Two forward-compatible holes on purpose, and they are the same hole:
 *
 *  - an unknown asset ROLE drops that asset and keeps the capture, because a
 *    new derivative must not blank a photograph;
 *  - an unusable PLAYBACK value drops that value and keeps the capture, for
 *    exactly the same reason. It did not: a `null` fps (which JSON produces
 *    for an unrecorded rate) or any loop word this build has not heard of made
 *    the whole capture parse to nothing — dropped from the feed with a console
 *    warning, and `getCapture` threw, so the capture page could not open at
 *    all. Playback only ever decides how a wigglegram is animated, and the
 *    player has defaults for every part of it.
 */

const ROLE_SET: ReadonlySet<string> = new Set(ASSET_ROLES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The host's playback choice, with anything unusable left out.
 *
 * Never fails the capture. Each of the three keys is optional on the wire and
 * absent means "the player's default", so a value this build cannot use is
 * indistinguishable from one that was never sent — and a photograph is worth
 * more than a frame rate. `playback` itself being something other than an
 * object (a string, an array) is the one case that yields no playback at all,
 * which is still `null`, still the defaults, still the photograph.
 */
function playbackOf(value: unknown): CapturePlayback | null {
  if (value === null || value === undefined || !isRecord(value)) return null;
  const playback: CapturePlayback = {};
  // `null` is what JSON carries for an unrecorded rate, and it used to be the
  // single most likely way to lose a capture entirely.
  if (isFiniteNumber(value.fps)) playback.fps = value.fps;
  if (value.loop === 'bounce' || value.loop === 'continuous' || value.loop === 'sweep') {
    playback.loop = value.loop;
  }
  if (value.direction === 'ltr' || value.direction === 'rtl') playback.direction = value.direction;
  return playback;
}

/** One asset as the feed lists it, or `null` when it cannot be used. */
function assetSummaryOf(value: unknown): CaptureAssetSummary | null | 'skip' {
  if (!isRecord(value)) return null;
  if (!isString(value.role)) return null;
  if (!ROLE_SET.has(value.role)) return 'skip';
  if (!isString(value.assetId) || value.assetId === '') return null;
  const frameIndex = value.frameIndex ?? null;
  const width = value.width ?? null;
  const height = value.height ?? null;
  if (!isNullableNumber(frameIndex) || !isNullableNumber(width) || !isNullableNumber(height)) return null;
  return { role: value.role as AssetRole, assetId: value.assetId, frameIndex, width, height };
}

function assetDetailOf(value: unknown): CaptureAssetDetail | null | 'skip' {
  const summary = assetSummaryOf(value);
  if (summary === null || summary === 'skip') return summary;
  const record = value as Record<string, unknown>;
  if (!isString(record.mime)) return null;
  const bytes = record.bytes ?? null;
  if (!isNullableNumber(bytes)) return null;
  return { ...summary, mime: record.mime, bytes };
}

function assetsOf<T>(value: unknown, one: (item: unknown) => T | null | 'skip'): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = one(item);
    if (parsed === null) return null;
    if (parsed !== 'skip') out.push(parsed);
  }
  return out;
}

function captureBaseOf(value: unknown): Omit<CaptureView, 'assets'> | null {
  if (!isRecord(value)) return null;
  if (!isString(value.captureId) || value.captureId === '') return null;
  if (!isString(value.mode) || !isString(value.capturedAt) || !isString(value.status)) return null;
  if (!isFiniteNumber(value.frameCount)) return null;
  const playback = playbackOf(value.playback);
  const look = value.look ?? null;
  if (look !== null && !isString(look)) return null;
  return {
    captureId: value.captureId,
    mode: value.mode,
    look,
    capturedAt: value.capturedAt,
    // The API always sends both; a missing createdAt is not worth a blank tile.
    createdAt: isString(value.createdAt) ? value.createdAt : value.capturedAt,
    frameCount: value.frameCount,
    resolution: isString(value.resolution) ? value.resolution : '',
    status: value.status,
    playback,
  };
}

/** A feed item, or `null` when the page must drop it. */
export function parseCaptureView(value: unknown): CaptureView | null {
  const base = captureBaseOf(value);
  if (base === null) return null;
  const assets = assetsOf((value as Record<string, unknown>).assets, assetSummaryOf);
  if (assets === null) return null;
  return { ...base, assets };
}

/** One capture's detail, or `null` when it cannot be shown. */
export function parseCaptureDetail(value: unknown): CaptureDetail | null {
  const base = captureBaseOf(value);
  if (base === null) return null;
  const record = value as Record<string, unknown>;
  const assets = assetsOf(record.assets, assetDetailOf);
  if (assets === null) return null;
  const reactionCount = record.reactionCount ?? 0;
  if (!isFiniteNumber(reactionCount)) return null;
  return { ...base, assets, reactionCount, reacted: record.reacted === true };
}

/**
 * A feed page: malformed items are dropped and the rest kept, with one
 * warning per page naming how many went. A broken row is one photograph
 * missing, never a blank roll.
 */
export function parseFeedPage(value: unknown): {
  items: CaptureView[];
  nextCursor: string | null;
  hasMore: boolean;
} | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items: CaptureView[] = [];
  let dropped = 0;
  for (const item of value.items) {
    const parsed = parseCaptureView(item);
    if (parsed === null) dropped += 1;
    else items.push(parsed);
  }
  if (dropped > 0) {
    console.warn(`roll feed: dropped ${String(dropped)} malformed capture${dropped === 1 ? '' : 's'} from one page`);
  }
  return {
    items,
    nextCursor: isString(value.nextCursor) ? value.nextCursor : null,
    hasMore: value.hasMore === true,
  };
}
