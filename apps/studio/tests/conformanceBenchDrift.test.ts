// The two conformance drifts the 0.4.17 bench run on KD4-D121BC exposed.
//
//  - HELLO reported `clockSource: network`, which the firmware is right to
//    send (SNTP from the C6 radio, contract D16) and the shape check rejected
//    because the normative union was never widened. Same class as the seven
//    missing capability flags in #146: the radio arrived, the type did not
//    learn it.
//  - `CAMERA_TEST (CAM2)` reported ERROR — "Camera node not connected" — on a
//    unit with only CAM1 fitted, which is the normal bench configuration. A
//    case that goes red because the hardware legitimately lacks that part
//    trains people to ignore red.

import { afterEach, describe, expect, it } from 'vitest';
import { KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { KinoDevice } from '../src/device/KinoDevice';
import { runConformance } from '../src/developer/conformance';
import type { ConformanceResult } from '../src/developer/conformance';

let transport: MockTransport | null = null;

async function connect(mock: MockKinoDevice) {
  transport = new MockTransport(mock);
  await transport.open();
  return new KinoDevice(new KinoProtocolClient(transport));
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

const find = (results: ConformanceResult[], name: string): ConformanceResult => {
  const hit = results.find((r) => r.name === name);
  expect(hit, `no ${name} case`).toBeDefined();
  return hit!;
};

describe('HELLO accepts the radio build clock source', () => {
  it('passes on clockSource network and names it', async () => {
    const mock = new MockKinoDevice();
    mock.setClockSource('network');
    const dev = await connect(mock);

    const hello = find(await runConformance(dev, false), 'HELLO');
    expect(hello.status).toBe('pass');
    expect(hello.detail).toContain('clock network');
  }, 60000);

  it('still fails a clock source nothing knows how to read', async () => {
    const mock = new MockKinoDevice();
    // Past the setter's union on purpose: the check must reject a value no
    // consumer can interpret, which is the reason it exists.
    mock.setClockSource('gps' as never);
    const dev = await connect(mock);

    const hello = find(await runConformance(dev, false), 'HELLO');
    expect(hello.status).toBe('shape');
    expect(hello.detail).toContain('unknown clockSource gps');
  }, 60000);
});

describe('a camera channel that is not fitted', () => {
  it('skips the per-camera case and names the channel instead of erroring', async () => {
    const mock = new MockKinoDevice();
    mock.setCamFault('cam2', 'offline');
    const dev = await connect(mock);

    const results = await runConformance(dev, true);
    const cam2 = find(results, 'CAMERA_TEST (CAM2)');
    expect(cam2.status).toBe('skipped');
    expect(cam2.detail).toContain('CAM2');
    // The fitted channel is still tested — the gate must not silence the suite.
    expect(find(results, 'CAMERA_TEST (CAM1, 1B shape)').status).toBe('pass');
    expect(results.filter((r) => r.status === 'error').map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
  }, 180000);
});
