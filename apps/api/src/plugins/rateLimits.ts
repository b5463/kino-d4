import rateLimit from '@fastify/rate-limit';
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { bearerToken, hashToken } from '../auth/tokens';

export const RATE_LIMITS = {
  deviceUpload: { max: 60, timeWindow: '1 minute', groupId: 'device-upload' },
  guestRead: { max: 300, timeWindow: '1 minute', groupId: 'guest-read' },
  pinAttempt: { max: 5, timeWindow: '1 minute', groupId: 'pin-attempt' },
  registration: { max: 10, timeWindow: '1 minute', groupId: 'device-registration' },
  deviceJoin: { max: 30, timeWindow: '1 minute', groupId: 'device-join-ip' },
  hostCreate: { max: 60, timeWindow: '1 minute', groupId: 'host-create' },
} as const;

/** Redis keys never contain a bearer credential, even though the limit is per token. */
function deviceKey(request: FastifyRequest): string {
  const token = bearerToken(request.headers.authorization);
  return token === null ? `ip:${request.ip}` : `token:${hashToken(token)}`;
}

export const deviceUploadRateLimit = {
  rateLimit: { ...RATE_LIMITS.deviceUpload, keyGenerator: deviceKey },
};

export const guestReadRateLimit = { rateLimit: RATE_LIMITS.guestRead };
export const pinAttemptRateLimit = { rateLimit: RATE_LIMITS.pinAttempt };
export const registrationRateLimit = { rateLimit: RATE_LIMITS.registration };
export const deviceJoinRateLimit = { rateLimit: RATE_LIMITS.deviceJoin };
export const hostCreateRateLimit = { rateLimit: RATE_LIMITS.hostCreate };

/** Shared Redis-backed limits, disabled globally and opted into by route. */
export const rateLimitsPlugin = fp(
  async (app) => {
    // Parallel Vitest servers share the development Redis instance. Give each
    // one an isolated namespace so localhost traffic in an unrelated suite
    // cannot exhaust another suite's limits. Deployed replicas deliberately
    // retain one stable namespace and therefore enforce one shared budget.
    const nameSpace =
      app.config.NODE_ENV === 'test'
        ? `kino-rate-limit-test-${process.pid}-${randomUUID()}-`
        : 'kino-rate-limit-';
    await app.register(rateLimit, {
      global: false,
      redis: app.redis,
      nameSpace,
    });
  },
  { name: 'kino-rate-limits', dependencies: ['kino-redis'] },
);
