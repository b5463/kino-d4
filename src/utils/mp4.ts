// Wigglegram MP4 export: WebCodecs H.264 + mp4-muxer. Chromium-only; the
// caller checks mp4Supported() and disables the button with a reason when
// the encoder is unavailable.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const CODEC = 'avc1.42001f'; // H.264 baseline, level 3.1 — fine for 800×600

export async function mp4Supported(width: number, height: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: CODEC,
      width: width & ~1,
      height: height & ~1,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * Encode a bounce-sequence MP4 from four frames. Repeats the 1-2-3-4-3-2
 * cycle for ~durationS seconds at the given fps.
 */
type FrameSource = HTMLImageElement | HTMLCanvasElement;

function sourceSize(el: FrameSource): { w: number; h: number } {
  return el instanceof HTMLImageElement
    ? { w: el.naturalWidth, h: el.naturalHeight }
    : { w: el.width, h: el.height };
}

export async function encodeWiggleMp4(
  images: FrameSource[],
  fps: number,
  durationS = 4,
): Promise<Uint8Array> {
  const src = sourceSize(images[0]);
  const width = Math.min(src.w, 1280) & ~1;
  const height = Math.round((src.h / src.w) * width) & ~1;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure({
    codec: CODEC,
    width,
    height,
    bitrate: 6_000_000,
    framerate: fps,
  });

  const bounce = [0, 1, 2, 3, 2, 1];
  const totalFrames = Math.max(bounce.length, Math.round(durationS * fps));
  const frameUs = Math.round(1_000_000 / fps);

  for (let i = 0; i < totalFrames; i++) {
    if (encodeError) throw encodeError;
    const img = images[bounce[i % bounce.length]];
    ctx.drawImage(img, 0, 0, width, height);
    const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
    encoder.encode(frame, { keyFrame: i % 30 === 0 });
    frame.close();
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
