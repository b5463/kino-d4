import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

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
