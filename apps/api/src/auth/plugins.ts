import { createHash } from 'node:crypto';
import fp from 'fastify-plugin';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
// Pulls in the `reply.setCookie` / `request.unsignCookie` declarations. The
// plugin itself is registered in server.ts.
import '@fastify/cookie';
import { bearerToken, hashToken, timingSafeHexEqual, tokenScope } from './tokens';
import { verifyPin } from './pins';
import { normalizeSlug } from '../rolls/slug';
import { captures, rollDevices, rolls, devices } from '../db/schema';
import { pinAttemptRateLimit } from '../plugins/rateLimits';

/**
 * The three authentication scopes of 05 §12, as Fastify preHandlers.
 *
 *   device — `Authorization: Bearer kdt_...`   -> `request.device`
 *   host   — `Authorization: Bearer hrt_...`   -> `request.roll`
 *   guest  — anonymous, plus a signed PIN cookie for `privacy: 'pin'` rolls
 *
 * 07 §25 is the acceptance criterion these implement: a device token must not
 * host-moderate and must not enumerate unrelated rolls. Two mechanisms enforce
 * it, at two different times:
 *
 * 1. At runtime, a token of the wrong scope is 403, never 401 — the credential
 *    is real, the permission is not.
 * 2. At boot, the `onRoute` hook below refuses to start if a device-scoped
 *    route is mounted outside `/api/device/` (or a host one outside
 *    `/api/host/`). That turns the URL-space split from a convention every
 *    future task has to remember into an invariant the server enforces.
 *
 * The `POST /api/rolls/:slug/pin` route lives here rather than in `routes/`
 * because it and `guestRollAccess` are two halves of one mechanism: the cookie
 * name and value format need exactly one definition site.
 */

export interface DeviceIdentity {
  id: string;
  serial: string;
}

/**
 * A roll as it may appear in request context: every column **except** the two
 * credential hashes.
 *
 * `request.roll` is read by route handlers, and the obvious thing for a handler
 * to do is `return rollOf(request)`. If that object carried `hostTokenHash` or
 * `pinHash`, one such line in any future task would serve a credential hash to
 * a guest. Rather than rely on every handler remembering to strip them, the
 * hashes never enter the request in the first place — they are read into a
 * local, compared, and dropped inside the preHandler that needs them.
 *
 * This applies to host and device context too, not just guest: neither has any
 * use for a hash once authentication has already happened.
 */
export type PublicRollRow = Omit<typeof rolls.$inferSelect, 'hostTokenHash' | 'pinHash'>;

/**
 * A capture as the host moderation routes see it: its identity and its two
 * moderation flags, and nothing else.
 *
 * Deliberately not the whole row. `requireHostCapture` has to read the capture
 * anyway to find out which roll it belongs to, so handing the route the columns
 * it moderates saves a second query — but widening this to the full capture would
 * make the preHandler a general-purpose loader and put the mode, timing and
 * status of every capture on a request that has no use for them.
 */
export interface HostCapture {
  id: string;
  rollId: string;
  visible: boolean;
  deletedAt: Date | null;
}

/**
 * The column list backing `PublicRollRow`.
 *
 * Adding a column to `rolls` without adding it here is a **compile error** at
 * every `request.roll = ...` assignment (the selected row stops satisfying
 * `PublicRollRow`), so the projection cannot silently drift out of date.
 *
 * Exported so route modules can `.returning(publicRollColumns)` from an UPDATE
 * instead of writing a second projection: two copies would mean two places for
 * a credential hash to creep back in, and only one of them has that compile
 * error watching it.
 */
export const publicRollColumns = {
  id: rolls.id,
  slug: rolls.slug,
  title: rolls.title,
  status: rolls.status,
  privacy: rolls.privacy,
  downloadsEnabled: rolls.downloadsEnabled,
  reactionsEnabled: rolls.reactionsEnabled,
  createdByDeviceId: rolls.createdByDeviceId,
  createdAt: rolls.createdAt,
  closedAt: rolls.closedAt,
};

declare module 'fastify' {
  interface FastifyInstance {
    /** Requires a device token. Only valid on routes under `/api/device/`. */
    requireDevice: preHandlerHookHandler;
    /** Requires the authenticated device to have created or joined the roll. */
    requireDeviceRoll(rollIdParam: string): preHandlerHookHandler;
    /** Requires the host token of the roll named by `rollIdParam`. */
    requireHost(rollIdParam: string): preHandlerHookHandler;
    /** Resolves the owning roll from a host token when no roll id is known yet. */
    requireHostToken: preHandlerHookHandler;
    /**
     * Requires the host token of the roll that **owns the capture** named by
     * `captureIdParam`. Sets `request.capture` as well as `request.roll`.
     */
    requireHostCapture(captureIdParam: string): preHandlerHookHandler;
    /** Resolves `:slug` to a roll, enforcing the PIN gate when there is one. */
    guestRollAccess: preHandlerHookHandler;
  }

  interface FastifyRequest {
    device: DeviceIdentity | null;
    roll: PublicRollRow | null;
    capture: HostCapture | null;
  }
}

/** Error body shape, mirroring the device protocol's own errors (04 §18). */
function fail(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ code, message });
}

function paramOf(request: FastifyRequest, name: string): string | null {
  const params: unknown = request.params;
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The `:slug` path parameter, canonicalised.
 *
 * Both slug-resolving preHandlers below go through this one function rather
 * than calling `paramOf(request, 'slug')` themselves, so the guest read and the
 * PIN exchange cannot drift apart on case. A roll that is readable at one
 * casing but not unlockable at it would be a dead end for the guest.
 */
function slugParam(request: FastifyRequest): string | null {
  const raw = paramOf(request, 'slug');
  return raw === null ? null : normalizeSlug(raw);
}

/** Reports only the offending field NAMES, never the submitted values. */
function issuePaths(error: z.ZodError): string {
  return error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
}

/* ------------------------------------------------------------ host tokens -- */

/**
 * The credential half of host authentication: is there a host token at all, and
 * is it the right kind of token?
 *
 * Split out because `requireHost` and `requireHostCapture` differ only in how
 * they find the roll — one reads it from a path parameter, the other derives it
 * from a capture. Everything about the token is identical, and a second copy of
 * it would be a second place for the 401/403 distinction (07 §25) to be got
 * wrong. Returns null once it has already answered the request.
 */
function hostBearer(request: FastifyRequest, reply: FastifyReply): string | null {
  const token = bearerToken(request.headers.authorization);
  if (token === null) {
    fail(reply, 401, 'HOST_TOKEN_REQUIRED', 'expected Authorization: Bearer hrt_...');
    return null;
  }

  const scope = tokenScope(token);
  if (scope !== 'hrt') {
    // A real credential for the wrong scope is a permission failure; anything
    // else is simply not a credential.
    if (scope === 'kdt') {
      fail(reply, 403, 'WRONG_TOKEN_SCOPE', 'a device token cannot act as host');
    } else {
      fail(reply, 401, 'INVALID_HOST_TOKEN', 'not a host token');
    }
    return null;
  }
  return token;
}

/**
 * The one comparison that grants host access, in one place.
 *
 * Constant-time: the indexed lookup that found the row only selected a
 * candidate, and the equality that actually decides must not run through the
 * database's own byte comparison.
 */
function hostTokenOpens(token: string, hostTokenHash: string): boolean {
  return timingSafeHexEqual(hashToken(token), hostTokenHash);
}

/** The two scopes that own a slice of the URL space; guest routes own none. */
type AuthScope = 'device' | 'host';

const SCOPE_PREFIX: Record<AuthScope, string> = {
  device: '/api/device/',
  host: '/api/host/',
};

/**
 * Which scope a preHandler belongs to, for the boot-time URL check. A WeakMap
 * rather than a property on the function so the mark cannot be forged or
 * cleared by anything outside this module.
 */
const scopeOf = new WeakMap<object, AuthScope>();

function scoped(scope: AuthScope, handler: preHandlerHookHandler): preHandlerHookHandler {
  scopeOf.set(handler, scope);
  return handler;
}

const pinBody = z.object({ pin: z.string().min(1).max(64) });

const pinCookieName = (rollId: string): string => `kino_pin_${rollId}`;

/**
 * The cookie's payload. It is derived from the roll's *current* `pinHash`, so
 * changing a roll's PIN silently invalidates every session issued under the old
 * one — which is what a host who rotates a leaked PIN expects to happen.
 *
 * It carries no secret: the stored hash is already salted scrypt output, and
 * this is a truncated digest of it. The cookie's unforgeability comes from
 * @fastify/cookie's signature, not from this value.
 */
function pinFingerprint(rollId: string, pinHash: string | null): string {
  return createHash('sha256').update(`${rollId}:${pinHash ?? ''}`).digest('hex').slice(0, 32);
}

/** Thirty days: a roll outlives its event, and re-typing the PIN each visit is hostile. */
const PIN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function pinCookieAccepted(
  request: FastifyRequest,
  rollId: string,
  pinHash: string | null,
): boolean {
  const raw = request.cookies[pinCookieName(rollId)];
  if (raw === undefined) return false;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return false;

  return timingSafeHexEqual(unsigned.value, pinFingerprint(rollId, pinHash));
}

/**
 * "May this anonymous request read this roll?" — the whole guest rule, as one
 * function, keyed on the roll **row** rather than on a slug.
 *
 * `guestRollAccess` below is the slug-shaped front door and calls this. Task
 * 20's `GET /api/assets/:assetId/content` has no slug to key on — it derives the
 * roll from the asset — and calls the same function rather than growing a second
 * copy of the cookie name, the fingerprint derivation or the `privacy === 'pin'`
 * test. Two copies of an access rule is how one of them ends up a version
 * behind.
 *
 * The caller passes `pinHash` explicitly, from a local it drops immediately, so
 * this can never be handed something that carries the hash onward.
 */
export function guestMayReadRoll(
  request: FastifyRequest,
  roll: { id: string; privacy: string },
  pinHash: string | null,
): boolean {
  return roll.privacy !== 'pin' || pinCookieAccepted(request, roll.id, pinHash);
}

export const authPlugin = fp(
  async (app) => {
    // Declared up front so every request object has the same shape; Fastify
    // deoptimises requests that grow new properties per-request.
    app.decorateRequest('device', null);
    app.decorateRequest('roll', null);
    app.decorateRequest('capture', null);

    /**
     * 07 §25, checked at boot rather than trusted to reviewers.
     *
     * `onRoute` only sees routes registered *after* this plugin, so `authPlugin`
     * must stay ahead of every route registration in `buildServer`.
     */
    app.addHook('onRoute', (route) => {
      const preHandlers: unknown[] = Array.isArray(route.preHandler)
        ? route.preHandler
        : route.preHandler === undefined
          ? []
          : [route.preHandler];

      for (const handler of preHandlers) {
        if (typeof handler !== 'function') continue;
        const scope = scopeOf.get(handler);
        if (scope === undefined || route.url.startsWith(SCOPE_PREFIX[scope])) continue;

        const methods = [route.method].flat().join('|');
        throw new Error(
          `Route ${methods} ${route.url} uses ${scope} authentication but is not mounted ` +
            `under ${SCOPE_PREFIX[scope]} — ${scope} routes must live there (07 §25).`,
        );
      }
    });

    app.decorate(
      'requireDevice',
      scoped('device', async (request, reply) => {
        const token = bearerToken(request.headers.authorization);
        if (token === null) {
          return fail(reply, 401, 'DEVICE_TOKEN_REQUIRED', 'expected Authorization: Bearer kdt_...');
        }

        const scope = tokenScope(token);
        if (scope !== 'kdt') {
          // A real credential for the wrong scope is a permission failure;
          // anything else is simply not a credential.
          return scope === 'hrt'
            ? fail(reply, 403, 'WRONG_TOKEN_SCOPE', 'this route accepts a device token only')
            : fail(reply, 401, 'INVALID_DEVICE_TOKEN', 'not a device token');
        }

        const presented = hashToken(token);
        const [row] = await app.db
          .select({ id: devices.id, serial: devices.serial, tokenHash: devices.tokenHash })
          .from(devices)
          .where(eq(devices.tokenHash, presented))
          .limit(1);

        // The indexed lookup selects a candidate; the comparison that actually
        // decides is the constant-time one, so the equality that grants access
        // never runs through the database's own byte comparison.
        if (row === undefined || !timingSafeHexEqual(row.tokenHash, presented)) {
          return fail(reply, 401, 'INVALID_DEVICE_TOKEN', 'unknown or revoked device token');
        }

        request.device = { id: row.id, serial: row.serial };
        return undefined;
      }),
    );

    app.decorate('requireDeviceRoll', (rollIdParam: string): preHandlerHookHandler =>
      scoped('device', async (request, reply) => {
        const device = request.device;
        if (device === null) {
          // Wiring bug, not a client error: 500 is the honest answer.
          throw new Error('requireDeviceRoll must run after requireDevice');
        }

        const rollId = paramOf(request, rollIdParam);
        if (rollId === null) {
          return fail(reply, 400, 'ROLL_ID_REQUIRED', `missing :${rollIdParam} path parameter`);
        }

        const [row] = await app.db
          .select({ ...publicRollColumns, joinedBy: rollDevices.deviceId })
          .from(rolls)
          .leftJoin(
            rollDevices,
            and(eq(rollDevices.rollId, rolls.id), eq(rollDevices.deviceId, device.id)),
          )
          .where(eq(rolls.id, rollId))
          .limit(1);

        if (row === undefined) {
          return fail(reply, 404, 'ROLL_NOT_FOUND', 'no such roll');
        }

        const { joinedBy, ...roll } = row;

        // "Operate on assigned/open Rolls" (03 §17): the device either created
        // the roll or has a `roll_devices` join row. Nothing else counts.
        if (roll.createdByDeviceId !== device.id && joinedBy === null) {
          return fail(reply, 403, 'DEVICE_NOT_IN_ROLL', 'this device is not part of that roll');
        }

        request.roll = roll;
        return undefined;
      }),
    );

    app.decorate('requireHost', (rollIdParam: string): preHandlerHookHandler =>
      scoped('host', async (request, reply) => {
        const token = hostBearer(request, reply);
        // The reply is already sent; returning it is how a Fastify preHandler
        // says "stop here" without a second send.
        if (token === null) return reply;

        const rollId = paramOf(request, rollIdParam);
        if (rollId === null) {
          return fail(reply, 400, 'ROLL_ID_REQUIRED', `missing :${rollIdParam} path parameter`);
        }

        const [row] = await app.db
          .select({ ...publicRollColumns, hostTokenHash: rolls.hostTokenHash })
          .from(rolls)
          .where(eq(rolls.id, rollId))
          .limit(1);
        // Distinguishing "no such roll" from "not your roll" is safe here: a
        // roll id is 128 random bits, so there is no id space to enumerate.
        if (row === undefined) {
          return fail(reply, 404, 'ROLL_NOT_FOUND', 'no such roll');
        }

        // Destructured out here and never re-attached: the hash is needed for
        // this comparison and for nothing downstream.
        const { hostTokenHash, ...roll } = row;
        if (!hostTokenOpens(token, hostTokenHash)) {
          return fail(reply, 403, 'INVALID_HOST_TOKEN', 'that host token does not open this roll');
        }

        request.roll = roll;
        return undefined;
      }),
    );

    app.decorate(
      'requireHostToken',
      scoped('host', async (request, reply) => {
        const token = hostBearer(request, reply);
        if (token === null) return reply;
        const presented = hashToken(token);

        const [row] = await app.db
          .select({ ...publicRollColumns, hostTokenHash: rolls.hostTokenHash })
          .from(rolls)
          .where(eq(rolls.hostTokenHash, presented))
          .limit(1);
        if (row === undefined || !timingSafeHexEqual(row.hostTokenHash, presented)) {
          return fail(reply, 401, 'INVALID_HOST_TOKEN', 'unknown or revoked host token');
        }

        const { hostTokenHash: _credential, ...roll } = row;
        request.roll = roll;
        return undefined;
      }),
    );

    /**
     * Host auth for the moderation routes of 03 §11, which are addressed by
     * **captureId** rather than by rollId.
     *
     * `requireHost` cannot express this: it keys the token comparison on a roll
     * id path parameter, and these routes have none. A host token for roll A must
     * not moderate a capture in roll B, so the roll is *derived* from the capture
     * and the comparison is made against **that** roll's hash — the same shape of
     * problem `deliverAsset` solves for guests by deriving the roll from the
     * asset.
     *
     * Nothing about the token is re-implemented: `hostBearer` and
     * `hostTokenOpens` above are the same two functions `requireHost` uses, so
     * there is one definition of what a host credential is and one comparison
     * that grants access.
     *
     * The order of answers is deliberate. An unknown capture is 404 **before**
     * the token is compared, which is safe for the same reason the roll lookup
     * above is: a capture id is 128 random bits, so there is no id space to
     * enumerate. A capture that exists under a roll this token does not open is
     * 403, which tells the caller nothing it did not already know — it named the
     * capture.
     */
    app.decorate('requireHostCapture', (captureIdParam: string): preHandlerHookHandler =>
      scoped('host', async (request, reply) => {
        const token = hostBearer(request, reply);
        // The reply is already sent; returning it is how a Fastify preHandler
        // says "stop here" without a second send.
        if (token === null) return reply;

        const captureId = paramOf(request, captureIdParam);
        if (captureId === null) {
          return fail(
            reply,
            400,
            'CAPTURE_ID_REQUIRED',
            `missing :${captureIdParam} path parameter`,
          );
        }

        // One query for both rows. The capture's roll is the only roll that can
        // authorize this request, so the join is not an optimisation — it is what
        // makes "whose hash do I compare against" unambiguous.
        const [row] = await app.db
          .select({
            // The roll spread goes FIRST and every capture column is prefixed.
            // Both, deliberately: a `rolls.visible` or `rolls.deleted_at` added
            // to `publicRollColumns` later would otherwise silently override the
            // capture's own flags and hand this route the wrong row's state.
            ...publicRollColumns,
            hostTokenHash: rolls.hostTokenHash,
            captureId: captures.id,
            captureVisible: captures.visible,
            captureDeletedAt: captures.deletedAt,
          })
          .from(captures)
          .innerJoin(rolls, eq(rolls.id, captures.rollId))
          .where(eq(captures.id, captureId))
          .limit(1);
        if (row === undefined) {
          return fail(reply, 404, 'CAPTURE_NOT_FOUND', 'no such capture');
        }

        const {
          captureId: id,
          captureVisible: visible,
          captureDeletedAt: deletedAt,
          hostTokenHash,
          ...roll
        } = row;
        if (!hostTokenOpens(token, hostTokenHash)) {
          return fail(reply, 403, 'INVALID_HOST_TOKEN', 'that host token does not open this roll');
        }

        request.roll = roll;
        request.capture = { id, rollId: roll.id, visible, deletedAt };
        return undefined;
      }),
    );

    app.decorate('guestRollAccess', async (request, reply) => {
      const slug = slugParam(request);
      if (slug === null) {
        return fail(reply, 400, 'SLUG_REQUIRED', 'missing :slug path parameter');
      }

      const [row] = await app.db
        .select({ ...publicRollColumns, pinHash: rolls.pinHash })
        .from(rolls)
        .where(eq(rolls.slug, slug))
        .limit(1);
      if (row === undefined) {
        return fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');
      }

      // `pinHash` stays local. What lands on the request is the projection
      // without it, so a handler returning `rollOf(request)` cannot leak it.
      const { pinHash, ...roll } = row;
      if (!guestMayReadRoll(request, roll, pinHash)) {
        return fail(reply, 401, 'PIN_REQUIRED', 'this roll is PIN protected');
      }

      request.roll = roll;
      return undefined;
    });

    /**
     * Exchanges a PIN for the signed session cookie `guestRollAccess` looks for.
     * Guests are anonymous (03 §18) — this grants access to one roll and
     * establishes no identity.
     */
    app.post('/api/rolls/:slug/pin', { config: pinAttemptRateLimit }, async (request, reply) => {
      const parsed = pinBody.safeParse(request.body);
      if (!parsed.success) {
        return fail(reply, 400, 'INVALID_BODY', `invalid or missing: ${issuePaths(parsed.error)}`);
      }

      const slug = slugParam(request);
      if (slug === null) {
        return fail(reply, 400, 'SLUG_REQUIRED', 'missing :slug path parameter');
      }

      const [row] = await app.db
        .select({ id: rolls.id, privacy: rolls.privacy, pinHash: rolls.pinHash })
        .from(rolls)
        .where(eq(rolls.slug, slug))
        .limit(1);
      if (row === undefined) {
        return fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');
      }
      if (row.privacy !== 'pin') {
        return fail(reply, 400, 'ROLL_HAS_NO_PIN', 'this roll is not PIN protected');
      }

      // The submitted PIN is never logged and never echoed: Task 14's request
      // serializer is an allow-list that excludes bodies, and this reply says
      // only whether it matched.
      if (!(await verifyPin(parsed.data.pin, row.pinHash))) {
        return fail(reply, 401, 'INVALID_PIN', 'that PIN does not open this roll');
      }

      reply.setCookie(pinCookieName(row.id), pinFingerprint(row.id, row.pinHash), {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        // 05 §13 wants secure cookies. `'auto'` sets Secure from the actual
        // request protocol, so production https gets it and http://localhost
        // still works in dev and test — no environment string to get wrong.
        //
        // Caveat for deployment: behind a TLS-terminating proxy Fastify sees
        // http unless `trustProxy` is enabled, which would silently drop the
        // Secure flag. Enabling it is a server-level decision; see the README.
        secure: 'auto',
        maxAge: PIN_COOKIE_MAX_AGE_SECONDS,
      });

      return { ok: true };
    });
  },
  { name: 'kino-auth', dependencies: ['kino-db'] },
);

/** Narrows `request.device` after `requireDevice`, failing loudly if it is absent. */
export function deviceOf(request: FastifyRequest): DeviceIdentity {
  if (request.device === null) throw new Error('route is missing the requireDevice preHandler');
  return request.device;
}

/** Narrows `request.roll` after any preHandler that resolves one. */
export function rollOf(request: FastifyRequest): PublicRollRow {
  if (request.roll === null) throw new Error('route is missing a roll-resolving preHandler');
  return request.roll;
}

/** Narrows `request.capture` after `requireHostCapture`. */
export function captureOf(request: FastifyRequest): HostCapture {
  if (request.capture === null) {
    throw new Error('route is missing the requireHostCapture preHandler');
  }
  return request.capture;
}
