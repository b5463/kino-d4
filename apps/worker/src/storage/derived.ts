/**
 * The only object keys a worker can build.
 *
 * ## Why this is not a copy of `apps/api/src/uploads/objectKeys.ts`
 *
 * That module is the source of truth for the 05 §6 key layout, and it builds
 * **both** halves of it — `original/` and `derived/`. Duplicating it here would
 * put `originalKey()` inside the workspace whose entire storage contract is
 * "workers may only write derivatives" (01 §7), and the invariant would then
 * rest on nobody ever calling a function that sits one import away.
 *
 * So this is not a duplicate: it is the derived-only half. A handler cannot
 * name an original because no function here can produce that key, and
 * `assertDerivedOnly` catches it a second time if this file is ever extended.
 * The `derived/` shapes below must stay identical to the API's — they address
 * the same bucket — which is what `derivedCaptureKey`'s test pins.
 *
 * `assertDerivedOnly` is the worker-side collapse of the API's
 * `assertNotOriginalOverwrite(key, stored, incoming)`: that guard lets a caller
 * through under `original/` only when it declares the sha256 of its own bytes,
 * and `putDerived(rollId, captureId, name, body, mime)` has nowhere to put one.
 * Every worker call therefore lands on the same branch, and writing that branch
 * out plainly is more honest than importing a three-argument check and passing
 * `null` twice.
 */

/** The prefix under which a capture's untouched camera frames live. */
const ORIGINAL_SEGMENT = 'original';

/** The prefix under which everything the platform *derives* lives. */
const DERIVED_SEGMENT = 'derived';

/**
 * A single path segment that cannot climb out of its prefix. `.` and `..` are
 * excluded by requiring the first character to be alphanumeric.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafe(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`unsafe ${what} in object key: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A relative name that may contain `/` — `frames/cam-01.webp` — with every
 * segment held to the same rule, so no combination of them escapes the prefix.
 */
function assertSafeName(name: string): string {
  for (const segment of name.split('/')) assertSafe(segment, 'name segment');
  return name;
}

/** `rolls/<rollId>/captures/<captureId>/derived/<name>` (05 §6). */
export function derivedCaptureKey(rollId: string, captureId: string, name: string): string {
  const folder = `rolls/${assertSafe(rollId, 'roll id')}/captures/${assertSafe(captureId, 'capture id')}`;
  return `${folder}/${DERIVED_SEGMENT}/${assertSafeName(name)}`;
}

/** Whether a key addresses an original camera frame rather than a derivative. */
export function isOriginalKey(key: string): boolean {
  return key.includes(`/${ORIGINAL_SEGMENT}/`);
}

/** A worker tried to write where only a camera may (01 §7). */
export class OriginalWriteError extends Error {
  readonly code = 'ORIGINAL_IMMUTABLE';

  constructor(key: string) {
    super(
      `refusing to write ${key}: originals are immutable and a worker cannot declare ` +
        'the digest of an original it did not capture',
    );
    this.name = 'OriginalWriteError';
  }
}

/**
 * The last check before bytes leave a worker. Nothing under `original/` passes,
 * including a name that smuggles the segment in below `derived/`.
 */
export function assertDerivedOnly(key: string): void {
  if (isOriginalKey(key)) throw new OriginalWriteError(key);
}
