/**
 * A cheap, stable fingerprint for a baked module, so the screen can tell a
 * rebuilt kino-ui.wasm from the one it is running without trusting HTTP
 * caching headers a dev server may or may not send. FNV-1a over the bytes:
 * a few hundred kilobytes hash in about a millisecond, and eight hex digits
 * are plenty to notice a new bake — this is not a security check.
 */
export function moduleHash(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
