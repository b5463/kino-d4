// Computer→Studio import (audit row "Photo import"): a folder the tether
// wrote, parsed back with no camera attached and no File System Access API.
// The fixture is built in memory, exactly as `readCaptureDir` hands the bytes
// over — folder name, JPEG bytes, META.JSON text.

import { describe, expect, it } from 'vitest';
import type { CaptureInfo } from '@kino/kdp';
import { parseCaptureMeta, parseLocalCapture } from '../src/device/localImport';
import type { LocalFrame } from '../src/device/localImport';

/** JPEG SOI plus filler — the parser reads names and sizes, not pixels. */
function jpeg(size: number, seed: number): Uint8Array {
  const data = new Uint8Array(size).fill(seed & 0xff);
  data[0] = 0xff;
  data[1] = 0xd8;
  return data;
}

/** What TETHER writes: the camera's own file names, in CAM order. */
function tetherFrames(count = 4): LocalFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `C${i + 1}_RAW.JPG`,
    data: jpeg(2048 + i, i + 1),
  }));
}

function tetherMeta(frames: LocalFrame[], over: Partial<CaptureInfo> = {}): CaptureInfo {
  return {
    id: 'WG_0042',
    kind: 'wiggle',
    ts: 1_720_000_000_000,
    recipeIds: ['kodak-gold'],
    favorite: true,
    resolution: '1600x1200',
    totalKB: 8,
    files: frames.map((f) => ({ name: f.name, sizeBytes: f.data.length, sha256: 'a'.repeat(64) })),
    meta: {
      flash: false,
      batteryV: 3.92,
      p4Firmware: '1.4.0',
      cameraFirmware: ['1.4.0', '1.4.0', '1.4.0', '1.4.0'],
      gpioSkewUs: 180,
      exposure: [{ cam: 'cam1', shutter: '1/250', gain: 2 }],
    },
    ...over,
  };
}

describe('local import — folder with META.JSON', () => {
  it('takes the capture identity from the meta, not the folder name', () => {
    const frames = tetherFrames();
    const cap = parseLocalCapture('some-copied-folder', frames, JSON.stringify(tetherMeta(frames)));

    expect(cap.info).not.toBeNull();
    expect(cap.summary).toEqual({ id: 'WG_0042', kind: 'wiggle', ts: 1_720_000_000_000, favorite: true });
    expect(cap.frames).toHaveLength(4);
    expect(cap.warnings).toEqual([]);
  });

  it('orders frames the way META.JSON lists them, not the way the folder does', () => {
    const frames = tetherFrames();
    const shuffled = [frames[3], frames[0], frames[2], frames[1]];
    const cap = parseLocalCapture('WG_0042', shuffled, JSON.stringify(tetherMeta(frames)));

    expect(cap.frames.map((f) => f.name)).toEqual(['C1_RAW.JPG', 'C2_RAW.JPG', 'C3_RAW.JPG', 'C4_RAW.JPG']);
    expect(cap.frames[0].data).toBe(frames[0].data);
  });

  it('ignores files that are not JPEGs', () => {
    const frames = tetherFrames();
    const cap = parseLocalCapture(
      'WG_0042',
      [...frames, { name: 'NOTES.TXT', data: new Uint8Array([1]) }],
      JSON.stringify(tetherMeta(frames)),
    );
    expect(cap.frames.map((f) => f.name)).not.toContain('NOTES.TXT');
    expect(cap.warnings).toEqual([]);
  });

  it('carries recorded alignment offsets through untouched', () => {
    const frames = tetherFrames();
    const meta = tetherMeta(frames);
    meta.meta.calibration = { version: 'cal-7', cams: { cam1: { x: -3, y: 2, rot: 0.4 } } };
    const cap = parseLocalCapture('WG_0042', frames, JSON.stringify(meta));

    expect(cap.info?.meta.calibration?.version).toBe('cal-7');
    expect(cap.info?.meta.calibration?.cams.cam1).toEqual({ x: -3, y: 2, rot: 0.4 });
  });
});

describe('local import — folder without usable META.JSON', () => {
  it('synthesises the summary from the folder name and says so', () => {
    const cap = parseLocalCapture('WG_0042', tetherFrames(), null);

    expect(cap.info).toBeNull();
    expect(cap.summary).toEqual({ id: 'WG_0042', kind: 'wiggle', ts: null, favorite: false });
    expect(cap.warnings).toContain('NO META.JSON — TIME, LOOKS AND EXPOSURE UNKNOWN');
  });

  it('reads a folder name with no KINO prefix as a quad set', () => {
    // Four stills side by side claim nothing about viewpoint order; wiggle
    // playback would.
    const cap = parseLocalCapture('holiday-shot', tetherFrames(), null);
    expect(cap.summary.kind).toBe('quad');
    expect(cap.summary.ts).toBeNull();
  });

  it('keeps the frames in name order when nothing states the CAM order', () => {
    const frames = tetherFrames();
    const cap = parseLocalCapture('QD_0007', [frames[2], frames[0], frames[3], frames[1]], null);
    expect(cap.frames.map((f) => f.name)).toEqual(['C1_RAW.JPG', 'C2_RAW.JPG', 'C3_RAW.JPG', 'C4_RAW.JPG']);
  });

  it('treats broken JSON as no metadata rather than throwing', () => {
    const cap = parseLocalCapture('WG_0042', tetherFrames(), '{"id":"WG_0042",');
    expect(cap.info).toBeNull();
    expect(cap.warnings).toContain('META.JSON UNREADABLE — TIME, LOOKS AND EXPOSURE UNKNOWN');
  });

  it('rejects a meta that is missing a field the inspector renders', () => {
    const frames = tetherFrames();
    for (const drop of ['recipeIds', 'resolution', 'files', 'meta'] as const) {
      const meta = tetherMeta(frames) as unknown as Record<string, unknown>;
      delete meta[drop];
      expect(parseCaptureMeta(JSON.stringify(meta)), drop).toBeNull();
    }
    const noBattery = tetherMeta(frames);
    delete (noBattery.meta as unknown as Record<string, unknown>).batteryV;
    expect(parseCaptureMeta(JSON.stringify(noBattery))).toBeNull();
    // A resolution the device never reports is not accepted either.
    expect(parseCaptureMeta(JSON.stringify(tetherMeta(frames, { resolution: '4000x3000' as never })))).toBeNull();
  });
});

describe('local import — frame count', () => {
  it('flags a short folder and still opens what is there', () => {
    const cap = parseLocalCapture('WG_0042', tetherFrames(2), null);
    expect(cap.frames).toHaveLength(2);
    expect(cap.warnings).toContain('2 JPEGS IN FOLDER — A CAPTURE HAS 4');
  });

  it('flags a folder with a single frame in the singular', () => {
    const cap = parseLocalCapture('WG_0042', tetherFrames(1), null);
    expect(cap.warnings).toContain('1 JPEG IN FOLDER — A CAPTURE HAS 4');
  });

  it('flags a folder holding fewer files than META.JSON lists', () => {
    const full = tetherFrames();
    const cap = parseLocalCapture('WG_0042', full.slice(0, 3), JSON.stringify(tetherMeta(full)));
    expect(cap.frames).toHaveLength(3);
    expect(cap.warnings).toContain('3 JPEGS IN FOLDER — A CAPTURE HAS 4');
    expect(cap.warnings).toContain('META.JSON LISTS 4 FILES, FOLDER HOLDS 3');
  });

  it('reports an empty folder rather than pretending it is a capture', () => {
    const cap = parseLocalCapture('WG_0042', [], null);
    expect(cap.frames).toEqual([]);
    expect(cap.warnings).toContain('0 JPEGS IN FOLDER — A CAPTURE HAS 4');
  });
});
