import fp from 'fastify-plugin';

/**
 * `X-Robots-Tag: noindex, nofollow` on the whole guest URL space (03 §9).
 *
 * A roll's privacy model is "secret URL", so the failure mode to design against
 * is a crawler that reaches a link — from a shared screenshot, a chat preview
 * fetch, a browser extension — and publishes it. There is no public directory
 * in V1, and this header is what keeps it that way.
 *
 * ## Why a hook, and why it keys on the raw URL
 *
 * Per-route headers would cover the routes somebody remembered, which is the
 * wrong default for a privacy control: the route added next year is exactly the
 * one that would be missed. Keying on `request.url` rather than the matched
 * route pattern also covers responses where no route matched at all — a 404 for
 * a mistyped slug is still a page a crawler asked for.
 *
 * `onSend` rather than `onRequest` so it lands on error replies too: the 401
 * from the PIN gate and the 404 from a stale slug both carry it.
 *
 * `fastify-plugin` puts the hook on the *root* context, which is what makes it
 * cover `POST /api/rolls/:slug/pin` — that route lives inside `authPlugin`, not
 * in any roll route file. Fastify resolves a context's hooks after the context
 * has loaded, so registration order between the two plugins does not matter;
 * `rolls.test.ts` asserts the header on that route rather than trusting it.
 */
/**
 * `/api/assets` is on the list for the same reason `/api/rolls` is, and is the
 * reason this is a list rather than a constant: Task 20's asset route serves
 * guest media from outside the slug space, and a crawler that reached a
 * redirect to a photo would be exactly the leak the header exists to stop.
 */
const GUEST_URL_PREFIXES = ['/api/rolls', '/api/assets'] as const;

export const robotsPlugin = fp(
  async (app) => {
    app.addHook('onSend', async (request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      const guest = GUEST_URL_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      if (guest) reply.header('x-robots-tag', 'noindex, nofollow');
    });
  },
  { name: 'kino-robots' },
);
