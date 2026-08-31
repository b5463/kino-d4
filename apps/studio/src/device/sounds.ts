// Sound transfer manager: chunked upload and read of custom clips, mirroring
// the firmware/media transfer patterns, plus a session cache so replaying a
// clip does not re-pull it over UART.

import type { KinoDevice } from './KinoDevice';
import type { SoundBeginRequest, SoundInfo } from '@kino/kdp';

const CHUNK = 8192;

export class SoundUploadCancelled extends Error {
  constructor() {
    super('Sound upload cancelled');
    this.name = 'SoundUploadCancelled';
  }
}

/** Cancel token for an upload in progress. */
export class SoundUploadHandle {
  private cancelled = false;
  cancel() {
    this.cancelled = true;
  }
  get isCancelled() {
    return this.cancelled;
  }
}

/**
 * Make the device drop a half-sent upload.
 *
 * A device holds one sound session at a time and answers every later
 * SOUND_BEGIN with BUSY while it is open, so an upload abandoned mid-chunk
 * used to lock out custom sounds until the camera rebooted. There is no
 * SOUND_ABORT in KDP; a chunk past the announced size is the one thing the
 * contract specifies as discarding the session, so that is what this sends.
 * Best effort by definition: the reply is the refusal it asked for.
 */
async function abortSoundSession(dev: KinoDevice, sessionId: number, sizeBytes: number): Promise<void> {
  try {
    await dev.soundChunk(sessionId, sizeBytes, new Uint8Array(1));
  } catch {
    // Expected — the point was the side effect on the device.
  }
}

/** Upload a device-format WAV. Returns the stored SoundInfo. */
export async function uploadSound(
  dev: KinoDevice,
  meta: SoundBeginRequest,
  wav: Uint8Array,
  onProgress?: (done: number, total: number) => void,
  handle?: SoundUploadHandle,
): Promise<SoundInfo> {
  const begin = await dev.soundBegin(meta);
  const chunkSize = Math.min(begin.chunkSize || CHUNK, CHUNK);
  try {
    for (let offset = 0; offset < wav.length; offset += chunkSize) {
      if (handle?.isCancelled) throw new SoundUploadCancelled();
      const end = Math.min(offset + chunkSize, wav.length);
      await dev.soundChunk(begin.sessionId, offset, wav.subarray(offset, end));
      onProgress?.(end, wav.length);
    }
    if (handle?.isCancelled) throw new SoundUploadCancelled();
    // SOUND_END is in here too: a refused commit (a short upload) leaves the
    // session open exactly like a failed chunk does.
    const result = await dev.soundEnd();
    soundCache.set(meta.id, wav);
    return result.sound;
  } catch (err) {
    await abortSoundSession(dev, begin.sessionId, meta.sizeBytes);
    throw err;
  }
}

const soundCache = new Map<string, Uint8Array>();

/** Bytes of a stored clip, from cache or chunked reads. */
export async function readSound(dev: KinoDevice, info: SoundInfo): Promise<Uint8Array> {
  const hit = soundCache.get(info.id);
  if (hit && hit.length === info.sizeBytes) return hit;
  const out = new Uint8Array(info.sizeBytes);
  let offset = 0;
  while (offset < info.sizeBytes) {
    const chunk = await dev.soundRead(info.id, offset, Math.min(CHUNK, info.sizeBytes - offset));
    if (chunk.length === 0) throw new Error(`Device returned no data at offset ${offset} of ${info.name}`);
    out.set(chunk, offset);
    offset += chunk.length;
  }
  soundCache.set(info.id, out);
  return out;
}

export function dropSound(id: string) {
  soundCache.delete(id);
}

export function clearSoundCache() {
  soundCache.clear();
}
