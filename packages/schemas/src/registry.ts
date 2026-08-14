import { z } from 'zod';
import { SchemaTooNewError, MissingMigrationError } from './errors';

export interface SchemaDef<T> {
  schema: string;
  version: number;
  shape: z.ZodType<T>;
  migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>>;
}

export function defineSchema<T>(def: SchemaDef<T>): SchemaDef<T> {
  return def;
}

const envelope = z.object({ schema: z.string(), version: z.number().int().min(1) }).passthrough();

export function parseVersioned<T>(def: SchemaDef<T>, raw: unknown): T {
  const env = envelope.parse(raw);
  if (env.schema !== def.schema) {
    throw new Error(`expected schema ${def.schema}, got ${env.schema}`);
  }
  if (env.version > def.version) throw new SchemaTooNewError(def.schema, env.version, def.version);
  let doc: Record<string, unknown> = env;
  let v = env.version;
  while (v < def.version) {
    const step = def.migrations[v];
    if (!step) throw new MissingMigrationError(def.schema, v);
    doc = { ...step(doc), version: v + 1 };
    v += 1;
  }
  return def.shape.parse(doc);
}
