/**
 * Asset roles on the guest wire.
 *
 * Copied from `packages/schemas/src/media.ts#ASSET_ROLES`, deliberately, rather
 * than imported. `@kino/schemas` is a zod barrel and has no narrow entry point:
 * `media.ts` itself imports zod, so any path into it — the index or the module —
 * drags the whole validator into the guest bundle. That was 54,426 raw bytes to
 * describe fourteen strings, on a phone at a party, for a list this app only
 * ever uses as a membership test.
 *
 * `packages/schemas` stays normative. `tests/client.test.ts` imports the real
 * enum and asserts these two lists are identical, so a role added there fails
 * this app's test suite rather than drifting quietly.
 */
export const ASSET_ROLES = [
  'thumb',
  'kino-still',
  'original-frame',
  'wiggle-preview',
  'wiggle-webp',
  'wiggle-mp4',
  'gif',
  'contact-sheet',
  'enhanced-still',
  'enhanced-wiggle',
  'social-9x16',
  'social-4x5',
  'social-1x1',
  'metadata',
] as const;
