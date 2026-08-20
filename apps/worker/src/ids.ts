import { randomBytes } from 'node:crypto';

/**
 * Prefixed row ids — `pev_pZ8kQx...` — the same `<prefix>_<random>` shape the
 * API generates (`apps/api/src/ids.ts`), because both processes insert into the
 * same tables and a row's id should not say which one wrote it.
 *
 * 128 bits of `randomBytes` in base64url. Ids are not secrets; they are
 * generated from a CSPRNG anyway so nothing here becomes a walkable sequence.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}
