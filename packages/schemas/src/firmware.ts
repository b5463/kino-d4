import { z } from 'zod';
import { defineSchema } from './registry';

/** Lowercase hex SHA-256 digest. */
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * One flashable image. `version` is optional because 04§12's device-facing
 * manifest omits it while 05§19's catalog manifest carries it per target.
 */
const target = z
  .object({
    file: z.string().min(1),
    sha256: z.string().regex(SHA256),
    version: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * `kino.firmware-manifest` — what a firmware package contains and where it may
 * be installed (04§12, 05§19).
 *
 * `targets` is an open record, not a fixed `{ main, cameraNode }` pair: 01§2
 * forbids hard-coding one firmware target, so a later device may ship extra
 * nodes. `updateOrder` lets the manifest override Studio's default sequencing
 * (02§21) and is optional — absent means Studio picks the order.
 */
export const firmwareManifest = defineSchema({
  schema: 'kino.firmware-manifest',
  version: 1,
  shape: z
    .object({
      schema: z.literal('kino.firmware-manifest'),
      version: z.literal(1),
      release: z.string().min(1),
      /** Release channel, e.g. "stable" (05§19). Absent on a hand-built package. */
      channel: z.string().min(1).optional(),
      protocolMin: z.number().int().nonnegative(),
      protocolMax: z.number().int().nonnegative(),
      compatibleHardware: z.array(z.string().min(1)).min(1),
      targets: z.record(target),
      updateOrder: z.array(z.string().min(1)).optional(),
    })
    .passthrough(),
  migrations: {},
});
export type FirmwareManifest = z.infer<typeof firmwareManifest.shape>;
