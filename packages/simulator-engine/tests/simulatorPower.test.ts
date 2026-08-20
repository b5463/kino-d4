import { describe, expect, it, vi } from 'vitest';
import { TwinSimulator } from '../src/TwinSimulator';
import type { PowerSample } from '../src/power';

describe('TwinSimulator live power wiring', () => {
  it('samples at 2 Hz while powered and stops sampling after power-off', () => {
    vi.useFakeTimers();
    try {
      let nowMs = 0;
      const sim = new TwinSimulator({ seed: 9, now: () => nowMs });
      const samples: PowerSample[] = [];
      sim.onEvent((event) => {
        if (event.t === 'power') samples.push(event.sample);
      });

      sim.powerOn();
      for (let i = 0; i < 4; i++) {
        nowMs += 500;
        vi.advanceTimersByTime(500);
      }
      expect(samples).toHaveLength(4);
      expect(samples.every((sample) => sample.busA > 0)).toBe(true);
      expect(samples.every((sample) => sample.tags.busA !== undefined)).toBe(true);

      sim.powerOff();
      const countAtPowerOff = samples.length;
      nowMs += 2_000;
      vi.advanceTimersByTime(2_000);
      expect(samples).toHaveLength(countAtPowerOff);
      sim.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
