// Sound transfer manager: chunked upload and read of custom clips, mirroring
// the firmware/media transfer patterns, plus a session cache so replaying a
// clip does not re-pull it over UART.

import type { KinoDevice } from './KinoDevice';
import type { SoundBeginRequest, SoundInfo } from '../protocol/types';

const CHUNK = 8192;

/** Upload a device-format WAV. Returns the stored SoundInfo. */
export async function uploadSound(
  dev: KinoDevice,
  meta: SoundBeginRequest,
  wav: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<SoundInfo> {
  const begin = await dev.soundBegin(meta);
  const chunkSize = Math.min(begin.chunkSize || CHUNK, CHUNK);
  for (let offset = 0; offset < wav.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, wav.length);
    await dev.soundChunk(begin.sessionId, offset, wav.subarray(offset, end));
    onProgress?.(end, wav.length);
  }
  const result = await dev.soundEnd();
  soundCache.set(meta.id, wav);
  return result.sound;
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
