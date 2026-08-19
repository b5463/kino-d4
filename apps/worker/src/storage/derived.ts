/**
 * Originals are immutable (01 §7): the keys a worker can build, and the guard
 * that makes that true of its S3 client rather than of its authors.
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

import type { S3Client } from '@aws-sdk/client-s3';

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

/* ------------------------------------------------------------ the client -- */

/**
 * Every S3 operation that can destroy or replace an object.
 *
 * Reads are absent on purpose: a handler must be able to fetch the frames it
 * works on, and reading an original is the normal case. The multipart commands
 * are here because "upload it in parts" is a write like any other,
 * `DeleteObjects` because a batch delete is a delete, and `UploadPartCopy`
 * because a part whose bytes come from another object is still a part of a new
 * object at the destination key.
 *
 * The three metadata mutators are the ones a guard is most likely to be missing,
 * and the ones that make its promise false while looking harmless. None of them
 * changes an object's bytes; every one of them changes what the object *is*.
 * `PutObjectTagging` rewrites the tags a lifecycle rule may act on, so it can get
 * an original deleted without ever addressing its bytes. `PutObjectAcl` can make
 * a private original world-readable. `PutObjectRetention` can pin an object
 * against deletion — or, with governance bypass, unpin one. "Originals are
 * immutable" (01 §7) has to mean the object, not only its body.
 */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'PutObjectCommand',
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'CopyObjectCommand',
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'UploadPartCopyCommand',
  'CompleteMultipartUploadCommand',
  'PutObjectTaggingCommand',
  'DeleteObjectTaggingCommand',
  'PutObjectAclCommand',
  'PutObjectRetentionCommand',
  'PutObjectLegalHoldCommand',
]);

/**
 * The keys an operation would write, out of an input whose shape depends on the
 * command: `Key` for the single-object ones — and for `CopyObject` that is the
 * *destination*, so copying an original into `derived/` stays legal — and
 * `Delete.Objects[].Key` for the batch delete.
 */
function writtenKeys(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const { Key, Delete } = input as { Key?: unknown; Delete?: unknown };

  const keys: string[] = [];
  if (typeof Key === 'string') keys.push(Key);

  const objects = (Delete as { Objects?: unknown } | undefined)?.Objects;
  if (Array.isArray(objects)) {
    for (const entry of objects) {
      const entryKey = (entry as { Key?: unknown }).Key;
      if (typeof entryKey === 'string') keys.push(entryKey);
    }
  }
  return keys;
}

/**
 * Makes "a worker never writes an original" a property of the client rather
 * than of the people who write handlers.
 *
 * `putDerived` cannot address an original, but `ctx.s3` is a whole S3 client and
 * a handler needs it to *read* — which left the invariant one `PutObjectCommand`
 * away from being broken by an author who did not know the rule. 01 §7 is not a
 * convention, so it is enforced where every write must pass: in the client's own
 * middleware stack, before the request is serialised.
 *
 * `putDerived` rides the same guard rather than bypassing it, so there is one
 * check on one path and no way to be inside the exception.
 *
 * The equivalent hole in `ctx.db` is *not* closed here — see the note on
 * `JobCtx`. A handler can still insert an asset row that points anywhere, and no
 * middleware can tell a legitimate derivative row from a lie about an original.
 */
export function guardOriginalWrites(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      // `initialize` runs before the request is built, so the check reads the
      // command's own input rather than trying to parse a signed HTTP request
      // back into a key.
      const commandName = (context as { commandName?: string }).commandName;
      if (commandName !== undefined && WRITE_COMMANDS.has(commandName)) {
        for (const key of writtenKeys(args.input)) assertDerivedOnly(key);
      }
      return next(args);
    },
    { step: 'initialize', name: 'kinoOriginalWriteGuard', priority: 'high' },
  );
}
