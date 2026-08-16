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
import { rollDevices, rolls, devices } from '../db/schema';

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

export type RollRow = typeof rolls.$inferSelect;

declare module 'fastify' {
  interface FastifyInstance {
    /** Requires a device token. Only valid on routes under `/api/device/`. */
    requireDevice: preHandlerHookHandler;
    /** Requires the authenticated device to have created or joined the roll. */
    requireDeviceRoll(rollIdParam: string): preHandlerHookHandler;
    /** Requires the host token of the roll named by `rollIdParam`. */
    requireHost(rollIdParam: string): preHandlerHookHandler;
    /** Resolves `:slug` to a roll, enforcing the PIN gate when there is one. */
    guestRollAccess: preHandlerHookHandler;
  }

  interface FastifyRequest {
    device: DeviceIdentity | null;
    roll: RollRow | null;
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

/** Reports only the offending field NAMES, never the submitted values. */
function issuePaths(error: z.ZodError): string {
  return error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
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
function pinFingerprint(roll: Pick<RollRow, 'id' | 'pinHash'>): string {
  return createHash('sha256').update(`${roll.id}:${roll.pinHash ?? ''}`).digest('hex').slice(0, 32);
}

/** Thirty days: a roll outlives its event, and re-typing the PIN each visit is hostile. */
const PIN_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const authPlugin = fp(
  async (app) => {
    // Declared up front so every request object has the same shape; Fastify
    // deoptimises requests that grow new properties per-request.
    app.decorateRequest('device', null);
    app.decorateRequest('roll', null);

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
          .select({ roll: rolls, joinedBy: rollDevices.deviceId })
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

        // "Operate on assigned/open Rolls" (03 §17): the device either created
        // the roll or has a `roll_devices` join row. Nothing else counts.
        const created = row.roll.createdByDeviceId === device.id;
        if (!created && row.joinedBy === null) {
          return fail(reply, 403, 'DEVICE_NOT_IN_ROLL', 'this device is not part of that roll');
        }

        request.roll = row.roll;
        return undefined;
      }),
    );

    app.decorate('requireHost', (rollIdParam: string): preHandlerHookHandler =>
      scoped('host', async (request, reply) => {
        const token = bearerToken(request.headers.authorization);
        if (token === null) {
          return fail(reply, 401, 'HOST_TOKEN_REQUIRED', 'expected Authorization: Bearer hrt_...');
        }

        const scope = tokenScope(token);
        if (scope !== 'hrt') {
          return scope === 'kdt'
            ? fail(reply, 403, 'WRONG_TOKEN_SCOPE', 'a device token cannot act as host')
            : fail(reply, 401, 'INVALID_HOST_TOKEN', 'not a host token');
        }

        const rollId = paramOf(request, rollIdParam);
        if (rollId === null) {
          return fail(reply, 400, 'ROLL_ID_REQUIRED', `missing :${rollIdParam} path parameter`);
        }

        const [roll] = await app.db.select().from(rolls).where(eq(rolls.id, rollId)).limit(1);
        // Distinguishing "no such roll" from "not your roll" is safe here: a
        // roll id is 128 random bits, so there is no id space to enumerate.
        if (roll === undefined) {
          return fail(reply, 404, 'ROLL_NOT_FOUND', 'no such roll');
        }

        if (!timingSafeHexEqual(hashToken(token), roll.hostTokenHash)) {
          return fail(reply, 403, 'INVALID_HOST_TOKEN', 'that host token does not open this roll');
        }

        request.roll = roll;
        return undefined;
      }),
    );

    function pinCookieAccepted(request: FastifyRequest, roll: RollRow): boolean {
      const raw = request.cookies[pinCookieName(roll.id)];
      if (raw === undefined) return false;

      const unsigned = request.unsignCookie(raw);
      if (!unsigned.valid || unsigned.value === null) return false;

      return timingSafeHexEqual(unsigned.value, pinFingerprint(roll));
    }

    app.decorate('guestRollAccess', async (request, reply) => {
      const slug = paramOf(request, 'slug');
      if (slug === null) {
        return fail(reply, 400, 'SLUG_REQUIRED', 'missing :slug path parameter');
      }

      const [roll] = await app.db.select().from(rolls).where(eq(rolls.slug, slug)).limit(1);
      if (roll === undefined) {
        return fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');
      }

      if (roll.privacy === 'pin' && !pinCookieAccepted(request, roll)) {
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
    app.post('/api/rolls/:slug/pin', async (request, reply) => {
      const parsed = pinBody.safeParse(request.body);
      if (!parsed.success) {
        return fail(reply, 400, 'INVALID_BODY', `invalid or missing: ${issuePaths(parsed.error)}`);
      }

      const slug = paramOf(request, 'slug');
      if (slug === null) {
        return fail(reply, 400, 'SLUG_REQUIRED', 'missing :slug path parameter');
      }

      const [roll] = await app.db.select().from(rolls).where(eq(rolls.slug, slug)).limit(1);
      if (roll === undefined) {
        return fail(reply, 404, 'ROLL_NOT_FOUND', 'no roll with that slug');
      }
      if (roll.privacy !== 'pin') {
        return fail(reply, 400, 'ROLL_HAS_NO_PIN', 'this roll is not PIN protected');
      }

      // The submitted PIN is never logged and never echoed: Task 14's request
      // serializer is an allow-list that excludes bodies, and this reply says
      // only whether it matched.
      if (!(await verifyPin(parsed.data.pin, roll.pinHash))) {
        return fail(reply, 401, 'INVALID_PIN', 'that PIN does not open this roll');
      }

      reply.setCookie(pinCookieName(roll.id), pinFingerprint(roll), {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        // 05 §13 wants secure cookies; dev and test are plain http on
        // localhost, where a Secure cookie would never be sent back.
        secure: app.config.NODE_ENV === 'production',
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
export function rollOf(request: FastifyRequest): RollRow {
  if (request.roll === null) throw new Error('route is missing a roll-resolving preHandler');
  return request.roll;
}
