// Issue #246: the GET_SCREEN conformance case. Passive, so it runs in the
// default suite: it renders what the panel already shows and changes nothing.
// A body without `screenControl` skips it rather than going red.

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

describe('GET_SCREEN conformance', () => {
  it('passes on a body with screenControl and names the screen', async () => {
    const dev = await connect(new MockKinoDevice({ ambientCaptures: false }));
    const r = find(await runConformance(dev, false), 'GET_SCREEN');
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('menu');
    expect(r.detail).toContain('800x480');
  }, 60000);

  it('skips on a body without it', async () => {
    const mock = new MockKinoDevice({ ambientCaptures: false });
    mock.setScenario('legacyFirmware', true);
    const dev = await connect(mock);
    const r = find(await runConformance(dev, false), 'GET_SCREEN');
    expect(r.status).toBe('skipped');
  }, 60000);
});
