import type { FastifyPluginAsync } from 'fastify';
import { deviceOf, rollOf } from '../auth/plugins';

/**
 * Auth probes — one per scope, and nothing else.
 *
 * These exist so the authentication built in Task 16 can be tested on its own,
 * before Task 17+ add the real device, host and guest routes. They are
 * registered **only when `NODE_ENV === 'test'`** (see `buildServer`), which is
 * fail-closed: `NODE_ENV` defaults to `development`, so a deployment that
 * forgets to set it still does not expose them.
 *
 * Fastify has no conditional-registration primitive, so a plain `if` around
 * `app.register` is the idiom — and it keeps the gate visible in one place in
 * `server.ts` instead of hiding it in a per-route check.
 *
 * They return only what their preHandler resolved, so a passing test is
 * evidence the preHandler ran, not that a handler guessed.
 */
export const diagnosticRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/device/ping', { preHandler: app.requireDevice }, async (request) => {
    const device = deviceOf(request);
    return { scope: 'device', deviceId: device.id, serial: device.serial };
  });

  app.get(
    '/api/device/rolls/:rollId/ping',
    { preHandler: [app.requireDevice, app.requireDeviceRoll('rollId')] },
    async (request) => ({
      scope: 'device',
      deviceId: deviceOf(request).id,
      rollId: rollOf(request).id,
    }),
  );

  app.get(
    '/api/host/rolls/:rollId/ping',
    { preHandler: app.requireHost('rollId') },
    async (request) => {
      const roll = rollOf(request);
      return { scope: 'host', rollId: roll.id, slug: roll.slug };
    },
  );

  app.get('/api/rolls/:slug/ping', { preHandler: app.guestRollAccess }, async (request) => {
    const roll = rollOf(request);
    return { scope: 'guest', rollId: roll.id, slug: roll.slug, privacy: roll.privacy };
  });
};
