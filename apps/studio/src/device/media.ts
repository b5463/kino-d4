// Media transfer manager: chunked reads through the P4 with progress,
// cancellation and SHA-256 verification. A download whose checksum does not
// match what the camera reported is an error, not a file. A download the
// camera gave no checksum for is handed over as **unverified** and says so:
// shipped firmware omits CaptureFile.sha256 (contract D20), and treating an
// absent digest as a match would turn every real transfer into a claim of
// integrity nothing checked.

import type { KinoDevice } from './KinoDevice';
import type { CaptureFile, CaptureInfo } from '@kino/kdp';
import { KinoCommandError } from '@kino/kdp';
import { useDeviceStore } from '../state/deviceStore';
import { sha256Hex } from '../firmware/hashing';

const CHUNK = 8192;

/**
 * A finished transfer, and whether its bytes were checked.
 *
 * `verified` is part of the result rather than an assumption because the
 * digest is optional on the wire: a caller that writes these bytes somewhere
 * a person will trust has to state which of the two it got.
 */
export interface TransferredFile {
  name: string;
  data: Uint8Array;
  /** True only when a 64-hex digest arrived and the received bytes matched it. */
  verified: boolean;
}

/** A digest the camera actually sent, or null. Anything malformed is null. */
export function declaredDigest(file: CaptureFile): string | null {
  return typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(file.sha256)
    ? file.sha256.toLowerCase()
    : null;
}

export interface TransferProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  bytesDone: number;
  bytesTotal: number;
}

export class TransferCancelled extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

export class TransferHandle {
  private cancelled = false;
  cancel() {
    this.cancelled = true;
  }
  get isCancelled() {
    return this.cancelled;
  }
  throwIfCancelled() {
    if (this.cancelled) throw new TransferCancelled();
  }
}

/**
 * Download one file of a capture, verifying its length always and its
 * checksum whenever the camera declared one.
 */
export async function downloadCaptureFile(
  dev: KinoDevice,
  info: CaptureInfo,
  fileName: string,
  handle: TransferHandle,
  onProgress?: (done: number, total: number) => void,
): Promise<TransferredFile> {
  const file = info.files.find((f) => f.name === fileName);
  if (!file) throw new Error(`Capture ${info.id} has no file ${fileName}`);
  const out = new Uint8Array(file.sizeBytes);
  let offset = 0;
  while (offset < file.sizeBytes) {
    handle.throwIfCancelled();
    const chunk = await dev.mediaRead(info.id, fileName, offset, Math.min(CHUNK, file.sizeBytes - offset));
    if (chunk.length === 0) throw new Error(`Camera returned no data at offset ${offset} of ${fileName}`);
    out.set(chunk, offset);
    offset += chunk.length;
    onProgress?.(offset, file.sizeBytes);
  }
  const declared = declaredDigest(file);
  if (declared === null) {
    // Nothing to compare against. The bytes are returned — refusing a
    // download because shipped firmware sends no digest would make the
    // gallery unusable on real hardware — but not as verified bytes.
    return { name: fileName, data: out, verified: false };
  }
  if ((await sha256Hex(out)) !== declared) {
    throw new Error(`${fileName} failed checksum verification after transfer — try again`);
  }
  return { name: fileName, data: out, verified: true };
}

/** Download all four originals of a capture. */
export async function downloadCaptureSet(
  dev: KinoDevice,
  info: CaptureInfo,
  handle: TransferHandle,
  onProgress?: (p: TransferProgress) => void,
): Promise<TransferredFile[]> {
  const results: TransferredFile[] = [];
  for (let i = 0; i < info.files.length; i++) {
    const f = info.files[i];
    results.push(
      await downloadCaptureFile(dev, info, f.name, handle, (done, total) =>
        onProgress?.({ file: f.name, fileIndex: i, fileCount: info.files.length, bytesDone: done, bytesTotal: total }),
      ),
    );
  }
  return results;
}

/**
 * Object URLs for capture thumbnails, keyed by **camera serial and capture
 * id**.
 *
 * The id alone is not unique across cameras: capture ids are per-card
 * sequences, so swapping the cable from one body to another served camera A's
 * thumbnails on camera B's grid. The key carries the unit the bytes came from.
 */
const thumbCache = new Map<string, string>();

function thumbKey(id: string): string {
  return `${useDeviceStore.getState().info?.serial ?? 'unknown'}/${id}`;
}

/** A thumbnail page. Both firmware and the reference device cap a reply here. */
const THUMB_PAGE = 8192;
/** A JPEG thumbnail past this is not a thumbnail; stop rather than stream. */
const THUMB_MAX = 256 * 1024;
/**
 * Budget for the fallback below. A tile is 190 px wide — pulling a
 * multi-megabyte original over a 921600 baud link to fill one is not a
 * fallback, it is a stall, so an oversized original is reported instead.
 */
const THUMB_FALLBACK_MAX = 512 * 1024;

function isNotFound(err: unknown): boolean {
  return err instanceof KinoCommandError && err.code === 'NOT_FOUND';
}

/**
 * Read one paged byte stream to its end.
 *
 * A reply shorter than a full page is the last page — that is the only
 * end-of-stream marker the read commands have. A zero-length reply ends it
 * too, so a device that pages exactly to the boundary terminates as well.
 */
async function readPaged(
  read: (offset: number) => Promise<Uint8Array>,
  max: number,
  what: string,
): Promise<Uint8Array> {
  const pages: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const page = await read(total);
    if (page.length === 0) break;
    pages.push(page);
    total += page.length;
    if (page.length < THUMB_PAGE) break;
    if (total >= max) throw new Error(`${what} is larger than ${Math.round(max / 1024)} KB — not read`);
  }
  if (pages.length === 1) return pages[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const page of pages) {
    out.set(page, at);
    at += page.length;
  }
  return out;
}

/**
 * Object URL for a capture thumbnail, cached for the session.
 *
 * MEDIA_THUMB is paged like MEDIA_READ: the first reply is capped at 8192
 * bytes, and a single unpaged request returned a truncated JPEG for any
 * thumbnail larger than that. Captures written before the card carried
 * thumbnails have none at all, and those fall back to the first original.
 */
export async function getThumbUrl(dev: KinoDevice, id: string): Promise<string> {
  const key = thumbKey(id);
  const cached = thumbCache.get(key);
  if (cached) return cached;
  let bytes: Uint8Array;
  try {
    bytes = await readPaged((offset) => dev.mediaThumb(id, offset, THUMB_PAGE), THUMB_MAX, `Thumbnail for ${id}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // No thumbnail stored for this capture. The first frame is the same
    // picture at full size, which is worse but is not nothing.
    bytes = await readPaged(
      (offset) => dev.mediaRead(id, 'C1.JPG', offset, THUMB_PAGE),
      THUMB_FALLBACK_MAX,
      `No thumbnail for ${id}; C1.JPG`,
    );
  }
  if (bytes.length === 0) throw new Error(`Camera returned no thumbnail bytes for ${id}`);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  thumbCache.set(key, url);
  return url;
}

export function dropThumb(id: string) {
  const key = thumbKey(id);
  const url = thumbCache.get(key);
  if (url) URL.revokeObjectURL(url);
  thumbCache.delete(key);
}

export function clearThumbCache() {
  for (const url of thumbCache.values()) URL.revokeObjectURL(url);
  thumbCache.clear();
}
