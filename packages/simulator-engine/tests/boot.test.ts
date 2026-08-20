// TwinSimulator's boot-stage machine, under fake timers.
import { describe, expect, it, vi } from 'vitest';
import { TwinSimulator } from '../src/TwinSimulator';
import { BOOT_STAGES } from '../src/events';
import type { BootStage } from '../src/events';

describe('TwinSimulator boot machine', () => {
  it('powerOn() walks all seven stages in order and ends READY', () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 1 });
      const stages: BootStage[] = [sim.bootStage()]; // POWER_OFF, the initial state
      const unsubscribe = sim.onEvent((e) => {
        if (e.t === 'boot') stages.push(e.stage);
      });

      sim.powerOn();
      vi.advanceTimersByTime(2_200);

      expect(stages).toEqual([...BOOT_STAGES]);
      expect(sim.bootStage()).toBe('READY');

      unsubscribe();
      sim.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('powerOff() returns to POWER_OFF', () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 1 });

      sim.powerOn();
      vi.advanceTimersByTime(2_200);
      expect(sim.bootStage()).toBe('READY');

      sim.powerOff();
      expect(sim.bootStage()).toBe('POWER_OFF');

      sim.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('powerOff() is idempotent when the simulator is already off', () => {
    const sim = new TwinSimulator({ seed: 1 });
    const stages: BootStage[] = [];
    sim.onEvent((e) => {
      if (e.t === 'boot') stages.push(e.stage);
    });

    sim.powerOff();
    sim.powerOff();

    expect(stages).toEqual([]);
    expect(sim.bootStage()).toBe('POWER_OFF');
    sim.dispose();
  });

  it('a mid-boot powerOff() cancels the pending stage transitions', () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 1 });

      sim.powerOn();
      vi.advanceTimersByTime(400); // now at CAMERA_RAIL_START
      expect(sim.bootStage()).toBe('CAMERA_RAIL_START');

      sim.powerOff();
      vi.advanceTimersByTime(2_000); // long enough to reach READY if timers weren't cleared

      expect(sim.bootStage()).toBe('POWER_OFF');

      sim.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a device reboot replays the boot stage sequence', () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 1 });
      sim.powerOn();
      vi.advanceTimersByTime(2_200);
      expect(sim.bootStage()).toBe('READY');

      const stages: BootStage[] = [];
      const unsubscribe = sim.onEvent((e) => {
        if (e.t === 'boot') stages.push(e.stage);
      });

      // A real device-side reboot (KINO Twin §17 session restart) — not a
      // JSON side-channel, the same public scenario knob Task 4 added.
      sim.device.setScenario('sessionRestart', true);
      vi.advanceTimersByTime(2_200);

      expect(stages).toEqual(BOOT_STAGES.slice(1)); // BOOTING_P4 .. READY, same walk as powerOn()
      expect(sim.bootStage()).toBe('READY');

      unsubscribe();
      sim.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
