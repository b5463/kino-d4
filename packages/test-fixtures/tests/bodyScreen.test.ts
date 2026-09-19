import { describe, expect, it } from 'vitest';
import { MockKinoDevice } from '../src/MockKinoDevice';
import type { TwinTelemetry } from '../src/telemetry';

// The surface the body's own screen uses (KINO Twin runs the firmware's ui.c
// against this device). It must be the same state a host reaches over KDP,
// never a shortcut around it.
describe('the body screen surface', () => {
  it('reads the config document and merges a written setting like SET_CONFIG', () => {
    const device = new MockKinoDevice();
    const before = device.readConfig();
    expect(before.shoot.flashMode).toBe('auto');
    // A copy: the screen cannot mutate the store by reaching into what it read.
    before.shoot.flashMode = 'off';
    expect(device.readConfig().shoot.flashMode).toBe('auto');

    const revision = device.applyConfigPatch({ shoot: { flashMode: 'on' } } as Parameters<typeof device.applyConfigPatch>[0]);
    const after = device.readConfig();
    expect(after.shoot.flashMode).toBe('on');
    // A deep merge: the rest of `shoot` survives the one-leaf patch.
    expect(after.shoot.volume).toBe(before.shoot.volume);
    expect(device.applyConfigPatch({ mode: 'quad' })).toBe(revision + 1);
  });

  it('fires the shutter through the capture pipeline and refuses only a full card', () => {
    const device = new MockKinoDevice();
    const seen: TwinTelemetry[] = [];
    device.onTelemetry((e) => seen.push(e));
    expect(device.requestCapture('shutter')).toBe(true);
    expect(seen.some((e) => e.t === 'capture' && e.phase === 'begin')).toBe(true);

    device.scenarios.sdFull = true;
    const captures = () => seen.filter((e) => e.t === 'capture').length;
    const before = captures();
    expect(device.requestCapture('shutter')).toBe(false);
    // A refusal is a log line, not a capture: nothing began.
    expect(captures()).toBe(before);
  });

  it('lists the looks factory-first and exposes the card', () => {
    const device = new MockKinoDevice();
    const looks = device.recipesForBody();
    expect(looks[0]).toEqual({ id: 'party-neg', name: 'Party Neg' });
    expect(looks.every((l) => l.id && l.name)).toBe(true);
    expect(device.soundsForBody().length).toBeGreaterThan(0);
    expect(device.mediaStore().list().length).toBeGreaterThan(0);
  });
});
