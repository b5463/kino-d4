import { z } from 'zod';
import { defineSchema } from '@kino/schemas';

const point2 = z.tuple([z.number(), z.number()]);
const point3 = z.tuple([z.number(), z.number(), z.number()]);

/** One as-measured correction for a component's PROVISIONAL/CONFLICT dimension claim (§23). */
export const measuredOverride = z.object({
  componentId: z.string(),
  sizeMm: point3,
  holesMm: z.array(point2).optional(),
  protrusionsMm: z.array(z.object({ label: z.string(), sizeMm: point3, offsetMm: point3 })).optional(),
  wireExitMm: point3.optional(),
  measuredAt: z.string(),
});
export type MeasuredOverride = z.infer<typeof measuredOverride>;

export const measuredOverrides = defineSchema({
  schema: 'kino.measured-overrides',
  version: 1,
  shape: z.object({
    schema: z.literal('kino.measured-overrides'),
    version: z.literal(1),
    overrides: z.array(measuredOverride),
  }),
  migrations: {},
});
export type MeasuredOverrides = z.infer<typeof measuredOverrides.shape>;
