/**
 * Regenerates the four camera frames in `packages/test-fixtures/media/`.
 *
 *   npm run fixtures:media -w @kino/test-fixtures
 *
 * The worker's image jobs (Task 23) need real JPEG bytes at the real D4 frame
 * size — 1600×1200 (01 §2) — because what they are tested on is the *pixels*:
 * a thumbnail's width, a contact sheet's geometry, an EXIF block that survives
 * a round trip. A stub file cannot fail those assertions honestly.
 *
 * The output is deterministic: no randomness, no timestamps, so re-running this
 * script on any machine produces byte-identical files and the committed
 * fixtures can be regenerated and diffed.
 *
 * Each frame is flat colour plus one white marker bar whose position encodes the
 * camera index, so a test that picks "the middle frame" can prove *which* frame
 * it got by sampling a pixel rather than by trusting the filename. Flat colour
 * is also why these compress to a few kilobytes each, which is what makes
 * committing them reasonable.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/** 01 §2: every D4 camera delivers 1600×1200. */
const FIXTURE_WIDTH = 1600;
const FIXTURE_HEIGHT = 1200;

/** Four cameras, one row (01 §2). Frame indices are 1-based, as in `cam-01.jpg`. */
const FIXTURE_FRAME_COUNT = 4;

/** One flat base colour per camera, far enough apart to tell apart by eye. */
const BASE_COLOURS: readonly string[] = ['#1d3f6e', '#6e1d3f', '#3f6e1d', '#6e5a1d'];

/** `frame-01.jpg` … `frame-04.jpg`. */
function fixtureFrameName(frameIndex: number): string {
  return `frame-${String(frameIndex).padStart(2, '0')}.jpg`;
}

/** Where the marker bar sits for a given camera, in source pixels. */
function markerLeft(frameIndex: number): number {
  return 120 + (frameIndex - 1) * 340;
}

const MARKER_WIDTH = 160;
const MARKER_HEIGHT = 400;
const MARKER_TOP = 400;

/**
 * One frame's JPEG bytes.
 *
 * EXIF is written on every frame, not only the first: `extract-metadata` reads
 * frame 1, but a test that wants to prove it read *frame 1* needs the others to
 * carry a different, equally real block.
 */
async function renderFixtureFrame(frameIndex: number): Promise<Buffer> {
  const base = BASE_COLOURS[(frameIndex - 1) % BASE_COLOURS.length] ?? '#000000';

  return sharp({
    create: {
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      channels: 3,
      background: base,
    },
  })
    .composite([
      {
        input: {
          create: {
            width: MARKER_WIDTH,
            height: MARKER_HEIGHT,
            channels: 3,
            background: '#ffffff',
          },
        },
        left: markerLeft(frameIndex),
        top: MARKER_TOP,
      },
    ])
    .withExif({
      IFD0: {
        Make: 'KINO',
        Model: 'KINO D4',
        Software: `kino-test-fixtures cam-${String(frameIndex).padStart(2, '0')}`,
      },
    })
    .jpeg({ quality: 90, mozjpeg: false })
    .toBuffer();
}

async function main(): Promise<void> {
  const dir = fileURLToPath(new URL('../media/', import.meta.url));
  await mkdir(dir, { recursive: true });

  for (let frameIndex = 1; frameIndex <= FIXTURE_FRAME_COUNT; frameIndex += 1) {
    const bytes = await renderFixtureFrame(frameIndex);
    const name = fixtureFrameName(frameIndex);
    await writeFile(new URL(name, new URL('../media/', import.meta.url)), bytes);
    console.log(`${name}  ${FIXTURE_WIDTH}×${FIXTURE_HEIGHT}  ${bytes.length} B`);
  }
}

await main();
