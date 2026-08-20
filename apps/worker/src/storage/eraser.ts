import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import type { WorkerConfig } from '../config';
import { captureFolderPrefix } from './derived';

/**
 * The one code path in the platform that may delete an original (03 §11), and
 * the shape that keeps it the only one.
 *
 * ## The problem
 *
 * `guardOriginalWrites` puts `DeleteObjectCommand` on its write list, so
 * `ctx.s3` refuses to delete anything under `original/`. That is correct for
 * every handler that exists — and it is also exactly what the trash purge has to
 * do. "Delete is destructive" (03 §11) means the frames go, not that the row
 * goes and the bytes stay.
 *
 * So the guard needs an escape, and the escape must be narrow enough that a
 * derivative handler cannot walk through it by accident or by copying a nearby
 * line.
 *
 * ## The escape, and why it is this one
 *
 * A second S3 client, guarded in the *opposite* direction. `guardEraseOnly`
 * refuses every command that is not one of four — list, and the two deletes —
 * and refuses any key outside a capture folder. The trade is exact and it is a
 * trade, not a loosening:
 *
 * | | `ctx.s3` | the eraser |
 * |---|---|---|
 * | put/copy/multipart/tagging/acl/retention | allowed under `derived/` | **refused outright** |
 * | delete under `derived/` | allowed | allowed, inside one capture folder |
 * | delete under `original/` | refused | allowed, inside one capture folder |
 * | get | allowed | refused |
 *
 * It gains "delete an original" and loses the ability to *write* a single byte
 * anywhere. A client that cannot put, copy, tag or retain cannot overwrite an
 * original — which is the property 01 §7 is actually about — so the immutability
 * rule survives the escape rather than being suspended for it.
 *
 * ## Why a derivative handler cannot reach it
 *
 * The eraser is **not on `JobCtx`**. A handler is handed `(payload, ctx)` and
 * `ctx` has no member of this type, so there is nothing to call: reaching it
 * would mean changing this file's callers, not writing a line inside a handler.
 * `purge-trash` receives it as a closed-over argument, minted once in `main.ts`
 * from `WorkerConfig` — which handlers are also not given.
 *
 * That is a real boundary and not a total one, and it is worth being exact about
 * where it stops. A handler could import `createEraser`, call
 * `loadWorkerConfig()` off `process.env`, and build its own. Nothing in a Node
 * process can stop that — the same sentence is already true of `new S3Client()`
 * with no guard at all, which is the hole `guardOriginalWrites` was never able to
 * close either (see the note on `JobCtx`). What the shape here buys is that the
 * capability is absent from the surface a handler is *given*, so no handler
 * acquires it by mistake, and any handler that acquired it on purpose did so in a
 * diff that says so in three places. Making it impossible belongs in the
 * credentials — a purge-only IAM principal with `s3:DeleteObject` and no
 * `s3:PutObject` — not in a wrapper a handler could decline to use.
 */

/**
 * What the eraser may do. Reads are `ListObjectsV2` only — enough to find what a
 * capture folder still holds, not enough to fetch a frame — and the two deletes.
 *
 * Nothing that writes is here, and that is the whole point: a client that can
 * delete an original but cannot put one is strictly less dangerous than
 * `ctx.s3`, which can put and copy under `derived/`.
 */
const ERASE_COMMANDS: ReadonlySet<string> = new Set([
  'ListObjectsV2Command',
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
]);

/**
 * A key or prefix the eraser may address: inside some capture's own folder.
 *
 * `rolls/<rollId>/captures/<captureId>/…`, with both ids held to a single path
 * segment, so a crafted id cannot walk the prefix up to `rolls/` and delete a
 * roll — or the bucket.
 */
const CAPTURE_SCOPED = /^rolls\/[A-Za-z0-9][A-Za-z0-9._-]*\/captures\/[A-Za-z0-9][A-Za-z0-9._-]*\//;

/** The eraser was pointed somewhere that is not one capture's folder. */
export class EraseScopeError extends Error {
  readonly code = 'ERASE_OUT_OF_SCOPE';

  constructor(what: string, value: string) {
    super(`the media eraser may not touch ${what} ${JSON.stringify(value)}: not a capture folder`);
    this.name = 'EraseScopeError';
  }
}

/** The eraser was asked to do something other than list or delete. */
export class EraseCommandError extends Error {
  readonly code = 'ERASE_COMMAND_REFUSED';

  constructor(commandName: string) {
    super(`the media eraser may only list and delete; refusing ${commandName}`);
    this.name = 'EraseCommandError';
  }
}

function keysOf(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const { Key, Prefix, Delete } = input as { Key?: unknown; Prefix?: unknown; Delete?: unknown };

  const keys: string[] = [];
  if (typeof Key === 'string') keys.push(Key);
  // A list with no prefix would enumerate the whole bucket, so an absent one is
  // not "nothing to check" — it is the broadest possible request.
  if (typeof Prefix === 'string' || 'Prefix' in (input as object)) keys.push(String(Prefix ?? ''));

  const objects = (Delete as { Objects?: unknown } | undefined)?.Objects;
  if (Array.isArray(objects)) {
    for (const entry of objects) {
      const entryKey = (entry as { Key?: unknown }).Key;
      keys.push(typeof entryKey === 'string' ? entryKey : '');
    }
  }
  return keys;
}

/**
 * Restricts a client to listing and deleting inside capture folders.
 *
 * The inverse of `guardOriginalWrites`: that one names the commands it refuses,
 * this one names the three it allows. An allowlist is right here because the
 * client's whole reason to exist is that it may destroy originals — a new AWS SDK
 * command should arrive refused, not permitted.
 */
export function guardEraseOnly(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const commandName = (context as { commandName?: string }).commandName;
      if (commandName === undefined || !ERASE_COMMANDS.has(commandName)) {
        throw new EraseCommandError(commandName ?? 'an unnamed command');
      }
      for (const key of keysOf(args.input)) {
        if (!CAPTURE_SCOPED.test(key)) throw new EraseScopeError('the key', key);
      }
      return next(args);
    },
    { step: 'initialize', name: 'kinoEraseScopeGuard', priority: 'high' },
  );
}

/** Deletes every stored object of one capture. Nothing else. */
export interface MediaEraser {
  /**
   * Removes everything under `rolls/<rollId>/captures/<captureId>/`.
   *
   * @returns how many objects were deleted, which is 0 on a capture whose
   *          objects a previous run already removed — not an error, see
   *          `purgeTrash`'s re-entrancy note.
   */
  eraseCapture(rollId: string, captureId: string): Promise<number>;
  close(): void;
}

/** S3 caps one `DeleteObjects` request at 1000 keys. */
const DELETE_BATCH = 1000;

export function createEraser(config: WorkerConfig): MediaEraser {
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  });
  guardEraseOnly(client);

  return {
    async eraseCapture(rollId: string, captureId: string): Promise<number> {
      const prefix = captureFolderPrefix(rollId, captureId);
      let deleted = 0;
      let token: string | undefined;

      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.S3_BUCKET,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: DELETE_BATCH,
          }),
        );
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;

        /*
         * Listed rather than derived from the asset rows, and that is what makes
         * the purge complete rather than nearly complete. A capture can hold an
         * object no row names — a derivative whose row write failed after its
         * `putDerived`, an upload abandoned mid-multipart — and a purge that
         * walked the rows would leave those bytes in the bucket forever with
         * nothing left to find them by, since the rows are about to go.
         */
        const batch: ObjectIdentifier[] = [];
        for (const entry of page.Contents ?? []) {
          if (typeof entry.Key === 'string') batch.push({ Key: entry.Key });
        }
        if (batch.length === 0) continue;

        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: config.S3_BUCKET,
            // `Quiet: false` so `Errors` comes back populated; a delete that
            // silently failed would let the rows go and orphan the bytes, which
            // is the one ordering this job must never produce.
            Delete: { Objects: batch, Quiet: false },
          }),
        );
        const errors = result.Errors ?? [];
        if (errors.length > 0) {
          const first = errors[0];
          throw new Error(
            `could not erase ${String(errors.length)} object(s) of capture ${captureId}: ` +
              `${String(first?.Key)} — ${String(first?.Code)} ${String(first?.Message)}`,
          );
        }
        deleted += result.Deleted?.length ?? batch.length;
      } while (token !== undefined);

      return deleted;
    },

    close(): void {
      client.destroy();
    },
  };
}
