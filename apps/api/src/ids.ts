import { randomBytes } from 'node:crypto';

/**
 * Prefixed row ids — `dev_pZ8kQx...`, `roll_...`, `cap_...` — matching the
 * `<prefix>_<random>` shape documented on every primary key in `db/schema.ts`.
 *
 * The random half is 128 bits of `randomBytes` in base64url (22 characters, no
 * padding), from a CSPRNG, so that nothing here becomes a sequence an outsider
 * can walk.
 *
 * ## Some of these ids ARE capabilities. Keep the CSPRNG.
 *
 * It used to be accurate to say "ids are not secrets — `rolls.slug` is the
 * unguessable public handle (05 §14)". Task 20 changed that: an **assetId** is
 * the entire capability for one asset of an unlisted roll, because
 * `GET /api/assets/:assetId/content` authenticates nothing — like the slug, the
 * unguessable identifier *is* the access control (a PIN-protected roll adds the
 * cookie gate on top; an unlisted one has only this). A **captureId** is a
 * weaker one: it is useful only to a caller that already holds the roll's slug.
 *
 * So the unguessability here is load-bearing, not belt-and-braces. Nothing in
 * this file may be changed to a counter, a timestamp prefix, a hash of row
 * contents, or anything else with structure an outsider could predict.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
