import exifr from 'exifr';
import { loadAssets, loadCapture, originalFrames, readObject, requireCaptureId } from './capture';
import { publishDerived } from './derive';
import type { JobCtx, JobPayload } from './types';

/**
 * `extract-metadata` — what the platform knows about a capture, as one file.
 *
 * Two sources, and they are kept separate in the output rather than merged: the
 * **capture row**, which is what the device declared over KDP, and the **EXIF of
 * the first frame**, which is what the camera wrote into the file. They disagree
 * often enough — a clock that was never set, a resolution the firmware rounds —
 * that flattening them into one object would destroy the only evidence of which
 * one to believe.
 *
 * ## Deterministic output
 *
 * Nothing here is a timestamp of *now*. A rerun of this job on unchanged inputs
 * produces byte-identical JSON, so its sha256 does not move and the upsert is a
 * genuine no-op. An `extractedAt` field would have made every retry look like a
 * change to every reader that diffs digests, for no information anyone wants —
 * `processing_events` already records when the job ran.
 *
 * ## Why frame 1 and not the middle frame
 *
 * The stills use the middle frame because it is the best *picture*. EXIF is not a
 * picture: what it carries is the rig's settings, which are the same across the
 * four cameras, and CAM1 is the one that exists in every capture mode including
 * `single`. Which frame was actually read is recorded in `exifSourceFrame` so
 * nothing has to assume.
 */
export async function extractMetadata(payload: JobPayload, ctx: JobCtx): Promise<void> {
  const captureId = requireCaptureId(payload);
  const capture = await loadCapture(ctx.db, captureId);
  const assetRows = await loadAssets(ctx.db, captureId);
  const frames = originalFrames(assetRows);

  const first = frames[0] ?? null;
  const exif = first === null ? null : await readExif(await readObject(ctx, first.objectKey));

  const document = {
    captureId: capture.id,
    captureUuid: capture.captureUuid,
    rollId: capture.rollId,
    deviceId: capture.deviceId,
    mode: capture.mode,
    look: capture.look,
    capturedAt: capture.capturedAt.toISOString(),
    frameCount: capture.frameCount,
    resolution: capture.resolution,
    // Verbatim from the row. The three skews are distinct measurements and are
    // never conflated or defaulted (04 §14): an absent timing block stays null.
    timing: capture.timing ?? null,
    frames: frames.map((frame) => ({
      frameIndex: frame.frameIndex,
      mime: frame.mime,
      width: frame.width,
      height: frame.height,
      objectKey: frame.objectKey,
    })),
    /** Which frame the EXIF below came from, or null when none was readable. */
    exifSourceFrame: exif === null ? null : first?.frameIndex ?? null,
    exif,
  };

  await publishDerived(ctx, capture, {
    name: 'metadata.json',
    role: 'metadata',
    mime: 'application/json',
    // Two-space JSON: this file is read by people as often as by code, and it is
    // a few hundred bytes either way.
    body: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'),
    // A JSON document has no pixels. Recording a width here would be a claim the
    // gallery would try to lay out.
    width: null,
    height: null,
  });
}

/**
 * The EXIF blocks worth keeping, or null when the frame carries none.
 *
 * An explicit block list rather than exifr's defaults: the interesting tags are
 * in IFD0 — which exifr always parses and cannot be asked not to — plus the EXIF
 * sub-IFD and GPS. Everything switched off below is bytes nobody reading this
 * file wants: `ifd1` is the embedded thumbnail's own directory, and the maker
 * note and user comment are vendor blobs that would end up as pages of escaped
 * binary in a document meant to be read.
 *
 * A frame with no EXIF at all — anything a phone or a script re-encoded — yields
 * `null`, never an empty object: an absent field reads as "this build has no such
 * concept", and null reads as "looked, nothing there".
 */
async function readExif(body: Buffer): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await exifr.parse(body, {
    exif: true,
    gps: true,
    ifd1: false,
    interop: false,
    makerNote: false,
    userComment: false,
    mergeOutput: true,
  });

  if (typeof parsed !== 'object' || parsed === null) return null;
  const tags = parsed as Record<string, unknown>;
  return Object.keys(tags).length === 0 ? null : tags;
}
