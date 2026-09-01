// Issue #154: a MEDIA_INFO reply with neither `files[].sha256` nor `meta`.
//
// That is what every shipped body sends (contract D20) — hashing four
// multi-megabyte JPEGs on request would block the link for seconds, and the
// `meta` block is attached only when the capture's META.JSON could be read —
// and `types.ts` typed both as required. Studio therefore compiled clean and
// threw on real hardware: `file.sha256.toLowerCase()` in the transfer path,
// `info.meta.batteryV.toFixed(2)` in the metadata table.
//
// The reference device could not reproduce it either: it computed both,
// always. `scenarios.mediaInfoAsShipped` is the mode this test drives, so the
// mock and the firmware can be checked against the same host code.
//
// Environment is node (see vite.config.ts); the component is rendered through
// react-dom/server like the other .tsx tests here.

import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { CaptureInfo } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { KinoDevice } from '../src/device/KinoDevice';
import { declaredDigest, downloadCaptureFile, TransferHandle } from '../src/device/media';
import { CaptureMeta } from '../src/pages/Gallery/CaptureMeta';
import { parseCaptureMeta, parseLocalCapture } from '../src/device/localImport';
import { captureOffsets } from '../src/utils/wiggleRender';

let transport: MockTransport | null = null;

async function connectAsShipped() {
  const mock = new MockKinoDevice();
  mock.setScenario('mediaInfoAsShipped', true);
  transport = new MockTransport(mock);
  await transport.open();
  return new KinoDevice(new KinoProtocolClient(transport));
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

/** A reply with both fields gone, built by hand for the render assertions. */
const BARE: CaptureInfo = {
  id: 'WG_0001',
  kind: 'wiggle',
  ts: 1_720_000_000_000,
  recipeIds: ['party-neg'],
  favorite: false,
  resolution: '1600x1200',
  totalKB: 812,
  files: [
    { name: 'C1.JPG', sizeBytes: 210_000 },
    { name: 'C2.JPG', sizeBytes: 208_400 },
    { name: 'C3.JPG', sizeBytes: 209_100 },
    { name: 'C4.JPG', sizeBytes: 203_800 },
  ],
};

describe('the reference device can answer MEDIA_INFO the way firmware does', () => {
  it('omits every per-file digest and the whole meta block', async () => {
    const dev = await connectAsShipped();
    const list = await dev.mediaList();
    const info = await dev.mediaInfo(list.items[0].id);

    expect(info.files.length).toBeGreaterThan(0);
    for (const f of info.files) {
      expect(f.sha256).toBeUndefined();
      expect(f.sizeBytes).toBeGreaterThan(0);
    }
    expect(info.meta).toBeUndefined();
    // Not an empty object either: a `{}` would satisfy a truthiness check and
    // then throw on the first field read.
    expect(Object.keys(info)).not.toContain('meta');
  }, 20000);

  it('downloads the file and reports it unverified rather than throwing or passing', async () => {
    const dev = await connectAsShipped();
    const list = await dev.mediaList();
    const info = await dev.mediaInfo(list.items[0].id);
    const { data, verified } = await downloadCaptureFile(dev, info, info.files[0].name, new TransferHandle());

    expect(verified).toBe(false);
    expect(data.length).toBe(info.files[0].sizeBytes);
    expect(data[0]).toBe(0xff); // still a JPEG; the bytes are real, just unchecked
    expect(data[1]).toBe(0xd8);
  }, 20000);
});

describe('declaredDigest', () => {
  it('is null for an absent digest and for anything that is not 64 hex', () => {
    expect(declaredDigest({ name: 'C1.JPG', sizeBytes: 1 })).toBeNull();
    expect(declaredDigest({ name: 'C1.JPG', sizeBytes: 1, sha256: '' })).toBeNull();
    expect(declaredDigest({ name: 'C1.JPG', sizeBytes: 1, sha256: 'abc' })).toBeNull();
    expect(declaredDigest({ name: 'C1.JPG', sizeBytes: 1, sha256: 'A'.repeat(64) })).toBe('a'.repeat(64));
  });
});

describe('the metadata table renders a capture with neither field', () => {
  const markup = () =>
    renderToStaticMarkup(<CaptureMeta info={BARE} kind="wiggle" lookName={(id) => (id ?? '').toUpperCase()} />);

  it('does not throw', () => {
    expect(() => markup()).not.toThrow();
  });

  it('states the absence instead of printing a zero', () => {
    const html = markup();
    expect(html).toContain('no META.JSON');
    expect(html).toContain('UNVERIFIED');
    // The three figures that used to be fabricated from a missing block.
    expect(html).not.toContain('0.00 V');
    expect(html).not.toContain('0 µs');
    expect(html).not.toContain('P4 undefined');
    // What the reply does carry is still shown.
    expect(html).toContain('1600×1200');
    expect(html).toContain('PARTY-NEG');
  });

  it('still says VERIFIED when the digests did arrive', () => {
    const withDigests: CaptureInfo = {
      ...BARE,
      files: BARE.files.map((f) => ({ ...f, sha256: 'a'.repeat(64) })),
    };
    const html = renderToStaticMarkup(
      <CaptureMeta info={withDigests} kind="wiggle" lookName={(id) => (id ?? '').toUpperCase()} />,
    );
    expect(html).toContain('SHA-256 VERIFIED');
    expect(html).not.toContain('UNVERIFIED');
  });
});

describe('alignment falls back to live calibration when meta is gone', () => {
  it('reads no recorded offsets off a capture with no meta, and invents none', () => {
    const live = { cams: { cam1: { x: -3, y: 2, rot: 0.4 } } };
    expect(captureOffsets(BARE, live)[0]).toEqual({ x: -3, y: 2, rot: 0.4 });
    expect(captureOffsets(BARE, null)[0]).toEqual({ x: 0, y: 0, rot: 0 });
  });
});

describe('a tethered folder whose META.JSON carries neither field', () => {
  const doc = JSON.stringify(BARE);

  it('parses instead of being reported unreadable', () => {
    const parsed = parseCaptureMeta(doc);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('WG_0001');
    expect(parsed?.meta).toBeUndefined();
  });

  it('keeps the identity the document proves and warns about what it does not', () => {
    const frames = BARE.files.map((f) => ({ name: f.name, data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }));
    const cap = parseLocalCapture('some-copied-folder', frames, doc);

    expect(cap.summary.id).toBe('WG_0001');
    expect(cap.summary.ts).toBe(1_720_000_000_000);
    expect(cap.warnings).toContain('META.JSON CARRIES NO CAPTURE BLOCK — EXPOSURE, SKEW AND BATTERY UNKNOWN');
  });

  it('still rejects a malformed digest — a wrong one is worse than none', () => {
    const bad = JSON.stringify({ ...BARE, files: [{ name: 'C1.JPG', sizeBytes: 1, sha256: 'nope' }] });
    expect(parseCaptureMeta(bad)).toBeNull();
  });

  it('still rejects a half-written meta block', () => {
    const half = JSON.stringify({ ...BARE, meta: { flash: false } });
    expect(parseCaptureMeta(half)).toBeNull();
  });
});
