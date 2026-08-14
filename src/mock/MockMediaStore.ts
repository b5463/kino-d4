// Demo SD card. Captures are synthesized party scenes drawn on canvas with
// real per-camera parallax (near layers shift more between CAM1..CAM4), so
// wiggle playback in the gallery is a genuine four-viewpoint animation.
// In Node (unit tests) canvas is unavailable — deterministic pseudo-JPEG
// bytes keep the transfer protocol fully testable.

import type { CamId, CaptureInfo, CaptureSummary, CaptureFile } from '../protocol/types';
import { CAM_IDS } from '../protocol/types';
import { sha256Hex } from '../firmware/hashing';

const W = 800;
const H = 600;
const PARALLAX = 16; // px shift of the nearest layer between adjacent cams

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const BG_PAIRS: [string, string][] = [
  ['#31174d', '#8a2c5c'],
  ['#101d3c', '#274b83'],
  ['#3c1020', '#a03e28'],
  ['#0e2e2a', '#1e6e5a'],
  ['#241038', '#5b2a86'],
  ['#301b0c', '#8a5a1e'],
];

const LIGHT_COLORS = ['#ff5f8a', '#4fc3f7', '#ffd54f', '#9575ff', '#4dd0a1', '#ff8a4f'];

interface StoredCapture {
  summary: CaptureSummary;
  flash: boolean;
  triggerSkewUs: number;
}

export class MockMediaStore {
  private captures: StoredCapture[] | null = null;
  private fileCache = new Map<string, Uint8Array>();
  private thumbCache = new Map<string, Uint8Array>();

  private ensure(): StoredCapture[] {
    if (this.captures) return this.captures;
    const rnd = mulberry32(0xd4c4);
    const list: StoredCapture[] = [];
    const wiggleRecipes = ['party-neg', 'party-neg', 'superia', 'vivid', 'mono', 'warm-2007', 'disposable', 'chrome'];
    let ts = Date.now() - 1000 * 60 * 60 * 38; // a party two nights ago
    for (let i = 0; i < 22; i++) {
      const isQuad = rnd() < 0.3;
      // /DCIM folder naming: WG000041, QD000041
      const n = String(40 + i).padStart(6, '0');
      const id = isQuad ? `QD${n}` : `WG${n}`;
      ts += Math.floor(rnd() * 14 + 2) * 60 * 1000;
      list.push({
        summary: {
          id,
          kind: isQuad ? 'quad' : 'wiggle',
          ts,
          recipeIds: isQuad
            ? ['party-neg', 'motion', 'raw-digi', 'mono']
            : [wiggleRecipes[Math.floor(rnd() * wiggleRecipes.length)]],
          favorite: rnd() < 0.18,
          resolution: '1600x1200',
          totalKB: 0, // filled lazily after first encode
        },
        flash: rnd() < 0.8,
        triggerSkewUs: Math.floor(rnd() * 380 + 60),
      });
    }
    this.captures = list;
    return list;
  }

  /** Register a capture taken while connected (ambient party shooting). */
  addLiveCapture(number: number, kind: 'wiggle' | 'quad', recipeIds: string[], flash: boolean): string {
    const list = this.ensure();
    const id = `${kind === 'wiggle' ? 'WG' : 'QD'}${String(number).padStart(6, '0')}`;
    list.push({
      summary: {
        id,
        kind,
        ts: Date.now(),
        recipeIds,
        favorite: false,
        resolution: '1600x1200',
        totalKB: 0,
      },
      flash,
      triggerSkewUs: Math.floor(Math.random() * 380 + 60),
    });
    return id;
  }

  list(): CaptureSummary[] {
    return this.ensure()
      .map((c) => c.summary)
      .slice()
      .sort((a, b) => b.ts - a.ts);
  }

  countSummary() {
    const all = this.ensure();
    return {
      wiggles: all.filter((c) => c.summary.kind === 'wiggle').length,
      quads: all.filter((c) => c.summary.kind === 'quad').length,
    };
  }

  setFavorite(id: string, favorite: boolean): boolean {
    const c = this.ensure().find((x) => x.summary.id === id);
    if (!c) return false;
    c.summary.favorite = favorite;
    return true;
  }

  delete(id: string): boolean {
    const all = this.ensure();
    const idx = all.findIndex((x) => x.summary.id === id);
    if (idx === -1) return false;
    all.splice(idx, 1);
    for (const cam of [0, 1, 2, 3]) this.fileCache.delete(`${id}/${cam}`);
    this.thumbCache.delete(id);
    return true;
  }

  async info(id: string): Promise<CaptureInfo | null> {
    const c = this.ensure().find((x) => x.summary.id === id);
    if (!c) return null;
    const files: CaptureFile[] = [];
    for (let cam = 0; cam < 4; cam++) {
      const bytes = await this.fileBytesByIndex(id, cam);
      if (!bytes) return null;
      files.push({ name: `C${cam + 1}_RAW.JPG`, sizeBytes: bytes.length, sha256: await sha256Hex(bytes) });
    }
    c.summary.totalKB = Math.round(files.reduce((a, f) => a + f.sizeBytes, 0) / 1024);
    const rnd = mulberry32(hashId(id) ^ 7);
    return {
      ...c.summary,
      files,
      meta: {
        flash: c.flash,
        batteryV: Math.round((3.55 + rnd() * 0.5) * 100) / 100,
        p4Firmware: '0.1.0',
        cameraFirmware: ['0.1.0', '0.1.0', '0.1.0', '0.1.0'],
        triggerSkewUs: c.triggerSkewUs,
        exposure: CAM_IDS.map((cam: CamId) => ({
          cam,
          shutter: c.flash ? '1/60' : '1/30',
          gain: Math.floor(rnd() * 12 + 4),
        })),
      },
    };
  }

  async fileBytes(id: string, name: string): Promise<Uint8Array | null> {
    const m = /^C([1-4])(?:_RAW)?\.JPG$/i.exec(name);
    if (!m) return null;
    return this.fileBytesByIndex(id, Number(m[1]) - 1);
  }

  async fileBytesByIndex(id: string, camIdx: number): Promise<Uint8Array | null> {
    const key = `${id}/${camIdx}`;
    const cached = this.fileCache.get(key);
    if (cached) return cached;
    const c = this.ensure().find((x) => x.summary.id === id);
    if (!c) return null;
    const bytes = await synthesizeFrame(c, camIdx);
    this.fileCache.set(key, bytes);
    return bytes;
  }

  async thumb(id: string): Promise<Uint8Array | null> {
    const cached = this.thumbCache.get(id);
    if (cached) return cached;
    const c = this.ensure().find((x) => x.summary.id === id);
    if (!c) return null;
    const bytes = await synthesizeFrame(c, 1, 200, 150);
    this.thumbCache.set(id, bytes);
    return bytes;
  }
}

// ---- scene synthesis ----

async function synthesizeFrame(c: StoredCapture, camIdx: number, w = W, h = H): Promise<Uint8Array> {
  if (typeof document === 'undefined') {
    // Small frames (thumbs) must fit a single protocol frame; full frames
    // travel through chunked MEDIA_READ and can be large.
    return w <= 400
      ? fakeJpegBytes(`${c.summary.id}/${camIdx}/${w}`, 4000, 6000)
      : fakeJpegBytes(`${c.summary.id}/${camIdx}/${w}`, 24000, 40000);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rnd = mulberry32(hashId(c.summary.id));
  const scale = w / W;
  // Parallax: how far this viewpoint sits from the rig center (CAM1..CAM4).
  const eye = (camIdx - 1.5) * PARALLAX * scale;

  const [bgTop, bgBot] = BG_PAIRS[Math.floor(rnd() * BG_PAIRS.length)];
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, bgTop);
  grad.addColorStop(1, bgBot);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Far layer: hanging party lights (depth ~0.15).
  for (let i = 0; i < 9; i++) {
    const x = rnd() * w + eye * 0.15;
    const y = rnd() * h * 0.35;
    const color = LIGHT_COLORS[Math.floor(rnd() * LIGHT_COLORS.length)];
    const r = (6 + rnd() * 14) * scale;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'transparent');
    ctx.fillStyle = glow;
    ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
  }

  // Mid layer: light streaks (depth ~0.4).
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 4; i++) {
    const x0 = rnd() * w + eye * 0.4;
    const y0 = rnd() * h * 0.6;
    ctx.strokeStyle = LIGHT_COLORS[Math.floor(rnd() * LIGHT_COLORS.length)];
    ctx.lineWidth = (2 + rnd() * 4) * scale;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x0 + 120 * scale, y0 + (rnd() - 0.5) * 160 * scale, x0 + 260 * scale, y0 + (rnd() - 0.5) * 80 * scale);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Floor.
  ctx.fillStyle = 'rgba(8, 10, 16, 0.55)';
  ctx.fillRect(0, h * 0.74, w, h * 0.26);

  // People silhouettes: nearest shift the most between cameras.
  const people = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < people; i++) {
    const depth = 0.55 + rnd() * 0.45; // 0.55 far .. 1 near
    const px = rnd() * (w * 0.8) + w * 0.1 + eye * depth;
    const ph = (h * 0.28 + rnd() * h * 0.3) * depth;
    const pw = ph * (0.32 + rnd() * 0.1);
    const py = h * 0.86 - ph;
    ctx.fillStyle = `rgba(6, 8, 14, ${0.72 + depth * 0.25})`;
    // body
    ctx.fillRect(px - pw / 2, py + ph * 0.28, pw, ph * 0.72);
    // head
    ctx.beginPath();
    ctx.arc(px, py + ph * 0.16, ph * 0.13, 0, Math.PI * 2);
    ctx.fill();
    // one raised arm, party rules
    if (rnd() < 0.6) {
      ctx.save();
      ctx.translate(px + (rnd() < 0.5 ? -1 : 1) * pw * 0.45, py + ph * 0.36);
      ctx.rotate((rnd() - 0.2) * 1.1);
      ctx.fillRect(-pw * 0.09, -ph * 0.34, pw * 0.18, ph * 0.36);
      ctx.restore();
    }
  }

  // Flash character: bright center falloff + hard vignette.
  if (c.flash) {
    const fl = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, w * 0.75);
    fl.addColorStop(0, 'rgba(255, 250, 235, 0.34)');
    fl.addColorStop(0.55, 'rgba(255, 245, 225, 0.10)');
    fl.addColorStop(1, 'rgba(0, 0, 0, 0.30)');
    ctx.fillStyle = fl;
    ctx.fillRect(0, 0, w, h);
  }

  // Cheap-sensor noise.
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 260 * scale; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#fff' : '#000';
    ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  // Per-module sensor variation. Real OV3660 units differ slightly in
  // brightness and channel balance even with identical settings — this is
  // what sensor-matching calibration measures and corrects. CAM2 is the
  // reference, so it stays neutral.
  const VARIATION = [
    { brightness: 1.045, r: 1.03, b: 0.98 },
    { brightness: 1.0, r: 1.0, b: 1.0 },
    { brightness: 0.975, r: 0.99, b: 1.03 },
    { brightness: 1.02, r: 0.97, b: 1.04 },
  ][camIdx] ?? { brightness: 1, r: 1, b: 1 };

  if (VARIATION.brightness !== 1) {
    ctx.filter = `brightness(${VARIATION.brightness})`;
    ctx.drawImage(canvas, 0, 0);
    ctx.filter = 'none';
  }
  if (VARIATION.r !== 1 || VARIATION.b !== 1) {
    // Cheap channel trim: tint overlay in the direction of the imbalance.
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = Math.min(0.18, Math.abs(VARIATION.r - VARIATION.b) * 3);
    ctx.fillStyle = VARIATION.r > VARIATION.b ? '#ff9a5a' : '#5aa0ff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // Quad slots get their recipe character; wiggles stay matched.
  if (c.summary.kind === 'quad') {
    const filters = [
      'saturate(1.15) contrast(1.08)', // party-neg
      'saturate(1.05) blur(1.2px) brightness(1.05)', // motion
      'none', // raw-digi
      'grayscale(1) contrast(1.3)', // mono
    ];
    const f = filters[camIdx] ?? 'none';
    if (f !== 'none') {
      ctx.filter = f;
      ctx.drawImage(canvas, 0, 0);
      ctx.filter = 'none';
    }
  }

  // CAM number burn-in, like the debug builds of the real firmware.
  ctx.font = `700 ${Math.max(10, 13 * scale)}px Consolas, monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(`C${camIdx + 1}`, 8 * scale, h - 8 * scale);

  const quality = w <= 400 ? 0.7 : 0.78;
  const bytes = await encodeJpeg(canvas, quality);
  // Thumbs answer in one protocol frame — stay under MAX_PAYLOAD.
  if (w <= 400 && bytes.length > 15000) return encodeJpeg(canvas, 0.45);
  return bytes;
}

async function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('JPEG encode failed');
  return new Uint8Array(await blob.arrayBuffer());
}

// ---- live viewfinder synthesis ----

const PREVIEW_W = 320;
const PREVIEW_H = 240;

/**
 * One animated viewfinder frame, ~CAM2 viewpoint. Time-based phase moves
 * the lights and people so polling at 4–6 fps reads as live video.
 */
export async function renderPreviewFrame(camIdx: number, phaseMs: number): Promise<Uint8Array> {
  if (typeof document === 'undefined') {
    return fakeJpegBytes(`preview/${camIdx}/${Math.floor(phaseMs / 250)}`, 5000, 4000);
  }
  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  const ctx = canvas.getContext('2d')!;
  const t = phaseMs / 1000;
  const eye = (camIdx - 1.5) * 6;

  const bg = ctx.createLinearGradient(0, 0, 0, PREVIEW_H);
  bg.addColorStop(0, '#241038');
  bg.addColorStop(1, '#5b2a86');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);

  for (let i = 0; i < 5; i++) {
    const x = ((i * 73 + Math.sin(t * 0.9 + i) * 26 + eye * 0.2) % (PREVIEW_W + 40)) - 20;
    const y = 22 + ((i * 37) % 60) + Math.cos(t * 1.3 + i * 2) * 8;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 26);
    g.addColorStop(0, LIGHT_COLORS[i % LIGHT_COLORS.length]);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(x - 26, y - 26, 52, 52);
  }

  ctx.fillStyle = 'rgba(8,10,16,0.5)';
  ctx.fillRect(0, PREVIEW_H * 0.76, PREVIEW_W, PREVIEW_H * 0.24);

  for (let i = 0; i < 3; i++) {
    const sway = Math.sin(t * (1.1 + i * 0.4) + i * 2.1) * 9;
    const px = 60 + i * 95 + sway + eye;
    const ph = 90 + i * 14 + Math.abs(Math.sin(t * 2 + i)) * 6; // dancing
    const pw = ph * 0.36;
    const py = PREVIEW_H * 0.88 - ph;
    ctx.fillStyle = 'rgba(6,8,14,0.9)';
    ctx.fillRect(px - pw / 2, py + ph * 0.26, pw, ph * 0.74);
    ctx.beginPath();
    ctx.arc(px, py + ph * 0.14, ph * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  // sensor noise
  ctx.globalAlpha = 0.07;
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000';
    ctx.fillRect(Math.random() * PREVIEW_W, Math.random() * PREVIEW_H, 1, 1);
  }
  ctx.globalAlpha = 1;

  const bytes = await encodeJpeg(canvas, 0.6);
  // One preview frame = one protocol frame; keep under MAX_PAYLOAD.
  if (bytes.length > 15000) return encodeJpeg(canvas, 0.4);
  return bytes;
}

/** Node fallback: deterministic bytes with JPEG magic, for protocol tests. */
function fakeJpegBytes(seedText: string, baseSize = 24_000, spread = 40_000): Uint8Array {
  const rnd = mulberry32(hashId(seedText));
  const size = baseSize + Math.floor(rnd() * spread);
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  for (let i = 11; i < size - 2; i++) bytes[i] = Math.floor(rnd() * 256);
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return bytes;
}
