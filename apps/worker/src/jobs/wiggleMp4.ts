import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadCapture, requireCaptureId } from './capture';
import { publishDerived } from './derive';
import { joinPages, loadWiggleFrames, WIGGLE_MP4_CRF, WIGGLE_MP4_LOOPS } from './wiggle';
import type { JobCtx, JobPayload } from './types';

/**
 * `render-wiggle-mp4` — the wiggle as a video, for taking out of the app
 * (03 §15, 05 §19 role `wiggle-mp4`).
 *
 * The WebP is what plays in the feed; this is what survives being sent to
 * somebody. Chat apps, camera rolls and social uploads all accept H.264 in MP4
 * and most of them will not animate a WebP, so the same six frames exist twice on
 * purpose.
 *
 * ## Not enqueued at capture-complete
 *
 * Nothing queues this job yet. It is the heaviest render the platform has and the
 * least often wanted — a party produces hundreds of captures and a handful of
 * downloads — so it is produced on first request rather than for every capture on
 * the off chance (03 §19's job list is what the platform *can* run, not what it
 * must). The enqueue site belongs to the request path, not here.
 *
 * ## The encode
 *
 * Frames go in as `rawvideo` on stdin: they are already decoded and resized by
 * `loadWiggleFrames`, so nothing is compressed on the way into x264 and the file
 * a guest downloads carries exactly one generation of loss.
 *
 * The repeat is ffmpeg's `loop` filter rather than four copies of the pixels in
 * the pipe: at 960×720 RGB a frame is 2 MB, and piping 24 of them would move
 * 50 MB through a socket to say the same thing as `loop=loop=3`. `-r` is set on
 * the output as well as `-framerate` on the input, so the timestamps ffmpeg writes
 * are the frame rate asked for rather than whatever the filter graph inferred.
 *
 * `-movflags +faststart` moves the `moov` atom to the front, which is what lets a
 * browser start playing before the whole file has arrived — and it is also why the
 * output goes to a temp file rather than a pipe: faststart rewrites the container
 * after the last frame is written, so it needs an output it can seek.
 *
 * ## Where the binary comes from
 *
 * `FFMPEG_PATH` if the operator set it; `ffmpeg-static` otherwise. See
 * `resolveFfmpegPath`.
 */
/** The variable an operator points at their own ffmpeg. */
const FFMPEG_PATH_VAR = 'FFMPEG_PATH';

/**
 * The ffmpeg binary to run: `FFMPEG_PATH` when the operator set it, the bundled
 * `ffmpeg-static` build otherwise.
 *
 * Two reasons the environment wins, and neither is style.
 *
 * 1. **`-c:v libx264` is mandated (03 §15) and libx264 is GPL.** A deployment that
 *    distributes this worker has a licence obligation over that binary, and it is
 *    the operator's to discharge — with a build they chose and can account for.
 *    Baking `ffmpeg-static`'s prebuilt download in as the only option would make
 *    this repository's dependency graph the thing that ships the GPL component.
 *    (Discharged in issue #22: the worker image uses Debian's ffmpeg and drops
 *    the npm binaries; THIRD_PARTY_NOTICES.md carries the source offer.)
 * 2. **`ffmpeg-static` downloads its binary in a postinstall script.** As a hard
 *    requirement, that turns a restricted-egress `npm ci` into a failed install
 *    for all seven workspaces over a dependency six of them never use. So the
 *    import is *dynamic*: with `FFMPEG_PATH` set, this function never loads the
 *    module at all, and `npm ci --ignore-scripts` is enough to run the worker.
 *
 * `ffmpeg-static` stays in `dependencies` so a developer with no ffmpeg on their
 * machine still gets working renders from a plain `npm install`.
 *
 * The path is not validated here beyond being non-blank: a wrong path fails on
 * the first `execa` call with ffmpeg's own error, which says more than a
 * stat-based guess would.
 */
export async function resolveFfmpegPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = env[FFMPEG_PATH_VAR];
  // A blank value counts as unset, the same rule `loadWorkerConfig` uses, so an
  // empty line in a .env file falls back instead of exec'ing "".
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();

  const { default: bundled } = await import('ffmpeg-static');
  if (bundled === null) {
    throw new Error(
      `ffmpeg-static has no binary for this platform: set ${FFMPEG_PATH_VAR} to an ` +
        'ffmpeg built with libx264',
    );
  }
  return bundled;
}

export async function renderWiggleMp4(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const wiggle = await loadWiggleFrames(ctx, capture);

  const ffmpegPath = await resolveFfmpegPath();

  const dir = await mkdtemp(join(tmpdir(), `kino-wiggle-${captureId}-`));
  const outputPath = join(dir, 'wiggle.mp4');

  let body: Buffer;
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
        `${wiggle.width}x${wiggle.height}`,
        '-framerate',
        String(wiggle.fps),
        '-i',
        '-',
        // `size` is the sequence; `loop` is how many *extra* times to replay it.
        '-filter_complex',
        `loop=loop=${WIGGLE_MP4_LOOPS - 1}:size=${wiggle.order.length}:start=0`,
        '-r',
        String(wiggle.fps),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        String(WIGGLE_MP4_CRF),
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { input: joinPages(wiggle) },
    );

    body = await readFile(outputPath);
  } finally {
    // The temp directory goes whether the encode worked or not: a failed render
    // is retried, and a worker that leaked a partial MP4 per attempt would fill
    // its disk on the one capture that never succeeds.
    await rm(dir, { recursive: true, force: true });
  }

  await publishDerived(ctx, capture, {
    name: 'wiggle.mp4',
    role: 'wiggle-mp4',
    mime: 'video/mp4',
    body,
    width: wiggle.width,
    height: wiggle.height,
    producer: { job: 'wiggle-mp4', encoder: 'ffmpeg/x264', crf: WIGGLE_MP4_CRF, loops: WIGGLE_MP4_LOOPS, fps: wiggle.fps },
  });
}
