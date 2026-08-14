import { z } from 'zod';
import { defineSchema } from './registry';

/** "WIDTHxHEIGHT" in pixels, e.g. "1600x1200" (01§2). */
const RESOLUTION = /^\d+x\d+$/;

/**
 * `kino.device-config` — the camera's committed settings (02§28, 04§8).
 *
 * The envelope (`schema`/`version`/`revision`) is validated; the `config` body
 * is only lightly validated and passes unknown keys through, so nested sections
 * such as `wiggle` (04§8) and sections added by later firmware survive a
 * read-modify-write round trip through Studio untouched.
 */
export const deviceConfig = defineSchema({
  schema: 'kino.device-config',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.device-config'),
      version: z.literal(1),
      /** Bumped by the device on every accepted config write (02§28, 04§8). */
      revision: z.number().int().nonnegative(),
      config: z
        .object({
          /**
           * Deliberately not an enum: 01§2 forbids hard-coding one mode set and
           * 03§12 already lists video/burst/panorama as future capture types
           * that older Studio builds must still be able to read.
           */
          mode: z.string().min(1),
          resolution: z.string().regex(RESOLUTION),
          /** Absent on a device with no flash hardware (07§14). */
          flash: z.string().min(1).optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  migrations: {},
});
export type DeviceConfig = z.infer<typeof deviceConfig.shape>;
