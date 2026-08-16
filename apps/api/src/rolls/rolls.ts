import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config';
import type { KinoDatabase } from '../plugins/db';
import type { PublicRollRow } from '../auth/plugins';
import { newToken } from '../auth/tokens';
import { hashPin } from '../auth/pins';
import { newId } from '../ids';
import { auditEvents, rolls } from '../db/schema';
import type { RollCaptureCounts } from '../uploads/uploads';
import { newSlug } from './slug';

/**
 * Roll lifecycle rules, in one place, so the three route files (device, host,
 * guest) share a single definition of what a roll *is* rather than three
 * drifting ones.
 */

/* ------------------------------------------------------------------ URLs -- */

/** `PUBLIC_BASE_URL` with any trailing slash removed, so joining never doubles it. */
function base(config: ApiConfig): string {
  return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
}

/** The link a host hands to guests — a QR code's payload (03 §26). */
export function guestUrlFor(config: ApiConfig, slug: string): string {
  return `${base(config)}/r/${slug}`;
}

/**
 * The host's own deep link. The token rides in the **fragment**, not the query
 * string: a fragment is never sent to the server, so it stays out of access
 * logs, out of `Referer` headers, and out of any proxy in between. The host web
 * app reads it once and keeps it locally.
 *
 * This is the only place the plaintext host token is ever assembled into a URL,
 * and it happens exactly once per roll — in the creation response.
 */
export function hostUrlFor(config: ApiConfig, hostToken: string): string {
  return `${base(config)}/host#token=${hostToken}`;
}

/* -------------------------------------------------------- the upload gate -- */

/**
 * A closed roll accepts no new uploads; its gallery stays readable (03 §22).
 *
 * Thrown by `assertRollAcceptsUploads`. `statusCode` and `code` are the two
 * properties Fastify's default error handler serialises, so a route that simply
 * lets this propagate answers `409 {code: 'ROLL_CLOSED', ...}` with no extra
 * wiring — which is how Task 18 is meant to consume it.
 *
 * 409 rather than 403: the caller's credential is fine, the roll's *state* is
 * what refuses. 403 would send a device off chasing an authentication problem
 * that does not exist.
 */
export class RollClosedError extends Error {
  readonly statusCode = 409;
  readonly code = 'ROLL_CLOSED';

  constructor(status: string) {
    super(`this roll is ${status} and is not accepting uploads`);
    this.name = 'RollClosedError';
  }
}

/**
 * The statuses that accept uploads. An allow-list, not a `status === 'closed'`
 * test: a status added later (`trash`, `draft` — both named in 03 §22 but not
 * reachable in V1) must default to *refusing* uploads, not to accepting them
 * because nobody remembered to extend a deny-list.
 */
const UPLOADABLE_STATUSES: ReadonlySet<string> = new Set(['live']);

/**
 * The single definition of "may this roll take a capture right now". Task 18's
 * upload routes call it; it lives here so the rule cannot be re-implemented
 * slightly differently in each of them.
 */
export function assertRollAcceptsUploads(roll: Pick<PublicRollRow, 'status'>): void {
  if (!UPLOADABLE_STATUSES.has(roll.status)) throw new RollClosedError(roll.status);
}

/* ------------------------------------------------------------- transitions -- */

/** The statuses a host can set in V1. `draft` and `trash` (03 §22) are not reachable yet. */
export const HOST_ROLL_STATUSES = ['live', 'closed', 'archived'] as const;
export type HostRollStatus = (typeof HOST_ROLL_STATUSES)[number];

/**
 * live ↔ closed → archived, and archived is terminal.
 *
 * Archiving requires closing first: "archived" means the event is over and
 * filed, so passing through "closed" is the step where the host actually
 * decides no more photos are coming. Every list includes the current status, so
 * re-sending the state a roll is already in is a no-op rather than an error —
 * PATCH is meant to be idempotent.
 */
const TRANSITIONS: Record<string, readonly string[]> = {
  live: ['live', 'closed'],
  closed: ['closed', 'live', 'archived'],
  archived: ['archived'],
};

export function canTransition(from: string, to: HostRollStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/* ------------------------------------------------------------------ audit -- */

export type AuditAction =
  | 'roll.renamed'
  | 'roll.closed'
  | 'roll.reopened'
  | 'roll.archived'
  | 'roll.pin-changed'
  | 'roll.pin-cleared'
  | 'roll.downloads-enabled'
  | 'roll.downloads-disabled'
  | 'roll.slug-regenerated';

export interface AuditEntry {
  rollId: string;
  actor: string;
  action: AuditAction;
  /**
   * Deliberately the value the change **destroyed** — the old title, the old
   * slug — never the new one. The new value is already in the roll row; the old
   * one exists nowhere else once the update lands, so recording it is the only
   * thing the audit trail adds. Never a PIN, in either direction.
   */
  target?: string | null;
}

/** Which audit action a status change is. Only used when the status actually moves. */
const STATUS_AUDIT: Record<HostRollStatus, AuditAction> = {
  live: 'roll.reopened',
  closed: 'roll.closed',
  archived: 'roll.archived',
};

export function statusAuditAction(to: HostRollStatus): AuditAction {
  return STATUS_AUDIT[to];
}

export function auditRows(entries: readonly AuditEntry[]): (typeof auditEvents.$inferInsert)[] {
  return entries.map((entry) => ({
    id: newId('aud'),
    rollId: entry.rollId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? null,
  }));
}

/* ------------------------------------------------------------------ slugs -- */

/** PostgreSQL `unique_violation`, and the constraint that backs `rolls.slug`. */
const UNIQUE_VIOLATION = '23505';
const SLUG_CONSTRAINT = 'rolls_slug_unique';

/**
 * Whether a failed write was a slug collision specifically.
 *
 * It walks the `cause` chain because drizzle wraps driver errors in some
 * versions and not others, and a matcher that only checked the outermost error
 * would silently stop retrying after an upgrade — turning a 1-in-a-million
 * collision into a 500. `rolls.test.ts` provokes a real violation rather than a
 * fabricated one, so this stays honest about the shape the driver actually
 * throws.
 */
export function isSlugCollision(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const candidate = cursor as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === UNIQUE_VIOLATION && candidate.constraint_name === SLUG_CONSTRAINT) {
      return true;
    }
    cursor = candidate.cause;
  }
  return false;
}

/**
 * Five attempts. With ~887M slugs, a collision needs the table to already hold
 * a meaningful fraction of the keyspace, so five independent draws failing is
 * a signal that the slug space is exhausted — a capacity problem to be told
 * about, not one to paper over with an unbounded loop.
 */
const SLUG_ATTEMPTS = 5;

/**
 * Runs `write` with a fresh slug, retrying only on a slug collision.
 *
 * Pre-checking with a SELECT would still race two concurrent creates into the
 * same slug, so the unique constraint is the actual guarantee and this is just
 * how the loser of that race recovers. Each attempt must be its own
 * transaction: PostgreSQL aborts a transaction on any error, so retrying inside
 * one would only ever hit `current transaction is aborted`.
 */
async function withFreshSlug(write: (slug: string) => Promise<void>): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
    const slug = newSlug();
    try {
      await write(slug);
      return slug;
    } catch (err) {
      if (!isSlugCollision(err)) throw err;
      lastError = err;
    }
  }
  throw new Error(`could not find a free roll slug in ${SLUG_ATTEMPTS} attempts`, {
    cause: lastError,
  });
}

/* --------------------------------------------------------------- creation -- */

/** The creation fields of 03 §8. `privacy` is derived from `pin` rather than sent. */
export interface RollCreationFields {
  title: string;
  pin?: string | undefined;
  downloadsEnabled?: boolean | undefined;
  reactionsEnabled?: boolean | undefined;
}

/** What 03 §8 says the server returns. The host token appears here and nowhere else. */
export interface CreatedRoll {
  rollId: string;
  slug: string;
  guestUrl: string;
  hostUrl: string;
  hostToken: string;
}

/**
 * Creates a roll and mints its host token.
 *
 * `createdByDeviceId` is null for a roll created from the host web: V1 has no
 * accounts (05 §12), so the host token *is* the ownership record and a
 * web-created roll simply has no device behind it.
 */
export async function createRoll(
  app: FastifyInstance,
  fields: RollCreationFields,
  createdByDeviceId: string | null,
): Promise<CreatedRoll> {
  const rollId = newId('roll');
  const { token, hash } = newToken('hrt');
  const pinHash = fields.pin === undefined ? null : await hashPin(fields.pin);

  const slug = await withFreshSlug(async (candidate) => {
    await app.db
      .insert(rolls)
      .values({
        id: rollId,
        slug: candidate,
        title: fields.title,
        status: 'live',
        privacy: pinHash === null ? 'unlisted' : 'pin',
        pinHash,
        downloadsEnabled: fields.downloadsEnabled ?? true,
        reactionsEnabled: fields.reactionsEnabled ?? true,
        hostTokenHash: hash,
        createdByDeviceId,
      })
      .execute();
  });

  // `token` is returned once and never stored: the row holds only its sha256.
  return {
    rollId,
    slug,
    guestUrl: guestUrlFor(app.config, slug),
    hostUrl: hostUrlFor(app.config, token),
    hostToken: token,
  };
}

/** Rotates a roll's public slug, writing the audit row in the same transaction. */
export async function regenerateSlug(
  db: KinoDatabase,
  roll: Pick<PublicRollRow, 'id' | 'slug'>,
): Promise<string> {
  return withFreshSlug(async (candidate) => {
    await db.transaction(async (tx) => {
      await tx.update(rolls).set({ slug: candidate }).where(eq(rolls.id, roll.id));
      // The old slug is gone from the row the moment that update lands.
      await tx
        .insert(auditEvents)
        .values(
          auditRows([
            { rollId: roll.id, actor: 'host', action: 'roll.slug-regenerated', target: roll.slug },
          ]),
        );
    });
  });
}

/* ------------------------------------------------------------------ views -- */

/**
 * The host dashboard's view of a roll (03 §10).
 *
 * Built from `PublicRollRow`, which structurally cannot carry `hostTokenHash`
 * or `pinHash` — so `hasPin` is derived from `privacy`, which is the flag the
 * PIN gate itself keys on.
 */
export interface HostRollView {
  rollId: string;
  slug: string;
  title: string;
  status: string;
  privacy: string;
  hasPin: boolean;
  downloadsEnabled: boolean;
  reactionsEnabled: boolean;
  guestUrl: string;
  createdAt: Date;
  closedAt: Date | null;
  counts: RollCaptureCounts;
}

/**
 * `counts` is passed in rather than queried here so this stays a pure
 * projection: the two call sites in `host-rolls.ts` both already have a database
 * handle, and a view function that silently issues a query is the kind of thing
 * that turns one dashboard render into N of them later.
 */
export function hostRollView(
  config: ApiConfig,
  roll: PublicRollRow,
  counts: RollCaptureCounts,
): HostRollView {
  return {
    rollId: roll.id,
    slug: roll.slug,
    title: roll.title,
    status: roll.status,
    privacy: roll.privacy,
    hasPin: roll.privacy === 'pin',
    downloadsEnabled: roll.downloadsEnabled,
    reactionsEnabled: roll.reactionsEnabled,
    guestUrl: guestUrlFor(config, roll.slug),
    createdAt: roll.createdAt,
    closedAt: roll.closedAt,
    // Real since Task 18: `rollCaptureCounts` reads the `captures` table.
    counts,
  };
}

/** Everything a guest is told about a roll before it opens the feed (03 §6). */
export interface GuestRollView {
  title: string;
  status: string;
  photoCount: number;
  createdAt: Date;
}

/**
 * `photoCount` counts the captures a guest can actually see — visible and not in
 * the trash grace period — so it can be lower than the host's `captures`, which
 * includes hidden ones. Deliberately not the roll's id, slug or privacy: a guest
 * needs none of them to render the header.
 */
export function guestRollView(roll: PublicRollRow, photoCount: number): GuestRollView {
  return {
    title: roll.title,
    status: roll.status,
    photoCount,
    createdAt: roll.createdAt,
  };
}

