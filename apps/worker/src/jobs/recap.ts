import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { UnrecoverableError } from 'bullmq';
import { execa } from 'execa';
import sharp from 'sharp';
import { wiggleSequence } from '@kino/media';
import { SHARP_INPUT } from '../images/decode';
import { recapJobs } from '../db/schema';
import { recapObjectKey } from '../storage/derived';
import { loadAssets, originalFrames, readObject, stillSource } from './capture';
import {
  jobRowIdOf,
  loadRoll,
  loadRollCaptures,
  requireRollId,
  type RollCaptureRow,
} from './roll';
import { evenPixels, WIGGLE_DIRECTION_DEFAULT, WIGGLE_LOOP_DEFAULT } from './wiggle';
import {
  FFMPEG_KILL_SIGNAL,
  WIGGLE_MP4_LEVEL,
  WIGGLE_MP4_PROFILE,
  resolveFfmpegPath,
} from './wiggleMp4';
import type { JobCtx, JobPayload, WorkerDatabase } from './types';

/**
 * `generate-recap` — the party as one chronological film (03 §21).
 *
 * A title card, then every capture of the roll in the order it was taken, 1.2
 * seconds each: a wiggle plays one bounce cycle, a still holds. 960 px wide, H.264
 * in MP4, at `rolls/<rollId>/derived/recap/<jobId>.mp4`.
 *
 * V1 is deliberately austere — no music, no transitions, no titles between
 * captures. 03 §21 lists those as *potential* outputs, and every one of them is a
 * decision about taste that a host has no way to express yet. A hard cut between
 * captures is the one edit that cannot be wrong.
 *
 * ## Why the frames are piped rather than staged
 *
 * The whole film goes into ffmpeg as one `rawvideo` stream on stdin, produced
 * lazily: each capture is fetched, decoded and yielded, then dropped. A 300-
 * capture roll is 3,612 frames, which at 960×720 RGB is 7 GB — so the one thing
 * this must not do is hold them. An async generator behind `Readable.from` gives
 * exactly that, with ffmpeg's own consumption rate as the backpressure.
 *
 * The bytes are the cost of the simplicity: a still contributes twelve copies of
 * one frame down the pipe. The alternative — a concat demuxer over per-segment
 * files with `duration` lines — sends a twelfth as much and adds a temp file per
 * capture, a list-file syntax with a well-known last-entry quirk, and a variable
 * frame rate that makes "how many frames is this" a question with two answers.
 * The pipe is local, x264 folds identical frames into almost nothing, and the
 * output frame count is exactly `(captures + 1) × 12`, which is a thing a test can
 * assert. When a recap needs music and transitions, it needs a filter graph
 * anyway, and this is the version to replace.
 *
 * ## What is in it
 *
 * Captures that are hidden or in the trash are absent — see `loadRollCaptures`.
 * A capture with nothing stored yet is skipped rather than fatal: a roll is not
 * owed a recap only once its last upload lands, and a missing frame must not cost
 * the host the other 299.
 */

/** 960 px wide, the same as the wiggle renders (02 §9) and for the same reason. */
export const RECAP_WIDTH = evenPixels(960);

/**
 * 10 fps — 02 §9's wiggle *default*, and fixed.
 *
 * ## It does not follow `captures.playback` (audit #11)
 *
 * The feed's renders do: `wiggleFpsFor` / `wiggleLoopFor` /
 * `wiggleDirectionFor` read the host's per-capture choice off the row, so a
 * capture the host set to 15 fps rtl continuous plays that way in the feed and
 * in its own MP4. The recap plays every capture at 10 fps, bounce, ltr,
 * whatever the row says. That is a real difference and this is the place it is
 * written down; the comment here used to claim the recap matched the feed,
 * which it never did.
 *
 * ## Why fixed
 *
 * The film is **one** `rawvideo` stream at **one** `-framerate`. A segment's
 * frame rate is not a property this pipeline has: `filmFrames` yields
 * `RECAP_SEGMENT_FRAMES` = 12 frames per capture and ffmpeg times all of them
 * at `RECAP_FPS`, so honouring a 15 fps capture would mean either re-timing one
 * segment inside a constant-rate stream — a filter graph, plus a variable frame
 * rate, plus "how many frames is this film" becoming a question with two
 * answers — or resampling the segment's 12 frames to look faster, which at 12
 * frames is a visibly different wiggle rather than the same one played quicker.
 *
 * Loop and direction *could* be read cheaply (`wiggleSequence` takes both, and
 * `segmentFor` already calls it), and are deliberately not: a recap is a film
 * of hard cuts (see the note at the top of this file), the segment is one
 * bounce cycle in 1.2 s by construction, and a `continuous` capture in the
 * middle of it would land mid-sweep at the cut. One rate, one loop, one
 * direction is the version that cannot be wrong; per-capture playback belongs
 * to the version of this job that has a filter graph.
 */
export const RECAP_FPS = 10;

/** 1.2 s per capture (03 §21). */
export const RECAP_SEGMENT_SECONDS = 1.2;

/** How many encoded frames one segment is. 12 at 10 fps — exactly, no rounding. */
export const RECAP_SEGMENT_FRAMES = Math.round(RECAP_SEGMENT_SECONDS * RECAP_FPS);

/** x264 CRF 23 — its default, and a recap is a convenience copy, not a master. */
export const RECAP_CRF = 23;

/**
 * x264's `-preset veryfast`, and this one goes the *other* way from the
 * wigglegram's `slow`.
 *
 * The two encodes are different sizes of problem. A wigglegram is 24 frames and
 * the preset costs 0.3 s. A recap of 300 captures is 3,612 frames and the worst
 * roll seen is 1,900 captures = 22,824 frames, all of them 960x720. At `medium`
 * that is minutes of x264 — and x264 here is not a background cost, it is the
 * thing draining the pipe: `filmFrames` yields into ffmpeg's stdin, so a slower
 * encoder applies backpressure to the fetch loop and pushes the whole job
 * toward `RECAP_TIMEOUT_MS`.
 *
 * `veryfast` at the same CRF is roughly 20–25 % more bytes and roughly 3x fewer
 * CPU seconds. On a film that is mostly held stills — twelve identical frames
 * per still segment, which x264 folds into almost nothing whatever the preset —
 * that percentage applies to a small number, and the recap is explicitly a
 * convenience copy.
 */
export const RECAP_PRESET = 'veryfast';

/**
 * How long one recap encode may take before it is killed.
 *
 * Longer than the wigglegram's two minutes because this one is not CPU-bound:
 * `filmFrames` fetches and decodes every capture of the roll *while* ffmpeg is
 * consuming the pipe, so the wall clock is dominated by S3 round trips. Order of
 * magnitude on the worst roll seen — 1,900 captures, four frames each — is one
 * GET plus one sharp decode per frame at maybe 20 ms each, which is around 40
 * minutes of fetching before a single x264 slice is the bottleneck.
 *
 * Ninety minutes is that with room, and it is still finite, which is the whole
 * point: without a timeout a wedged encoder holds one of the worker's
 * `JOB_CONCURRENCY` slots forever, and BullMQ's lock manager keeps renewing the
 * lock so nothing ever notices. A recap that hits this limit fails, its row says
 * `failed`, and the host can press the button again. A stalled S3 socket is
 * handled an order of magnitude sooner and closer to the fault, by the client's
 * own `requestTimeout` (`s3ClientOptions`).
 */
export const RECAP_TIMEOUT_MS = 90 * 60 * 1000;

/** "Plain type on dark grey, no decoration" (03 §21). */
export const RECAP_CARD_BACKGROUND = '#2a2a2a';
export const RECAP_CARD_INK = '#f2f2f2';

/**
 * How much of a roll title the card shows.
 *
 * A title is host-entered text with no length limit, and a card is one line of
 * type. Truncating is the honest failure: the alternative — shrinking the type
 * until it fits — produces a title card nobody can read, which is worse than a
 * title card that stops.
 */
export const RECAP_TITLE_MAX_CHARS = 44;

/** A recap of a roll with nothing renderable in it. */
export class EmptyRollError extends UnrecoverableError {
  readonly code = 'ROLL_HAS_NO_CAPTURES';

  constructor(rollId: string) {
    super(`roll ${rollId} has no capture with stored media; there is nothing to recap`);
    this.name = 'EmptyRollError';
  }
}

/** The MP4 was uploaded and storage does not have it. */
export class RecapNotDurableError extends Error {
  readonly code = 'RECAP_NOT_DURABLE';

  constructor(key: string) {
    super(`recap upload to ${key} was not confirmed by storage`);
    this.name = 'RecapNotDurableError';
  }
}

/**
 * The one line on the card: `<ROLL TITLE> — <date>` (03 §21).
 *
 * The date is ISO `YYYY-MM-DD`, not a localised long form. A localised month name
 * depends on the ICU data in whatever container the worker runs in, which would
 * make the same roll render two different cards on two machines — and `2026-08-14`
 * is unambiguous in every country a KINO ships to, which `08/14/2026` is not.
 */
export function recapTitleCardText(title: string, date: Date): string {
  const trimmed = title.trim();
  const shown =
    trimmed.length > RECAP_TITLE_MAX_CHARS
      ? `${trimmed.slice(0, RECAP_TITLE_MAX_CHARS - 1).trimEnd()}…`
      : trimmed;
  return `${shown} — ${date.toISOString().slice(0, 10)}`;
}

/** XML-escapes the one place host text reaches a document we generate. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The title card, as raw RGB at the film's geometry.
 *
 * Rendered through sharp's SVG input rather than ffmpeg's `drawtext`, because
 * `drawtext` needs an ffmpeg built with libfreetype and `FFMPEG_PATH` points at
 * whatever build the operator chose (see `resolveFfmpegPath`). A card that fails
 * to render on a perfectly good ffmpeg is a worse trade than depending on sharp,
 * which is already how every other pixel in this platform is produced.
 *
 * `font-family="sans-serif"` resolves through fontconfig to whatever the host has.
 * The card is one line of plain type: which grotesque it lands on does not matter,
 * and naming a font the container does not ship would matter a great deal.
 */
export async function renderTitleCard(
  text: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const fontSize = Math.max(16, Math.round(width / 26));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">
  <rect width="100%" height="100%" fill="${RECAP_CARD_BACKGROUND}"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        font-family="sans-serif" font-size="${String(fontSize)}" fill="${RECAP_CARD_INK}"
        >${escapeXml(text)}</text>
</svg>`;

  return sharp(Buffer.from(svg), SHARP_INPUT)
    // The rect is opaque and covers the frame, so dropping alpha composites
    // nothing away; `flatten` is still here for the degenerate case of an SVG
    // that rendered no rect at all — a transparent frame in a yuv420p stream is
    // black, and black is not the dark grey the spec asks for.
    .flatten({ background: RECAP_CARD_BACKGROUND })
    .removeAlpha()
    .raw()
    .toBuffer();
}

/** The distinct pixels of one segment, and the order they play in. */
interface Segment {
  pixels: Buffer[];
  order: number[];
}

/** Decodes one stored image to the film's exact geometry. */
async function decodeTo(source: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(source, SHARP_INPUT)
    // EXIF orientation first, or a rig that reports a rotation renders sideways.
    .rotate()
    // Both dimensions fixed with `cover`: every frame of the film is one row of
    // one raw video stream, and a frame of a different size is not a smaller
    // frame — it is a corrupt stream.
    .resize({ width, height, fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer();
}

/**
 * The film's height, from the first capture that has pixels to read.
 *
 * From the image rather than from `captures.resolution` for the same reason the
 * wiggle renders do it: the row is what the device declared and the render has to
 * match what it uploaded. Then forced even, because libx264 with `yuv420p`
 * subsamples chroma 2×2 and refuses an odd height outright.
 */
async function filmHeight(ctx: JobCtx, captures: readonly RollCaptureRow[]): Promise<number> {
  for (const capture of captures) {
    const rows = await loadAssets(ctx.db, capture.id);
    const frames = originalFrames(rows);
    let key: string | null = frames[0]?.objectKey ?? null;
    if (key === null) {
      try {
        key = stillSource(capture, rows).key;
      } catch {
        continue;
      }
    }

    const { width, height, orientation } = await sharp(await readObject(ctx, key), SHARP_INPUT).metadata();
    if (width === undefined || height === undefined || width <= 0 || height <= 0) continue;

    // Orientations 5–8 are displayed a quarter turn round, which is what
    // `.rotate()` in `decodeTo` will do.
    const turned = orientation !== undefined && orientation >= 5;
    const shownWidth = turned ? height : width;
    const shownHeight = turned ? width : height;
    return evenPixels(Math.round((RECAP_WIDTH * shownHeight) / shownWidth));
  }
  return 0;
}

/**
 * One capture's segment, or `null` when it has nothing stored.
 *
 * A wiggle with two or more stored frames plays a bounce sequence, built by the
 * same `@kino/media` function the feed's player and the baked WebP use — but
 * with the 02 §9 *defaults*, not with the host's per-capture playback choice.
 * See `RECAP_FPS` for why the whole film is fixed at 10 fps / bounce / ltr.
 * Anything else — a single, a quad, a wiggle whose frames have not all arrived
 * — is the capture's still, held.
 *
 * The sequence runs over the frames that are *stored*, not over
 * `captures.frame_count`: a capture mid-upload wiggles as three frames rather than
 * indexing one that is not there.
 */
async function segmentFor(
  ctx: JobCtx,
  capture: RollCaptureRow,
  width: number,
  height: number,
): Promise<Segment | null> {
  const rows = await loadAssets(ctx.db, capture.id);
  const frames = originalFrames(rows);

  if (capture.mode === 'wiggle' && frames.length >= 2) {
    const pixels: Buffer[] = [];
    for (const frame of frames) {
      pixels.push(await decodeTo(await readObject(ctx, frame.objectKey), width, height));
    }
    return {
      pixels,
      order: wiggleSequence(pixels.length, WIGGLE_LOOP_DEFAULT, WIGGLE_DIRECTION_DEFAULT),
    };
  }

  let key: string;
  try {
    key = stillSource(capture, rows).key;
  } catch {
    // No still and no stored frame: the capture is still uploading, or it lost
    // everything. Either way it contributes nothing and costs the film nothing.
    return null;
  }
  return { pixels: [await decodeTo(await readObject(ctx, key), width, height)], order: [0] };
}

/**
 * Every frame of the film, in order, one at a time.
 *
 * The title card first (03 §21), then one segment per capture. Each segment is
 * stretched to `RECAP_SEGMENT_FRAMES` by index — `order[floor(i × len / 12)]` —
 * which spreads a 6-entry bounce over 12 frames as two frames each, exactly one
 * cycle in 1.2 s, and holds a 1-entry still for all twelve.
 */
async function* filmFrames(
  ctx: JobCtx,
  card: Buffer,
  captures: readonly RollCaptureRow[],
  width: number,
  height: number,
  counter: { segments: number },
): AsyncGenerator<Buffer> {
  for (let i = 0; i < RECAP_SEGMENT_FRAMES; i += 1) yield card;
  counter.segments += 1;

  for (const capture of captures) {
    const segment = await segmentFor(ctx, capture, width, height);
    if (segment === null) continue;

    for (let i = 0; i < RECAP_SEGMENT_FRAMES; i += 1) {
      const at = segment.order[Math.floor((i * segment.order.length) / RECAP_SEGMENT_FRAMES)];
      const pixels = at === undefined ? undefined : segment.pixels[at];
      if (pixels === undefined) {
        throw new Error(`recap segment for capture ${capture.id} named a frame that is absent`);
      }
      yield pixels;
    }
    counter.segments += 1;
  }
}

/* --------------------------------------------------------------- the row -- */

/**
 * Takes the job's row, or creates it.
 *
 * Upsert rather than update, because a recap can be queued from two directions: a
 * future host route that claims a row first (the way `claimExportJob` does), or a
 * worker-side fan-out that only has a job key. Neither should have to know which
 * one it is. The insert can still lose to `recap_jobs_roll_live` when another
 * recap of the same roll is live — that is the index doing its job, and the
 * resulting failure is a retry.
 */
async function claimRecapRow(db: WorkerDatabase, jobId: string, rollId: string): Promise<void> {
  await db
    .insert(recapJobs)
    .values({ id: jobId, rollId, status: 'running' })
    .onConflictDoUpdate({
      target: recapJobs.id,
      set: { status: 'running', error: null, finishedAt: null },
    });
}

async function finishRecapRow(
  db: WorkerDatabase,
  jobId: string,
  status: 'done' | 'failed',
  error: string | null,
): Promise<void> {
  await db
    .update(recapJobs)
    .set({ status, error, finishedAt: new Date() })
    .where(eq(recapJobs.id, jobId));
}

/* ------------------------------------------------------------ the handler -- */

export async function generateRecap(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const rollId = requireRollId(payload);
  const jobId = jobRowIdOf(payload);

  await claimRecapRow(ctx.db, jobId, rollId);

  try {
    const roll = await loadRoll(ctx.db, rollId);
    const captures = await loadRollCaptures(ctx.db, rollId, { includeHidden: false });

    const height = await filmHeight(ctx, captures);
    if (height === 0) throw new EmptyRollError(rollId);

    const card = await renderTitleCard(
      recapTitleCardText(roll.title, roll.createdAt),
      RECAP_WIDTH,
      height,
    );

    const ffmpegPath = await resolveFfmpegPath();
    const dir = await mkdtemp(join(tmpdir(), `kino-recap-${jobId}-`));
    const outputPath = join(dir, 'recap.mp4');

    const counter = { segments: 0 };
    try {
      await execa(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-video_size',
          `${String(RECAP_WIDTH)}x${String(height)}`,
          '-framerate',
          String(RECAP_FPS),
          '-i',
          '-',
          '-r',
          String(RECAP_FPS),
          // No audio: the input is a rawvideo pipe, so this changes no bytes —
          // it stops a future filter graph from quietly adding a track.
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          RECAP_PRESET,
          // Baseline at level 3.1, the same compatibility trade the wigglegram
          // MP4 makes and for the same reason — a recap is a file a host sends
          // to people. See `WIGGLE_MP4_PROFILE`.
          '-profile:v',
          WIGGLE_MP4_PROFILE,
          '-level:v',
          WIGGLE_MP4_LEVEL,
          '-pix_fmt',
          'yuv420p',
          '-crf',
          String(RECAP_CRF),
          // `moov` at the front, so a browser can start playing before the whole
          // file has arrived — and the reason the output is a seekable file
          // rather than a pipe, since faststart rewrites the container at the end.
          '-movflags',
          '+faststart',
          outputPath,
        ],
        {
          input: Readable.from(filmFrames(ctx, card, captures, RECAP_WIDTH, height, counter)),
          timeout: RECAP_TIMEOUT_MS,
          killSignal: FFMPEG_KILL_SIGNAL,
        },
      );

      if (counter.segments < 2) throw new EmptyRollError(rollId);

      const name = `recap/${jobId}.mp4`;
      const key = await ctx.putRollDerivedFile(rollId, name, outputPath, 'video/mp4');

      // Same rule as the export: the row does not say `done` until storage
      // agrees the file is there. A recap row claiming success over a missing
      // object is a host told their film is ready and handed nothing.
      const { size } = await stat(outputPath);
      const stored = await ctx.statObject(key);
      if (stored === null || stored !== size) throw new RecapNotDurableError(key);
    } finally {
      // Whether the encode worked or not: a failed render is retried, and a
      // worker that leaked a partial MP4 per attempt fills its disk on the one
      // roll that never succeeds.
      await rm(dir, { recursive: true, force: true });
    }

    await finishRecapRow(ctx.db, jobId, 'done', null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRecapRow(ctx.db, jobId, 'failed', message.slice(0, 500));
    // Rethrown so BullMQ, not this function, decides about retrying — and so an
    // `UnrecoverableError` keeps being one.
    throw err;
  }
}

/** Where the recap of one job would be, for a caller that has the ids. */
export function recapKeyFor(rollId: string, jobId: string): string {
  return recapObjectKey(rollId, jobId);
}
