import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineSchema, parseVersioned, SchemaTooNewError, MissingMigrationError } from '../src/index';

const widget = defineSchema({
  schema: 'kino.test-widget',
  version: 2,
  shape: z.object({
    schema: z.literal('kino.test-widget'),
    version: z.literal(2),
    name: z.string(),
    color: z.string(),
  }),
  migrations: {
    // v1 had no color; v1 -> v2 adds default
    1: (doc) => ({ ...doc, color: 'grey' }),
  },
});

describe('parseVersioned', () => {
  it('parses a current-version document', () => {
    const out = parseVersioned(widget, { schema: 'kino.test-widget', version: 2, name: 'a', color: 'blue' });
    expect(out.color).toBe('blue');
  });
  it('migrates an old document forward', () => {
    const out = parseVersioned(widget, { schema: 'kino.test-widget', version: 1, name: 'a' });
    expect(out.version).toBe(2);
    expect(out.color).toBe('grey');
  });
  it('rejects newer-than-known versions explicitly', () => {
    expect(() => parseVersioned(widget, { schema: 'kino.test-widget', version: 3, name: 'a' }))
      .toThrow(SchemaTooNewError);
  });
  it('rejects wrong schema name', () => {
    expect(() => parseVersioned(widget, { schema: 'kino.other', version: 2, name: 'a', color: 'x' })).toThrow();
  });
  it('fails loudly on a missing migration step', () => {
    const gappy = defineSchema({ ...widget, version: 3, shape: z.any(), migrations: { 1: (d) => d } });
    expect(() => parseVersioned(gappy, { schema: 'kino.test-widget', version: 1, name: 'a' }))
      .toThrow(MissingMigrationError);
  });
});

// Regression guard for schemas whose zod input type differs from their output type.
// `.default()` makes `n` optional on the way in but required on the way out, so a
// `shape` field typed as `z.ZodType<T>` (which pins Input === Output) would infer T
// from the *input* side and hand back `n?: number | undefined`.
const withDefaults = defineSchema({
  schema: 'kino.test-defaults',
  version: 1,
  shape: z.object({
    schema: z.literal('kino.test-defaults'),
    version: z.literal(1),
    n: z.number().default(1),
  }),
  migrations: {},
});

describe('parseVersioned with input/output-divergent schemas', () => {
  it('applies zod defaults and types the result as non-optional', () => {
    const out = parseVersioned(withDefaults, { schema: 'kino.test-defaults', version: 1 });
    // Compile-level assertion: this only typechecks if T is the zod *output* type.
    const n: number = out.n;
    expect(n).toBe(1);
  });
});
