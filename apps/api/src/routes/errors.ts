import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { ConvergeFailureLog } from '../uploads/uploads';

/**
 * The `{code, message}` error body every route answers with, mirroring the
 * device protocol's own errors (04 §18). `authPlugin` has a private copy of
 * `fail` for the same shape; this one is the route-side definition.
 */
export function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(status).send({ code, message });
}

/**
 * A 400 naming the offending fields.
 *
 * It reports field **names** only, never the submitted values — a rejected body
 * may contain a PIN, and an error message is exactly the kind of string that
 * ends up in a log or a screenshot (05 §13).
 */
export function invalidBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const fields = error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
  return fail(reply, 400, 'INVALID_BODY', `invalid or missing: ${fields}`);
}

/**
 * What a read does when it cannot refresh a capture's status: log it and report
 * the stored value anyway.
 *
 * Here rather than in `uploads.ts` because it is the *route* that owns the
 * decision to degrade instead of fail, and only the route has a logger. Here
 * rather than four copies in four route files because a degradation that is
 * described differently in each of them is a degradation nobody can grep for.
 *
 * `warn`, not `error`: the response is correct, only stale, and the next read
 * retries. An `error` level would page somebody for a lock timeout.
 */
export function convergeWarning(app: FastifyInstance): ConvergeFailureLog {
  return (err, captureId) => {
    app.log.warn({ err, captureId }, 'capture status not converged; reporting the stored value');
  };
}
