import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { KinoDatabase } from '../plugins/db';
import { purgeAfter } from './moderation';
import {
  convergeCaptureStatus,
  convergeCaptureStatuses,
  type ConvergeFailureLog,
} from '../uploads/uploads';
import { assets, captures } from '../db/schema';

/**
 * The guest feed's reader: what a capture looks like to a guest, and how the
 * gallery is walked (03 §6, 06 §11 "newest first").
 *
 * Kept out of the route file because two of the three rules here are the kind
 * that must have exactly one definition — what "visible" means (03 §11) and
 * what a cursor is — and both are read by more than one route.
 */

/* ---------------------------------------------------------------- limits -- */

export const FEED_LIMIT_DEFAULT = 50;
export const FEED_LIMIT_MIN = 1;
export const FEED_LIMIT_MAX = 100;

/** A rejected query parameter, in the shape the routes answer with. */
export interface QueryRejection {
  code: string;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: QueryRejection };

/**
 * `limit` is **clamped**, not rejected, when it is out of range: a client that
 * asks for 500 wants "as many as you will give me", and answering 100 is the
 * honest reply. A limit that is not a number at all is a different thing — a
 * typo that would silently become 50 and leave the caller wondering why its
 * page size is ignored — so that one is refused.
 */
export function parseLimit(raw: unknown): Parsed<number> {
  if (raw === undefined) return { ok: true, value: FEED_LIMIT_DEFAULT };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, error: { code: 'INVALID_LIMIT', message: 'limit must be an integer' } };
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: { code: 'INVALID_LIMIT', message: 'limit must be an integer' } };
  }
  return { ok: true, value: Math.min(Math.max(value, FEED_LIMIT_MIN), FEED_LIMIT_MAX) };
}

/* ---------------------------------------------------------------- cursor -- */

/**
 * The keyset the feed pages on: `(createdAt, id)`, newest first.
 *
 * `id` is not decoration. Captures arrive in bursts from four cameras and
 * regularly share a `createdAt` to the microsecond; a cursor on the timestamp
 * alone either repeats the whole tied group on the next page or skips the rest
 * of it. The tiebreaker makes the ordering total, which is the property keyset
 * pagination actually depends on.
 *
 * OFFSET is deliberately absent. It re-counts the rows it skips on every page —
 * so the last page of a long roll costs the most — and it shifts under
 * concurrent inserts, which for this feed is the normal case rather than an
 * edge one: photos are being uploaded while guests scroll.
 */
export interface FeedCursor {
  /**
   * `created_at::text` **as PostgreSQL rendered it**, not a JavaScript `Date`.
   *
   * This is the load-bearing detail. `timestamptz` keeps microseconds; a
   * `Date` keeps milliseconds. Round-tripping the cursor through a `Date` would
   * truncate it, and every row sharing that millisecond but not the microsecond
   * would fall on the wrong side of the comparison and vanish from the feed —
   * silently, and only for rows the server timestamped itself.
   */
  at: string;
  id: string;
}

/**
 * `2026-08-14 20:00:00.123456+00` — PostgreSQL's own rendering of a
 * `timestamptz`, with an optional fractional part and a required offset.
 *
 * The value is bound as a parameter, so this is not injection defence; it is
 * what makes a mangled cursor a 400 instead of a 500 from the driver rejecting
 * the cast.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

/** Row ids are `<prefix>_<base64url>` (see `ids.ts`). */
const CURSOR_ID = /^[a-z]+_[A-Za-z0-9_-]{1,64}$/;

const CURSOR_SEPARATOR = '|';

/**
 * Opaque to clients, and **internal**: the encoding below is not part of any
 * contract and may change without notice. Nothing is signed, because nothing
 * needs to be — a cursor grants no access, it only names a position inside a
 * feed the caller has already been authorized to read. Forging one can produce
 * a different page of the same roll and nothing else.
 */
export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(`${cursor.at}${CURSOR_SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): Parsed<FeedCursor | null> {
  if (raw === undefined) return { ok: true, value: null };

  const reject: Parsed<FeedCursor | null> = {
    ok: false,
    error: { code: 'INVALID_CURSOR', message: 'cursor is not one this feed issued' },
  };
  if (typeof raw !== 'string' || raw === '') return reject;

  // `Buffer.from` is lenient about base64: it drops characters it does not
  // recognise rather than failing, so the decoded shape is what actually
  // decides, not the decode itself.
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator < 0) return reject;

  const at = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!CURSOR_TIMESTAMP.test(at) || !CURSOR_ID.test(id)) return reject;

  return { ok: true, value: { at, id } };
}

/* ----------------------------------------------------------------- views -- */

/** What the feed says about one asset: enough to pick a tile source, no more. */
export interface CaptureAssetSummary {
  role: string;
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

export interface CaptureView {
  captureId: string;
  mode: string;
  look: string | null;
  capturedAt: Date;
  createdAt: Date;
  frameCount: number;
  resolution: string;
  status: string;
  assets: CaptureAssetSummary[];
}

export interface CaptureDetailView extends Omit<CaptureView, 'assets'> {
  assets: CaptureAssetDetail[];
}

/**
 * The host's view of a capture: the guest's fields plus the moderation state.
 *
 * 03 §11 says a hidden capture is "retained for host", and that is only true if
 * the host can *see* it. Without `visible` and `deletedAt` on the wire a hidden
 * capture would be indistinguishable from a visible one in the host's own list,
 * and `POST /unhide` would need a captureId that no endpoint returns.
 *
 * `purgeAfter` is derived here rather than left to the client: the grace period is
 * a server rule (`TRASH_GRACE_DAYS`), and a UI adding seven days itself would be a
 * second copy of it.
 */
export interface HostCaptureView extends CaptureView {
  visible: boolean;
  deletedAt: Date | null;
  /** Null unless the capture is in the trash. */
  purgeAfter: Date | null;
}

/**
 * Generic in the item type so the guest and the host page share one pagination
 * contract: `nextCursor` and `hasMore` mean the same thing in both because the
 * same keyset produces both. Defaulted, so a bare `CaptureFeedPage` still means
 * the guest page.
 */
export interface CaptureFeedPage<T = CaptureView> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The columns a guest is shown. `timing` is absent on purpose — the three skews
 * are engineering telemetry for Studio and the host (04 §14), not something the
 * gallery renders — and so is `objectKey`, which is never in a guest response at
 * all (05 §6).
 */
const captureColumns = {
  id: captures.id,
  mode: captures.mode,
  look: captures.look,
  capturedAt: captures.capturedAt,
  createdAt: captures.createdAt,
  frameCount: captures.frameCount,
  resolution: captures.resolution,
  status: captures.status,
};

/**
 * Who is reading. The only thing that differs between the two feeds.
 *
 * A flag rather than a second query function: the keyset, the cursor encoding,
 * the `limit + 1` trick and the asset join are identical for both audiences, and
 * duplicating them would let the host's list drift out of step with the guest's
 * — which is exactly the comparison a host makes when deciding whether a photo is
 * really hidden.
 */
export type FeedAudience = 'guest' | 'host';

/**
 * 03 §11, as one expression: hidden is immediate guest removal, and a deleted
 * capture is in its trash grace period. Both are invisible to a guest; only the
 * second is invisible to the host.
 *
 * A host therefore sees **everything** the roll holds, trash included, and the
 * view carries the flags that say which is which. That is what "retained for
 * host" means — anything less makes the retention unobservable.
 */
function visibleTo(audience: FeedAudience, rollId: string): SQL | undefined {
  const owned = eq(captures.rollId, rollId);
  if (audience === 'host') return owned;
  return and(owned, eq(captures.visible, true), isNull(captures.deletedAt));
}

/**
 * Only `ready` assets are ever named. A pending row is a location that has no
 * bytes at it yet, so handing a guest its id would produce a tile that 409s on
 * every fetch until a worker finishes.
 */
async function readReadyAssets(
  db: KinoDatabase,
  captureIds: readonly string[],
): Promise<Map<string, CaptureAssetDetail[]>> {
  const byCapture = new Map<string, CaptureAssetDetail[]>();
  if (captureIds.length === 0) return byCapture;

  // One query for the whole page rather than one per capture: a 100-row page
  // would otherwise be 101 round trips.
  const rows = await db
    .select({
      captureId: assets.captureId,
      assetId: assets.id,
      role: assets.role,
      width: assets.width,
      height: assets.height,
      mime: assets.mime,
      bytes: assets.bytes,
      frameIndex: assets.frameIndex,
    })
    .from(assets)
    .where(and(inArray(assets.captureId, [...captureIds]), eq(assets.status, 'ready')))
    // Deterministic order, so a client diffing two responses sees no churn.
    .orderBy(assets.role, assets.frameIndex);

  for (const row of rows) {
    const list = byCapture.get(row.captureId) ?? [];
    list.push({
      role: row.role,
      assetId: row.assetId,
      frameIndex: row.frameIndex,
      width: row.width,
      height: row.height,
      mime: row.mime,
      bytes: row.bytes,
    });
    byCapture.set(row.captureId, list);
  }
  return byCapture;
}

function summarise(asset: CaptureAssetDetail): CaptureAssetSummary {
  return {
    role: asset.role,
    assetId: asset.assetId,
    frameIndex: asset.frameIndex,
    width: asset.width,
    height: asset.height,
  };
}

/** A row as both page readers select it. */
interface CaptureRow {
  id: string;
  mode: string;
  look: string | null;
  capturedAt: Date;
  createdAt: Date;
  frameCount: number;
  resolution: string;
  status: string;
  visible: boolean;
  deletedAt: Date | null;
  cursorAt: string;
}

/**
 * One page of a roll's captures, newest first, for either audience.
 *
 * `limit + 1` rows are read and the extra one dropped: it answers `hasMore`
 * exactly, with no second COUNT query and no lying about the last page.
 *
 * `visible` and `deleted_at` are always selected. They are two columns on a row
 * the query already reads, so it costs nothing and keeps one select list instead
 * of one per audience — the guest mapper simply never puts them on the wire.
 */
async function readPage(
  db: KinoDatabase,
  rollId: string,
  limit: number,
  cursor: FeedCursor | null,
  audience: FeedAudience,
): Promise<{ rows: CaptureRow[]; nextCursor: string | null; hasMore: boolean }> {
  const rows = await db
    .select({
      ...captureColumns,
      visible: captures.visible,
      deletedAt: captures.deletedAt,
      // The cursor's half of the keyset, at full PostgreSQL precision.
      cursorAt: sql<string>`${captures.createdAt}::text`,
    })
    .from(captures)
    .where(
      and(
        visibleTo(audience, rollId),
        cursor === null
          ? undefined
          : // A row comparison, which is what makes this a single index-ordered
            // seek rather than the `a < x OR (a = x AND b < y)` expansion.
            sql`(${captures.createdAt}, ${captures.id}) < (${cursor.at}::timestamptz, ${cursor.id})`,
      ),
    )
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      hasMore && last !== undefined ? encodeCursor({ at: last.cursorAt, id: last.id }) : null,
    hasMore,
  };
}

/**
 * The fields both audiences get. Never `visible` or `deletedAt`.
 *
 * `status` is taken from `converged` when the page's convergence pass moved it,
 * and from the row otherwise. Both feeds go through here, so neither can forget
 * to report the fresh value.
 */
function sharedFields(row: CaptureRow, converged: Map<string, string>): Omit<CaptureView, 'assets'> {
  return {
    captureId: row.id,
    mode: row.mode,
    look: row.look,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
    frameCount: row.frameCount,
    resolution: row.resolution,
    status: converged.get(row.id) ?? row.status,
  };
}

/** One page of the guest gallery (03 §6, 06 §11). */
export async function readCaptureFeedPage(
  db: KinoDatabase,
  rollId: string,
  limit: number,
  cursor: FeedCursor | null,
  onConvergeFailure?: ConvergeFailureLog,
): Promise<CaptureFeedPage<CaptureView>> {
  const { rows, nextCursor, hasMore } = await readPage(db, rollId, limit, cursor, 'guest');
  // Convergence before the asset read, not after: a recompute can only be
  // triggered by asset and job rows that already exist, so reading the assets
  // second means the tiles and the status describe the same moment.
  const converged = await convergeCaptureStatuses(db, rows, onConvergeFailure);
  const assetsByCapture = await readReadyAssets(
    db,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) => ({
      ...sharedFields(row, converged),
      assets: (assetsByCapture.get(row.id) ?? []).map(summarise),
    })),
    nextCursor,
    hasMore,
  };
}

/**
 * One page of the host's own list: the same roll, including hidden captures and
 * the trash (03 §10, §11).
 *
 * Same pagination as the guest feed, so a host UI needs no second cursor
 * implementation, and the item is the guest item plus `visible`, `deletedAt` and
 * the derived `purgeAfter`. This is the endpoint that makes `POST /unhide`
 * reachable at all — a hidden capture's id appears nowhere else on the API.
 */
export async function readHostCaptureFeedPage(
  db: KinoDatabase,
  rollId: string,
  limit: number,
  cursor: FeedCursor | null,
  onConvergeFailure?: ConvergeFailureLog,
): Promise<CaptureFeedPage<HostCaptureView>> {
  const { rows, nextCursor, hasMore } = await readPage(db, rollId, limit, cursor, 'host');
  const converged = await convergeCaptureStatuses(db, rows, onConvergeFailure);
  const assetsByCapture = await readReadyAssets(
    db,
    rows.map((row) => row.id),
  );

  return {
    items: rows.map((row) => ({
      ...sharedFields(row, converged),
      assets: (assetsByCapture.get(row.id) ?? []).map(summarise),
      visible: row.visible,
      deletedAt: row.deletedAt,
      purgeAfter: row.deletedAt === null ? null : purgeAfter(row.deletedAt),
    })),
    nextCursor,
    hasMore,
  };
}

/**
 * One capture, or null.
 *
 * The roll id is part of the WHERE rather than checked afterwards, so a capture
 * id from another roll is indistinguishable from one that does not exist. That
 * is the point: without it this route would confirm, for any id a caller cares
 * to try, whether it belongs to some roll somewhere.
 */
export async function readCaptureDetail(
  db: KinoDatabase,
  rollId: string,
  captureId: string,
  onConvergeFailure?: ConvergeFailureLog,
): Promise<CaptureDetailView | null> {
  const [row] = await db
    .select(captureColumns)
    .from(captures)
    .where(and(visibleTo('guest', rollId), eq(captures.id, captureId)))
    .limit(1);
  if (row === undefined) return null;

  const status = await convergeCaptureStatus(db, row.id, row.status, onConvergeFailure);
  const assetsByCapture = await readReadyAssets(db, [row.id]);
  return {
    captureId: row.id,
    mode: row.mode,
    look: row.look,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
    frameCount: row.frameCount,
    resolution: row.resolution,
    status,
    assets: assetsByCapture.get(row.id) ?? [],
  };
}
