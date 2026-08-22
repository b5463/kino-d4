import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockKinoDevice } from '../src/MockKinoDevice';
import type { TwinTelemetry } from '../src/telemetry';

function attachAndCollect(device: MockKinoDevice): TwinTelemetry[] {
  const events: TwinTelemetry[] = [];
  device.onTelemetry((e) => events.push(e));
  device.attach(
    () => {},
    () => {},
  );
  return events;
}

describe('ambientCaptures option', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('off: the device never fires a capture on its own', () => {
    const device = new MockKinoDevice({ seed: 7, now: () => Date.now(), ambientCaptures: false });
    const events = attachAndCollect(device);
    vi.advanceTimersByTime(60_000);
    expect(events.filter((e) => e.t === 'capture')).toEqual([]);
  });

  it('default: a bare fixture keeps its ambient captures', () => {
    const device = new MockKinoDevice({ seed: 7, now: () => Date.now() });
    const events = attachAndCollect(device);
    vi.advanceTimersByTime(60_000);
    expect(events.some((e) => e.t === 'capture')).toBe(true);
  });
});
