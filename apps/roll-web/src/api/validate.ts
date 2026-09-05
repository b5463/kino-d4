import { ASSET_ROLES } from '@kino/schemas';
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
 * piece of it that applies here is the `ASSET_ROLES` enum. Everything else is
 * checked by hand against the wire types in `client.ts`.
 *
 * The bar is "will the page render it without throwing", not "is every field
 * exactly right": a wrong string in `mode` shows an odd tile, a missing
 * `assets` array takes the whole feed down. Unknown asset roles are dropped
 * from the capture rather than failing it — a new derivative must not blank a
 * photograph.
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

function playbackOf(value: unknown): CapturePlayback | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const playback: CapturePlayback = {};
  if (value.fps !== undefined) {
    if (!isFiniteNumber(value.fps)) return undefined;
    playback.fps = value.fps;
  }
  if (value.loop !== undefined) {
    if (value.loop !== 'bounce' && value.loop !== 'continuous' && value.loop !== 'sweep') return undefined;
    playback.loop = value.loop;
  }
  if (value.direction !== undefined) {
    if (value.direction !== 'ltr' && value.direction !== 'rtl') return undefined;
    playback.direction = value.direction;
  }
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
  if (playback === undefined) return null;
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
  nextCursor: string | undefined;
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
    nextCursor: isString(value.nextCursor) ? value.nextCursor : undefined,
    hasMore: value.hasMore === true,
  };
}
