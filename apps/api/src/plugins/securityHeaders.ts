import fp from 'fastify-plugin';

/**
 * The response headers a browser needs in order to treat this API safely, set
 * on **every** reply.
 *
 * They are also set at the edge (`infra/Caddyfile`, `infra/Caddyfile.tunnel`),
 * and that duplication is deliberate rather than sloppy. Caddy covers the SPA,
 * which this process never serves; this covers a direct hit on the API —
 * `http://localhost:3000` on a bench, a container reached from inside the
 * Compose network, or any future deployment where the proxy is not in front.
 * A header that only exists in the proxy config is a header that disappears the
 * first time somebody port-forwards the API to debug it.
 *
 * No `@fastify/helmet`: these are five constant strings and one conditional,
 * and a dependency to write six `reply.header()` calls is a dependency to
 * audit, pin and upgrade for nothing.
 */

/**
 * The one that actually matters here.
 *
 * `GET /api/assets/:id/content` serves stored bytes **inline**, from the same
 * origin as the guest's PIN and access cookies, with a `Content-Type` that came
 * from the uploading device's own declaration. Without `nosniff`, a browser
 * that disagrees with that declaration sniffs the body and may render it as
 * HTML — which would be same-origin script with the guest's cookies. The upload
 * path now also checks the stored magic bytes against the declared type
 * (`uploads/uploads.ts`), so this is the second of two locks on the same door;
 * either one alone has a bad day eventually.
 */
const NOSNIFF = 'nosniff';

/**
 * `no-referrer`, not `strict-origin-when-cross-origin`.
 *
 * A guest URL is `https://kino.acronym.sk/r/<slug>` and the slug **is** the
 * access control for an unlisted roll (03 §9). The default policy sends the
 * origin to any cross-origin request; a stricter reading is that this app has
 * no legitimate use for a referrer at all, and the failure mode it prevents —
 * a slug travelling in a `Referer` to somebody's analytics — is the same leak
 * `X-Robots-Tag` exists to stop.
 */
const REFERRER_POLICY = 'no-referrer';

/**
 * The API's own CSP, which is not the SPA's.
 *
 * Nothing this process returns is a document the browser is meant to run: it is
 * JSON, an SSE stream, a 302, or object bytes. So the policy is the empty one —
 * `default-src 'none'` — plus the two directives that are not covered by
 * `default-src` and matter most on a response that *is* navigated to directly:
 * `frame-ancestors` (no clickjacking of an error page) and `base-uri`.
 *
 * The case this is aimed at: an asset stored as HTML, delivered inline, opened
 * in a tab. `nosniff` plus the magic-byte check should stop it ever being
 * treated as a document; if both fail, this policy means the document that
 * renders can load no script, no style, no image and no font, and can talk to
 * nothing. `sandbox` is deliberately NOT in the list — it would also apply to
 * the legitimate image and video responses and break `<video>` playback.
 */
const API_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * One year, `includeSubDomains`, no `preload`.
 *
 * `preload` is a one-way door: it commits `acronym.sk`'s subdomain to browsers'
 * built-in lists and is slow to undo, which is the wrong shape for a service
 * whose first deployment is a PC behind a relay. `includeSubDomains` here binds
 * only names *under* `kino.acronym.sk`, of which there are none, so it costs
 * nothing and stops one being stood up on plain HTTP later.
 *
 * Only ever sent over TLS. `request.protocol` is honest about that because
 * `TRUST_PROXY` names the hops that may set `X-Forwarded-Proto`; on a plain
 * HTTP bench the header is simply absent, which is what the RFC requires.
 */
const HSTS = 'max-age=31536000; includeSubDomains';

export const securityHeadersPlugin = fp(
  async (app) => {
    // `onSend` rather than `onRequest`, for the same reason `robotsPlugin` uses
    // it: an error reply — the 401 from the PIN gate, a 404, a 500 from the
    // error handler — is a response a browser renders too, and it must carry
    // the same headers as a success.
    app.addHook('onSend', async (request, reply) => {
      reply.header('x-content-type-options', NOSNIFF);
      reply.header('referrer-policy', REFERRER_POLICY);
      reply.header('content-security-policy', API_CSP);
      // Belt to `frame-ancestors`' braces: the CSP directive is the one that
      // counts on a current browser, this covers the older ones that ignore it.
      reply.header('x-frame-options', 'DENY');
      if (request.protocol === 'https') reply.header('strict-transport-security', HSTS);
    });
  },
  { name: 'kino-security-headers' },
);

/** Exported so a test asserts the shipped values rather than a copy of them. */
export const SECURITY_HEADERS = {
  nosniff: NOSNIFF,
  referrerPolicy: REFERRER_POLICY,
  contentSecurityPolicy: API_CSP,
  hsts: HSTS,
} as const;
