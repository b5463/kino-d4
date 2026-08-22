// Whole-capture exports: animated GIF, MP4, ZIP package and contact sheet.
// Everything here works on the four frames the inspector already holds, so
// the same functions serve a capture read off the camera and one imported
// from a folder on this computer.

import type { CaptureInfo } from '@kino/kdp';
import { buildZip } from '../../utils/zip';
import { encodeGif } from '../../utils/gif';
import type { GifFrame } from '../../utils/gif';
import { encodeWiggleMp4 } from '../../utils/mp4';
import { buildAlignedFrames } from '../../utils/wiggleRender';
import type { CamOffset } from '../../utils/wiggleRender';
import type { CaptureFrame } from './useCaptureFrames';

/** Viewpoint order for wiggle playback and every animated export. */
export const SEQ_BOUNCE = [0, 1, 2, 3, 2, 1];

export type FrameSource = HTMLImageElement | HTMLCanvasElement;

export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function loadFrameImages(frames: CaptureFrame[]): Promise<HTMLImageElement[]> {
  return Promise.all(
    frames.map(
      (f) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('decode failed'));
          img.src = f.url;
        }),
    ),
  );
}

/** `offsets` null means export the full frame — no alignment, no crop. */
export async function alignedSources(
  frames: CaptureFrame[],
  offsets: CamOffset[] | null,
): Promise<FrameSource[]> {
  const imgs = await loadFrameImages(frames);
  if (offsets === null) return imgs;
  return buildAlignedFrames(imgs, offsets) ?? imgs;
}

export function buildGifBytes(sources: FrameSource[], fps: number): Uint8Array {
  const first = sources[0];
  const srcW = first instanceof HTMLImageElement ? first.naturalWidth : first.width;
  const srcH = first instanceof HTMLImageElement ? first.naturalHeight : first.height;
  const w = Math.min(srcW, 640);
  const h = Math.round((srcH / srcW) * w);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const delayMs = 1000 / fps;
  const gifFrames: GifFrame[] = SEQ_BOUNCE.map((idx) => {
    ctx.drawImage(sources[idx], 0, 0, w, h);
    return { rgba: ctx.getImageData(0, 0, w, h).data, delayMs };
  });
  return encodeGif(w, h, gifFrames);
}

export function buildMp4Bytes(sources: FrameSource[], fps: number): Promise<Uint8Array> {
  return encodeWiggleMp4(sources, fps);
}

export function buildZipBytes(frames: CaptureFrame[], info: CaptureInfo): Uint8Array {
  const entries = frames.map((f, i) => ({ name: `C${i + 1}_RAW.JPG`, data: f.data }));
  entries.push({ name: 'metadata.json', data: new TextEncoder().encode(JSON.stringify(info, null, 2)) });
  return buildZip(entries);
}

/** 2×2 sheet, CAM label burned into each tile, `caption` along the foot. */
export async function buildContactSheet(frames: CaptureFrame[], caption: string): Promise<Blob | null> {
  const imgs = await loadFrameImages(frames);
  const fw = imgs[0].naturalWidth;
  const fh = imgs[0].naturalHeight;
  const pad = 12;
  const canvas = document.createElement('canvas');
  canvas.width = fw * 2 + pad * 3;
  canvas.height = fh * 2 + pad * 3 + 26;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f2f4f7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  imgs.forEach((img, i) => {
    const x = pad + (i % 2) * (fw + pad);
    const y = pad + Math.floor(i / 2) * (fh + pad);
    ctx.drawImage(img, x, y);
    ctx.fillStyle = 'rgba(20,32,48,0.8)';
    ctx.fillRect(x + 6, y + fh - 24, 52, 18);
    ctx.fillStyle = '#fff';
    ctx.font = '700 12px Consolas, monospace';
    ctx.fillText(`CAM ${i + 1}`, x + 11, y + fh - 11);
  });
  ctx.fillStyle = '#536273';
  ctx.font = '700 13px Consolas, monospace';
  ctx.fillText(caption, pad, canvas.height - 10);
  return new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
}
