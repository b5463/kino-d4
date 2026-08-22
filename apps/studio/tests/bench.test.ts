// The hardware worksheet (issue #93): the measurements table must derive
// from the profile data — a recorded measurement removes its own row — and
// the checklist ids must stay unique so persisted checks never collide.
import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import {
  ACCEPTANCE_ITEMS,
  BENCH_STAGES,
  exportBenchRecord,
  importBenchRecord,
  measurementTasks,
  setBenchCheck,
  totalBenchChecks,
  useBench,
} from '../src/developer/bench';

describe('bench worksheet', () => {
  it('derives the open measurements from the profile data', () => {
    const tasks = measurementTasks(D4_V1);
    const ids = tasks.map((t) => t.id);

    // Known-unmeasured facts of the current profile.
    expect(ids).toContain('body'); // PROVISIONAL envelope
    expect(ids).toContain('dims-battery'); // PROVISIONAL size-code proxy
    expect(ids).toContain('fov'); // MEASURE_REQUIRED optics
    expect(ids).toContain('gpio'); // null pin assignments exist
    expect(ids).toContain('optical-centers'); // all offsets zero

    // The enclosure is represented once, by the body row.
    expect(ids).not.toContain('dims-enclosure');

    // Every row says where the measured value gets recorded.
    for (const task of tasks) {
      expect(task.recordIn.length).toBeGreaterThan(0);
      expect(task.current.length).toBeGreaterThan(0);
    }
  });

  it('a measured value removes its own row', () => {
    const measured = {
      ...D4_V1,
      body: { ...D4_V1.body, confidence: 'MEASURED' as const },
    };
    expect(measurementTasks(measured).map((t) => t.id)).not.toContain('body');
  });

  it('checklist ids are unique across stages and acceptance', () => {
    const ids = [...BENCH_STAGES.flatMap((s) => s.items.map((i) => i.id)), ...ACCEPTANCE_ITEMS.map((i) => i.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(totalBenchChecks()).toBe(ids.length);
    // Every acceptance item names the issue that tracks it.
    for (const item of ACCEPTANCE_ITEMS) expect(item.issue).toBeGreaterThan(0);
  });

  it('export/import round-trips the record', () => {
    setBenchCheck('a1', true);
    setBenchCheck('d3', true);
    const record = exportBenchRecord();
    useBench.setState({ checks: {}, notes: '' });
    expect(importBenchRecord(record)).toBeNull();
    expect(useBench.getState().checks).toMatchObject({ a1: true, d3: true });
    expect(importBenchRecord({ schema: 'something-else' })).toMatch(/not a kino.bench-record/);
  });
});
