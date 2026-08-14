import { z } from 'zod';
import { defineSchema } from './registry';

/** "WIDTHxHEIGHT" in pixels, e.g. "2048x1536" (01§2). */
const RESOLUTION = /^\d+x\d+$/;

/**
 * `kino.device-info` — identity of one physical camera (01§3, 05§19).
 *
 * Naming note: 05§19 prints this example under `"schema": "kino.device"`, but
 * the canonical contract list in 01§3 names it `kino.device-info`. The 01§3
 * name is authoritative; 05§19 is a spec inconsistency.
 */
export const deviceInfo = defineSchema({
  schema: 'kino.device-info',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.device-info'),
      version: z.literal(1),
      id: z.string().min(1),
      serial: z.string().min(1),
      product: z.string().min(1),
      hardwareRevision: z.string().min(1),
      /** User-assigned label. A factory-fresh camera has none. */
      name: z.string().optional(),
    })
    .passthrough(),
  migrations: {},
});
export type DeviceInfo = z.infer<typeof deviceInfo.shape>;

/**
 * `kino.device-capabilities` — what this camera can actually do (01§2, 05§19).
 *
 * Everything except `cameraCount` is optional and every object level passes
 * unknown keys through: 01§2 forbids hard-coding four cameras / one sensor /
 * one sync method / one transport, and 07§14 requires Studio to tolerate
 * unknown future capability fields rather than fail the parse.
 */
export const deviceCapabilities = defineSchema({
  schema: 'kino.device-capabilities',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.device-capabilities'),
      version: z.literal(1),
      cameraCount: z.number().int().positive(),
      product: z.string().optional(),
      hardwareRevision: z.string().optional(),
      cameraSensor: z.string().optional(),
      maxResolution: z.string().regex(RESOLUTION).optional(),
      /** e.g. "vsync-assisted" today, "hardware" on a later device (01§2). */
      syncMethod: z.string().optional(),
      /** e.g. "uart" today, "mipi"/"usb" later (01§2). */
      cameraTransport: z.string().optional(),
      storage: z.array(z.string()).optional(),
      network: z.array(z.string()).optional(),
      display: z.boolean().optional(),
      speaker: z.boolean().optional(),
      /**
       * Feature flags. Values are `unknown`, not `boolean`: a future device may
       * report a list or a count under a name Studio has never seen, and 07§14
       * says that must not fail the parse. Read a flag as `features.x === true`.
       * Absent means "not advertised", i.e. unsupported.
       */
      features: z.record(z.unknown()).default({}),
      /** Numeric ceilings (max resolution, page size, baud …). Open by design. */
      limits: z.object({}).passthrough().optional(),
    })
    .passthrough(),
  migrations: {},
});
export type DeviceCapabilities = z.infer<typeof deviceCapabilities.shape>;
