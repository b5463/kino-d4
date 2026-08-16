import { randomBytes } from 'node:crypto';

/**
 * Prefixed row ids — `dev_pZ8kQx...`, `roll_...`, `cap_...` — matching the
 * `<prefix>_<random>` shape documented on every primary key in `db/schema.ts`.
 *
 * The random half is 128 bits of `randomBytes` in base64url (22 characters, no
 * padding). Ids are not secrets — `rolls.slug` is the unguessable public handle
 * (05 §14) — but they are generated from a CSPRNG anyway so that nothing here
 * becomes a sequence an outsider can walk.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
