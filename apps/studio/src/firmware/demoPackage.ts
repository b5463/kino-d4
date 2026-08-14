import type { FwPackage } from './manifest';
import { sha256Hex } from './hashing';

// Builds an in-memory firmware package for simulator mode, so the whole
// update pipeline (manifest validation, hashing, chunking, retry) runs for
// real without any files on disk.

function fakeImage(size: number, tag: string): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes.subarray(0, Math.min(size, 65536)));
  // ESP32 app image magic byte, for flavor.
  bytes[0] = 0xe9;
  const label = new TextEncoder().encode(`KINO ${tag}`);
  bytes.set(label, 16);
  return bytes;
}

export async function buildDemoPackage(): Promise<FwPackage> {
  const p4Image = fakeImage(1_474_560, 'p4-app 0.5.0');
  const xiaoImage = fakeImage(917_504, 'xiao-app 0.5.0');
  return {
    manifest: {
      schema: 1,
      product: 'kino-v1',
      version: '0.5.0',
      protocol: 1,
      p4: { version: '0.5.0', file: 'p4-app.bin', sha256: await sha256Hex(p4Image) },
      xiao: { version: '0.5.0', file: 'xiao-app.bin', sha256: await sha256Hex(xiaoImage) },
      compatibility: { hardware: ['v1'], minimumProtocol: 1 },
      releaseNotes:
        '0.5.0: faster wiggle assembly, CAM sync skew halved, Party Neg flash rolloff adjusted, SD hot-swap fix.',
    },
    p4Image,
    xiaoImage,
    sourceName: 'demo package (in memory)',
  };
}
