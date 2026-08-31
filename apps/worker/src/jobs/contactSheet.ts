import sharp, { type OverlayOptions } from 'sharp';
import {
  CONTACT_SHEET_BACKGROUND,
  CONTACT_SHEET_CELL_WIDTH,
  CONTACT_SHEET_GUTTER,
  CONTACT_SHEET_QUALITY,
} from '../images/sizes';
import { SHARP_INPUT } from '../images/decode';
import { labelHeight, renderLabel } from '../images/labels';
import { loadAssets, loadCapture, originalFrames, readObject, requireCaptureId } from './capture';
import { publishDerived } from './derive';
import type { JobCtx, JobPayload } from './types';

export { CONTACT_SHEET_CELL_WIDTH, CONTACT_SHEET_GUTTER } from '../images/sizes';

/**
 * How wide a sheet of `frames` cells is: the cells plus the gutters between them,
 * and no outer border.
 *
 * No border because the sheet is a strip of what the rig saw, not a print — a
 * frame around it would be the only pixels in the file that were not photographs.
 */
export function contactSheetWidth(frames: number): number {
  if (frames < 1) throw new Error(`a contact sheet needs at least one frame, got ${frames}`);
  return frames * CONTACT_SHEET_CELL_WIDTH + (frames - 1) * CONTACT_SHEET_GUTTER;
}

/** Glyph scale for the `CAM<n>` labels: 5×7 at ×3 is legible in a 320 px cell. */
const LABEL_SCALE = 3;

/** Inset of the label from the cell's bottom-left corner. */
const LABEL_MARGIN = 6;

/**
 * `render-contact-sheet` — every camera of one capture, side by side.
 *
 * One row, `n` across. Not a grid: the D4's cameras *are* a row (01 §2), and
 * laying four of them out 2×2 would invent a spatial relationship the rig does
 * not have. The order is camera order, left to right, because that is the order
 * the parallax runs in and a shuffled sheet would read as a different scene.
 *
 * The sheet is what a host downloads and forwards, which is why it is JPEG (see
 * `images/sizes.ts`) and why every cell is labelled: away from the app, the
 * filename is the only other thing that says what this is, and it does not say
 * which cell is which camera.
 *
 * ## Failure is contained by construction (07 §26)
 *
 * A frame that cannot be read throws before anything is written: the sheet is
 * composed in memory and stored in one `putDerived`, so there is no half-sheet
 * to clean up and no asset row claiming one. The thumbnail, the still and every
 * original are untouched — this handler reads them and writes one file of its
 * own.
 */
export async function renderContactSheet(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const frames = originalFrames(await loadAssets(ctx.db, captureId));

  if (frames.length === 0) {
    throw new Error(`capture ${captureId} has no stored original frame to lay out`);
  }

  // Every frame is read before anything is composed. A sheet with a hole in it
  // is not a cheaper answer than a retry.
  const sources: Buffer[] = [];
  for (const frame of frames) sources.push(await readObject(ctx, frame.objectKey));

  const cellHeight = await cellHeightOf(sources[0]);
  const width = contactSheetWidth(frames.length);

  const overlays: OverlayOptions[] = [];
  for (const [position, source] of sources.entries()) {
    const left = position * (CONTACT_SHEET_CELL_WIDTH + CONTACT_SHEET_GUTTER);

    overlays.push({
      input: await sharp(source, SHARP_INPUT)
        .rotate()
        // `cover` rather than `contain`: cells must be exactly the same size for
        // the geometry above to be the truth, and a frame that is not 4:3 is
        // better cropped than letterboxed into a cell of dead pixels.
        .resize({ width: CONTACT_SHEET_CELL_WIDTH, height: cellHeight, fit: 'cover' })
        .png()
        .toBuffer(),
      left,
      top: 0,
    });

    // `CAM1..CAMn` follows the *frame index*, not the position in the sheet: a
    // capture that lost frame 2 must not relabel frame 3 as CAM2.
    const label = renderLabel(`CAM${String(frames[position]?.frameIndex ?? position + 1)}`, LABEL_SCALE);
    overlays.push({
      input: label.data,
      raw: { width: label.width, height: label.height, channels: label.channels },
      left: left + LABEL_MARGIN,
      top: cellHeight - labelHeight(LABEL_SCALE) - LABEL_MARGIN,
    });
  }

  const { data, info } = await sharp({
    ...SHARP_INPUT,
    create: {
      width,
      height: cellHeight,
      channels: 3,
      background: CONTACT_SHEET_BACKGROUND,
    },
  })
    .composite(overlays)
    .jpeg({ quality: CONTACT_SHEET_QUALITY })
    .toBuffer({ resolveWithObject: true });

  await publishDerived(ctx, capture, {
    name: 'contact-sheet.jpg',
    role: 'contact-sheet',
    mime: 'image/jpeg',
    body: data,
    width: info.width,
    height: info.height,
    // `look` is identity only — the P4 baked it into the source JPEGs.
    producer: { job: 'contact-sheet', encoder: 'sharp/jpeg', cellWidth: CONTACT_SHEET_CELL_WIDTH, quality: CONTACT_SHEET_QUALITY, look: capture.look },
  });
}

/**
 * The cell height, from the first frame's own pixels.
 *
 * Read from the image rather than from `captures.resolution`: the row is what the
 * device *declared* and the sheet has to match what it *uploaded*. A cell height
 * computed from a stale or wrong resolution string would crop every frame on the
 * sheet by a few pixels and nothing would say why.
 */
async function cellHeightOf(source: Buffer | undefined): Promise<number> {
  if (source === undefined) throw new Error('contact sheet has no first frame');

  const { width, height, orientation } = await sharp(source, SHARP_INPUT).metadata();
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw new Error('contact sheet frame has no readable dimensions');
  }

  // `metadata()` reports the stored dimensions; EXIF orientations 5–8 mean the
  // image is displayed rotated a quarter turn, which is what `.rotate()` will do
  // to it below. Reading the pair the wrong way round would size every cell to
  // the portrait aspect of a landscape frame.
  const turned = orientation !== undefined && orientation >= 5;
  const shownWidth = turned ? height : width;
  const shownHeight = turned ? width : height;

  return Math.max(1, Math.round((CONTACT_SHEET_CELL_WIDTH * shownHeight) / shownWidth));
}
