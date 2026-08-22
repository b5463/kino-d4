import { z } from 'zod';
import { defineSchema } from '@kino/schemas';
import { netDef } from './nets';

export const SOURCE_KINDS = ['MEASURED', 'OFFICIAL_CAD', 'OFFICIAL_SPEC', 'SELLER_SPEC', 'PROVISIONAL'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const PROVENANCE_TAGS = ['MEASURED', 'MANUFACTURER', 'SELLER', 'ESTIMATED', 'SIMULATED'] as const;
export type ProvenanceTag = (typeof PROVENANCE_TAGS)[number];

const mm3 = z.tuple([z.number().nullable(), z.number().nullable(), z.number().nullable()]);

/** One dimension claim for a component. Two conflicting sources are stored side by side, never merged (§6). */
export const dimensionSource = z.object({
  kind: z.enum(SOURCE_KINDS),
  sizeMm: mm3, // [x, y, z] in scene axes; null = unknown axis
  ref: z.string().optional(), // URL or SOURCES.md pointer
  note: z.string().optional(),
});
export type DimensionSource = z.infer<typeof dimensionSource>;

export const keepoutDef = z.object({
  id: z.string(),
  label: z.string(),
  sizeMm: z.tuple([z.number(), z.number(), z.number()]),
  offsetMm: z.tuple([z.number(), z.number(), z.number()]), // relative to component origin
  kind: z.enum(['connector', 'insertion', 'ejection', 'service', 'travel', 'clearance']),
});
export type KeepoutDef = z.infer<typeof keepoutDef>;

export const componentDef = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string().optional(),
  qty: z.union([z.number().int().positive(), z.literal('as-needed')]),
  meshTier: z.enum(['A', 'B', 'C']), // §22 fidelity tier
  sources: z.array(dimensionSource).min(1),
  specs: z.record(z.unknown()).optional(),
  keepouts: z.array(keepoutDef).default([]),
  /** Mass in grams with its provenance tag. Optional — unweighed parts omit
   * it rather than inventing a number (audit #63). */
  massG: z.object({ value: z.number(), tag: z.enum(PROVENANCE_TAGS) }).optional(),
  /** Material name (e.g. "PA12-GF35 SLS", "UTR-8100 SLA"). Free text with a
   * tag; thermal properties arrive with real datasheet work, not here. */
  material: z.object({ value: z.string(), tag: z.enum(PROVENANCE_TAGS) }).optional(),
});
export type ComponentDef = z.infer<typeof componentDef>;

export const instanceDef = z.object({
  id: z.string(),
  component: z.string(),
  positionMm: z.tuple([z.number(), z.number(), z.number()]),
  rotationDeg: z.tuple([z.number(), z.number(), z.number()]),
  group: z.enum(['camera-bar', 'body', 'power', 'shell']).default('body'),
  explodeOrder: z.number().int().default(0), // §8 exploded view: front acrylic=9 … rear acrylic=0
  explodeDirMm: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 1]),
  /**
   * Optical center relative to the instance origin (board center), mm.
   * The frustum apex is position + this offset when present. Values are
   * NEEDS_HARDWARE_VALIDATION until the bench measures real optical centers
   * (audit #63) — defaulting to [0,0,0] keeps apex = board center explicit.
   */
  opticalCenterOffsetMm: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
});
export type InstanceDef = z.infer<typeof instanceDef>;

export const powerProfile = z.object({
  battery: z.object({
    nominalV: z.number(),
    capacitymAh: z.number(),
    internalOhm: z.object({ value: z.number(), tag: z.enum(PROVENANCE_TAGS) }),
    safeContinuousA: z.number(),
    shortPulseMaxA: z.number(),
    chargePreferredA: z.number(),
    chargeMaxA: z.number(),
  }),
  boost: z.object({
    efficiency: z.object({ value: z.number(), tag: z.enum(PROVENANCE_TAGS) }),
    /** Converter power class in watts (SW6106: 18 W). Optional — older profiles predate it. */
    classW: z.object({ value: z.number(), tag: z.enum(PROVENANCE_TAGS) }).optional(),
  }),
  loads: z.record(z.object({ amps: z.number(), tag: z.enum(PROVENANCE_TAGS), note: z.string().optional() })),
  fuse: z.object({ ratingA: z.number(), type: z.literal('fast') }),
});
export type PowerProfile = z.infer<typeof powerProfile>;

/**
 * A selectable non-production power pack (audit #63). `experimental` is a
 * literal `true` so a "production alternate" is unrepresentable — the only
 * production pack is the top-level `power` block. The Twin never defaults to
 * one of these; a client must select it by id.
 */
export const alternatePowerEntry = z.object({
  label: z.string(),
  note: z.string(),
  experimental: z.literal(true),
  power: powerProfile,
});
export type AlternatePowerEntry = z.infer<typeof alternatePowerEntry>;

export const hardwareProfile = defineSchema({
  schema: 'kino.hardware-profile',
  version: 1,
  shape: z.object({
    schema: z.literal('kino.hardware-profile'),
    version: z.literal(1),
    profile: z.string(),
    name: z.string(),
    units: z.literal('mm'),
    body: z.object({ sizeMm: z.tuple([z.number(), z.number(), z.number()]), confidence: z.enum(SOURCE_KINDS) }),
    cameraPitchMm: z.number(),
    cameraPitchRangeMm: z.tuple([z.number(), z.number()]),
    components: z.array(componentDef),
    instances: z.array(instanceDef),
    power: powerProfile,
    // .default({}) keeps schema version 1: older documents without the field
    // still parse, so no migration is needed.
    alternatePower: z.record(alternatePowerEntry).default({}),
    nets: z.array(netDef),
    gpio: z.record(z.string().nullable()), // data-driven pin map; null = unassigned (§8)
  }),
  migrations: {},
});
export type HardwareProfile = z.infer<typeof hardwareProfile.shape>;
