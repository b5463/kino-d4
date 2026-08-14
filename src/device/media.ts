// Media transfer manager: chunked reads through the P4 with progress,
// cancellation and SHA-256 verification. Nothing is presented as a finished
// download until its checksum matches what the camera reported.

import type { KinoDevice } from './KinoDevice';
import type { CaptureInfo } from '../protocol/types';
import { sha256Hex } from '../firmware/hashing';

const CHUNK = 8192;

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

/** Download one file of a capture, verifying length and checksum. */
export async function downloadCaptureFile(
  dev: KinoDevice,
  info: CaptureInfo,
  fileName: string,
  handle: TransferHandle,
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
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
  const digest = await sha256Hex(out);
  if (digest !== file.sha256.toLowerCase()) {
    throw new Error(`${fileName} failed checksum verification after transfer — try again`);
  }
  return out;
}

/** Download all four originals of a capture. */
export async function downloadCaptureSet(
  dev: KinoDevice,
  info: CaptureInfo,
  handle: TransferHandle,
  onProgress?: (p: TransferProgress) => void,
): Promise<{ name: string; data: Uint8Array }[]> {
  const results: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < info.files.length; i++) {
    const f = info.files[i];
    const data = await downloadCaptureFile(dev, info, f.name, handle, (done, total) =>
      onProgress?.({ file: f.name, fileIndex: i, fileCount: info.files.length, bytesDone: done, bytesTotal: total }),
    );
    results.push({ name: f.name, data });
  }
  return results;
}

const thumbCache = new Map<string, string>();

/** Object URL for a capture thumbnail, cached for the session. */
export async function getThumbUrl(dev: KinoDevice, id: string): Promise<string> {
  const cached = thumbCache.get(id);
  if (cached) return cached;
  const bytes = await dev.mediaThumb(id);
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
  thumbCache.set(id, url);
  return url;
}

export function dropThumb(id: string) {
  const url = thumbCache.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbCache.delete(id);
}

export function clearThumbCache() {
  for (const url of thumbCache.values()) URL.revokeObjectURL(url);
  thumbCache.clear();
}
