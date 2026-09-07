import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server';
import { loadConfig } from '../src/config';
import { SECURITY_HEADERS } from '../src/plugins/securityHeaders';

/**
 * The browser-facing response headers, asserted on **real** responses rather
 * than on the plugin in isolation.
 *
 * That distinction is the whole reason this file exists. The headers are set in
 * a root-context `onSend` hook, and the failure mode worth catching is not "the
 * hook computes the wrong string" — it is "the hook does not run for this
 * reply". A route that answers from a preHandler, an error reply, a 404 that
 * matched no route at all: each of those has its own path through Fastify, and
 * each is exercised below.
 *
 * `/api/healthz` is deliberately one of them. It is added with a bare
 * `app.get(...)` on the root instance *before* any plugin loads (see the note
 * in `server.ts`), which makes it the one route an `onRoute`-based approach
 * would miss entirely.
 */
const app: FastifyInstance = buildServer({ ...loadConfig(), LOG_LEVEL: 'silent' });

beforeAll(async () => app.ready(), 60_000);
afterAll(async () => app.close(), 60_000);

function expectBaseHeaders(headers: Record<string, unknown>): void {
  /**
   * The important one. Asset bytes are served **inline** from the same origin
   * as the guest's PIN and access cookies, with a content type the uploading
   * device declared — so a browser that sniffs its way to `text/html` would be
   * running script with those cookies. The upload path refuses contradicting
   * magic bytes; this is the second lock on the same door.
   */
  expect(headers['x-content-type-options']).toBe(SECURITY_HEADERS.nosniff);
  // A guest URL carries the slug, and the slug IS the access control for an
  // unlisted roll. It must not travel in a `Referer`.
  expect(headers['referrer-policy']).toBe(SECURITY_HEADERS.referrerPolicy);
  expect(headers['content-security-policy']).toBe(SECURITY_HEADERS.contentSecurityPolicy);
  expect(headers['x-frame-options']).toBe('DENY');
}

describe('security headers', () => {
  it('sets them on a route registered before every plugin', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expectBaseHeaders(res.headers as Record<string, unknown>);
  });

  it('sets them on a 404 that matched no route', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nothing-is-here' });
    expect(res.statusCode).toBe(404);
    expectBaseHeaders(res.headers as Record<string, unknown>);
  });

  it('sets them on an error reply from a preHandler', async () => {
    // 401 from the device auth preHandler: an error body is a body a browser
    // can be made to render, so it carries the same headers as a success.
    const res = await app.inject({ method: 'GET', url: '/api/device/rolls/current' });
    expect(res.statusCode).toBe(401);
    expectBaseHeaders(res.headers as Record<string, unknown>);
  });

  it('sets them on the guest surface alongside the robots tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rolls/ZZZZZ3' });
    expectBaseHeaders(res.headers as Record<string, unknown>);
    // `robotsPlugin`'s own hook still runs; the two do not displace each other.
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it("declares a CSP that permits nothing, because the API serves no documents", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // `sandbox` is deliberately absent: it would apply to legitimate image and
    // video responses too and break `<video>` playback.
    expect(csp).not.toContain('sandbox');
  });

  it('withholds HSTS from a plain HTTP response', async () => {
    // `inject` speaks http, which is what a bench and a container-internal
    // health check speak. The RFC says an HSTS header there is meaningless, and
    // sending one anyway is how a dev machine ends up unable to reach its own
    // API over http after one visit.
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS once the request arrived over TLS', async () => {
    // Behind Caddy the API sees `X-Forwarded-Proto: https`, and honours it only
    // because `TRUST_PROXY` names the hop that may set it.
    const proxied: FastifyInstance = buildServer({
      ...loadConfig(),
      TRUST_PROXY: 1,
      LOG_LEVEL: 'silent',
    });
    try {
      await proxied.ready();
      const res = await proxied.inject({
        method: 'GET',
        url: '/api/healthz',
        headers: { 'x-forwarded-proto': 'https' },
      });
      expect(res.headers['strict-transport-security']).toBe(SECURITY_HEADERS.hsts);
      // One year, subdomains included, and NOT preloaded — preload is a
      // one-way door and the first deployment is a PC behind a relay.
      expect(SECURITY_HEADERS.hsts).not.toContain('preload');
    } finally {
      await proxied.close();
    }
  });
});
