import { z } from 'zod';
import { defineSchema } from './registry';

/**
 * `kino.device-config` — the camera's committed settings (02§28, 04§8).
 *
 * The envelope (`schema`/`version`/`revision`) is validated; the `config`
 * body mirrors the wire envelope `GET_CONFIG` answers (`KinoConfig` in
 * `@kino/kdp`): a `mode` string and the four section objects every firmware
 * since 0.2.0 sends — `wiggle`, `quad`, `shoot`, `body` — plus the optional
 * `roll` (credentials, write-only token scrubbed) and `network` (the D3
 * `apiBase` override) blocks. Each section is a passthrough object: the
 * fields inside are the firmware's to add to, and a Studio build must survive
 * a read-modify-write round trip of keys it does not model (04§8).
 *
 * The earlier shape declared a top-level `resolution` and a string `flash`.
 * Neither exists on the wire — resolution lives in `wiggle.resolution` and
 * flash is `wiggle.flash` / `quad.flash`, both booleans — so a real
 * `GET_CONFIG` reply never parsed and the fixture that did was a document no
 * camera ever sent.
 */
const section = z.object({}).passthrough();

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
          wiggle: section,
          quad: section,
          shoot: section,
          body: section,
          roll: section.optional(),
          network: section.optional(),
        })
        .passthrough(),
    })
    .passthrough(),
  migrations: {},
});
export type DeviceConfig = z.infer<typeof deviceConfig.shape>;
