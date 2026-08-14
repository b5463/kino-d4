// Custom sounds: WAV encoding, chunked upload/read through the real protocol
// stack, device-side limits, and the shutter-sound fallback on delete.
import { afterEach, describe, expect, it } from 'vitest';
import { KinoProtocolClient } from '../src/protocol/KinoProtocolClient';
import { KinoDevice } from '../src/device/KinoDevice';
import { MockTransport } from '../src/transport/MockTransport';
import { MockKinoDevice } from '../src/mock/MockKinoDevice';
import { uploadSound, readSound, clearSoundCache } from '../src/device/sounds';
import { encodeWav, soundIdFromName, SOUND_SAMPLE_RATE } from '../src/utils/soundFx';

let transport: MockTransport | null = null;

async function connect() {
  const mock = new MockKinoDevice();
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  const device = new KinoDevice(client);
  return { mock, device, client };
}

afterEach(async () => {
  clearSoundCache();
  await transport?.close();
  transport = null;
});

function testWav(durationMs: number): Uint8Array {
  const frames = Math.round((SOUND_SAMPLE_RATE * durationMs) / 1000);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / SOUND_SAMPLE_RATE) * 0.5;
  }
  return encodeWav(samples, SOUND_SAMPLE_RATE);
}

describe('WAV encoding', () => {
  it('writes a valid 16-bit mono PCM header', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
    const view = new DataView(wav.buffer);
    const ascii = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(10); // 5 samples × 2 bytes
    expect(wav.length).toBe(44 + 10);
    // samples clamp and scale
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32767);
  });

  it('derives stable device ids from file names', () => {
    expect(soundIdFromName('My Shutter (v2).wav')).toBe('snd-my-shutter-v2');
    expect(soundIdFromName('...')).toBe('snd-sound');
    expect(soundIdFromName('x'.repeat(60) + '.mp3')).toBe('snd-' + 'x'.repeat(24));
  });
});

describe('custom sounds over the real protocol stack', () => {
  it('ships one demo sound and reports limits', async () => {
    const { device } = await connect();
    const sounds = await device.getSounds();
    expect(sounds.custom).toHaveLength(1);
    expect(sounds.custom[0].id).toBe('snd-ding');
    expect(sounds.maxCustom).toBe(8);
    expect(sounds.maxSoundKB).toBe(128);
  });

  it('uploads a clip in chunks and reads back identical bytes', async () => {
    const { device } = await connect();
    const wav = testWav(1500); // 48 KB — several chunks
    const meta = { id: 'snd-test', name: 'test', sizeBytes: wav.length, durationMs: 1500 };
    const stored = await uploadSound(device, meta, wav);
    expect(stored.id).toBe('snd-test');
    expect(stored.sizeBytes).toBe(wav.length);

    const sounds = await device.getSounds();
    expect(sounds.custom.map((s) => s.id)).toContain('snd-test');

    clearSoundCache(); // force a real chunked read, not the upload cache
    const back = await readSound(device, stored);
    expect(back.length).toBe(wav.length);
    expect(back).toEqual(wav);
  });

  it('replaces a clip uploaded under the same id', async () => {
    const { device } = await connect();
    const a = testWav(300);
    const b = testWav(600);
    await uploadSound(device, { id: 'snd-x', name: 'x', sizeBytes: a.length, durationMs: 300 }, a);
    await uploadSound(device, { id: 'snd-x', name: 'x', sizeBytes: b.length, durationMs: 600 }, b);
    const sounds = await device.getSounds();
    const stored = sounds.custom.filter((s) => s.id === 'snd-x');
    expect(stored).toHaveLength(1);
    expect(stored[0].sizeBytes).toBe(b.length);
  });

  it('rejects a clip over the size limit', async () => {
    const { device } = await connect();
    await expect(
      device.soundBegin({ id: 'snd-big', name: 'big', sizeBytes: 129 * 1024, durationMs: 4000 }),
    ).rejects.toThrow(/128 KB/);
  });

  it('rejects builtin ids and refuses a 9th slot', async () => {
    const { device } = await connect();
    await expect(
      device.soundBegin({ id: 'click', name: 'click', sizeBytes: 1024, durationMs: 100 }),
    ).rejects.toThrow(/builtin/i);

    const wav = testWav(100);
    for (let i = 1; i <= 7; i++) {
      // demo sound occupies slot 1 — fill up to 8
      await uploadSound(device, { id: `snd-fill-${i}`, name: `fill ${i}`, sizeBytes: wav.length, durationMs: 100 }, wav);
    }
    await expect(
      device.soundBegin({ id: 'snd-one-too-many', name: 'nope', sizeBytes: wav.length, durationMs: 100 }),
    ).rejects.toThrow(/slots/i);
  });

  it('rejects SOUND_END on a short upload', async () => {
    const { device } = await connect();
    const wav = testWav(500);
    const begin = await device.soundBegin({ id: 'snd-short', name: 'short', sizeBytes: wav.length, durationMs: 500 });
    await device.soundChunk(begin.sessionId, 0, wav.subarray(0, 4096));
    await expect(device.soundEnd()).rejects.toThrow(/received/i);
  });

  it('falls back to CLICK when the active shutter sound is deleted', async () => {
    const { device } = await connect();
    await device.applyConfig({ shoot: { shutterSound: 'snd-ding' } as never });
    expect((await device.getConfig()).config.shoot.shutterSound).toBe('snd-ding');

    await device.soundDelete('snd-ding');
    const after = await device.getConfig();
    expect(after.config.shoot.shutterSound).toBe('click');
    expect((await device.getSounds()).custom).toHaveLength(0);
  });

  it('deleting an inactive sound leaves the shutter sound alone', async () => {
    const { device } = await connect();
    await device.soundDelete('snd-ding');
    expect((await device.getConfig()).config.shoot.shutterSound).toBe('cheap-digi');
  });

  it('NACKs all sound commands on legacy firmware', async () => {
    const { mock, device } = await connect();
    mock.setScenario('legacyFirmware', true);
    await expect(device.getSounds()).rejects.toThrow(/not implemented/i);
    const caps = await device.getCapabilities();
    expect(caps.capabilities.customSounds).toBe(false);
  });

  it('clears custom sounds on factory reset', async () => {
    const { mock, device } = await connect();
    // Factory reset reboots the mock and drops the transport; inspect the
    // device model directly after the dust settles.
    await device.factoryReset();
    await new Promise((r) => setTimeout(r, 600));
    const internal = mock as unknown as { customSounds: Map<string, unknown> };
    expect(internal.customSounds.size).toBe(0);
  });
});
