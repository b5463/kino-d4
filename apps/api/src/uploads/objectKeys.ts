/**
 * Every object key the platform writes, in one place (05 §6).
 *
 * Two rules make this a module rather than a handful of template literals:
 *
 * 1. **An object key is not authorization** (05 §6). Nothing here checks who is
 *    calling; the routes do that before they ever ask for a key. A key is only
 *    ever a *location*, and treating it as anything more is the mistake this
 *    file exists to keep out of the codebase.
 * 2. **Originals are immutable** (01 §7). The one guard below is what makes that
 *    an enforced property rather than a convention, and it lives next to the key
 *    builders so that no write path can reach a key without passing the guard's
 *    front door.
 */

/** The prefix under which a capture's untouched camera frames live. */
const ORIGINAL_SEGMENT = 'original';

/** The prefix under which everything the platform *derives* lives. */
const DERIVED_SEGMENT = 'derived';

/**
 * A single path segment that cannot climb out of its prefix.
 *
 * Ids are generated here (`roll_<base64url>`), so this is not defence against
 * our own generator — it is defence against the day a key is built from
 * something a device sent. `.` and `..` are excluded by requiring the first
 * character to be alphanumeric.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafe(value: string, what: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new Error(`unsafe ${what} in object key: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A relative name that may contain `/` — `exports/job_7.zip` — with every
 * segment held to the same rule, so no combination of them escapes the prefix.
 */
function assertSafeName(name: string): string {
  const segments = name.split('/');
  for (const segment of segments) assertSafe(segment, 'name segment');
  return name;
}

/** `rolls/<rollId>/captures/<captureId>` — the prefix both capture roles share. */
function captureFolder(rollId: string, captureId: string): string {
  return `rolls/${assertSafe(rollId, 'roll id')}/captures/${assertSafe(captureId, 'capture id')}`;
}

/**
 * `rolls/<rollId>/captures/<captureId>/original/cam-<NN>.jpg` (05 §6).
 *
 * The camera number is **1-based and zero-padded to two digits**, matching the
 * `CAM1..CAMn` labelling on the hardware and on the contact sheet. Padding is a
 * minimum width, not a truncation: a rig with more than 99 cameras would produce
 * `cam-100.jpg`, which still sorts correctly against `cam-01`..`cam-99`.
 *
 * `.jpg` is fixed by the spec, which is why `original-frame` uploads are
 * required to declare `image/jpeg` — a key that says one thing while the bytes
 * say another is a trap for every consumer downstream.
 */
export function originalKey(rollId: string, captureId: string, frameIndex: number): string {
  if (!Number.isInteger(frameIndex) || frameIndex < 1) {
    throw new Error(`frame index must be a positive integer, got ${String(frameIndex)}`);
  }
  const cam = String(frameIndex).padStart(2, '0');
  return `${captureFolder(rollId, captureId)}/${ORIGINAL_SEGMENT}/cam-${cam}.jpg`;
}

/** `rolls/<rollId>/captures/<captureId>/derived/<name>` (05 §6). */
export function derivedKey(rollId: string, captureId: string, name: string): string {
  return `${captureFolder(rollId, captureId)}/${DERIVED_SEGMENT}/${assertSafeName(name)}`;
}

/**
 * `rolls/<rollId>/derived/<name>` — outputs that belong to the *roll* rather
 * than to any one capture: Task 21's `exports/<jobId>.zip`, Task 25's
 * `recap/<jobId>.mp4`.
 */
export function rollDerivedKey(rollId: string, name: string): string {
  return `rolls/${assertSafe(rollId, 'roll id')}/${DERIVED_SEGMENT}/${assertSafeName(name)}`;
}

/** Whether a key addresses an original camera frame rather than a derivative. */
export function isOriginalKey(key: string): boolean {
  return key.includes(`/${ORIGINAL_SEGMENT}/`);
}

/**
 * Refusal to overwrite an original (01 §7).
 *
 * 409 rather than 422: the request is well-formed, the *state* is what refuses
 * — the same reading that makes `ROLL_CLOSED` a 409.
 */
export class OriginalOverwriteError extends Error {
  readonly statusCode = 409;
  readonly code = 'ORIGINAL_IMMUTABLE';

  constructor(key: string, why: string) {
    super(`refusing to write ${key}: ${why}`);
    this.name = 'OriginalOverwriteError';
  }
}

/**
 * The immutability guard every write path calls before it puts bytes anywhere.
 *
 * @param key             where the bytes are going.
 * @param storedSha256    the digest of what is already at that key, or `null`
 *                        when nothing is (the asset row is the record of this —
 *                        an asset that is not `ready` has stored nothing).
 * @param incomingSha256  the digest the caller *declares* for the bytes it is
 *                        about to write, or `null` when it cannot name one.
 *
 * Anything under `derived/` passes: re-rendering a thumbnail is the normal case
 * and a derivative is by definition reproducible.
 *
 * Under `original/` there are exactly two ways through, and a worker fits
 * neither:
 *
 * - the caller declares a digest and nothing is stored yet — the first upload;
 * - the caller declares a digest and it *equals* what is stored — a retried
 *   upload of the identical bytes, which is not an overwrite at all.
 *
 * A caller that cannot name the digest of its own payload is refused outright.
 * That is not a technicality — it is precisely the shape of every worker write
 * path (Task 22's `putDerived(rollId, captureId, name, body, mime)` has nowhere
 * to put a digest), so "workers may only write under `derived/`" falls out of
 * the same check rather than needing a second one that could disagree with it.
 */
export function assertNotOriginalOverwrite(
  key: string,
  storedSha256: string | null,
  incomingSha256: string | null,
): void {
  if (!isOriginalKey(key)) return;

  if (incomingSha256 === null) {
    throw new OriginalOverwriteError(
      key,
      'originals may only be written by a caller that declares the digest of its own bytes',
    );
  }
  if (storedSha256 !== null && storedSha256 !== incomingSha256) {
    throw new OriginalOverwriteError(key, 'an original with different content is already stored');
  }
}
