/**
 * Recognising a PostgreSQL unique violation, once, for everybody.
 *
 * Two write paths depend on being able to tell "somebody else got there first"
 * from "the write is broken" — the slug retry loop in `rolls/rolls.ts` and the
 * upload-session insert in `uploads/sessions.ts`. Both used to need their own
 * copy of the walk below, and a second copy is a second thing to get wrong.
 */

/** PostgreSQL's `unique_violation` SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether `err` is a unique violation — optionally, of one named constraint.
 *
 * It walks the `cause` chain because drizzle wraps driver errors in some
 * versions and not others, and a matcher that only checked the outermost error
 * would silently stop matching after an upgrade — turning a recoverable
 * collision into a 500. `rolls.test.ts` provokes a *real* violation rather than
 * a fabricated one, so this stays honest about the shape the driver throws.
 *
 * Naming the constraint matters when more than one unique index could fire on
 * the same statement: retrying a slug because a device *serial* collided would
 * loop forever on an error that a new slug cannot fix.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 4 && typeof cursor === 'object' && cursor !== null; depth += 1) {
    const candidate = cursor as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (
      candidate.code === UNIQUE_VIOLATION &&
      (constraint === undefined || candidate.constraint_name === constraint)
    ) {
      return true;
    }
    cursor = candidate.cause;
  }
  return false;
}
