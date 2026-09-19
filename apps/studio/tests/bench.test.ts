// The hardware worksheet (issue #93): the measurements table must derive
// from the profile data — a recorded measurement removes its own row — and
// the checklist ids must stay unique so persisted checks never collide.
import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import type { HardwareProfile } from '@kino/hardware-profiles';
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

type Component = HardwareProfile['components'][number];
type Instance = HardwareProfile['instances'][number];

/** A PROVISIONAL 10×10×10 part, optionally placed once in the profile. */
function withPart(id: string, placed: boolean): HardwareProfile {
  const template = D4_V1.components.find((c) => c.id === 'top-light')!;
  const component: Component = {
    ...template,
    id,
    name: `Test part ${id}`,
    sources: [{ ...template.sources[0]!, kind: 'PROVISIONAL', sizeMm: [10, 10, 10] }],
  };
  const instance: Instance = {
    ...D4_V1.instances.find((i) => i.component === 'top-light')!,
    id: `${id}-1`,
    component: id,
  };
  return {
    ...D4_V1,
    components: [...D4_V1.components, component],
    instances: placed ? [...D4_V1.instances, instance] : D4_V1.instances,
  };
}

describe('bench worksheet', () => {
  it('derives the open measurements from the profile data', () => {
    const tasks = measurementTasks(D4_V1);
    const ids = tasks.map((t) => t.id);

    // Known-unmeasured facts of the current profile, all of them fitted.
    expect(ids).toContain('dims-main-display'); // board envelope has a null axis
    expect(ids).toContain('dims-top-light'); // PROVISIONAL external light, on its stud
    expect(ids).toContain('fov'); // MEASURE_REQUIRED optics
    expect(ids).toContain('gpio'); // null pin assignments exist
    expect(ids).toContain('optical-centers'); // OFFICIAL_CAD offsets, not measured

    // The body is OFFICIAL_CAD from hardware/cad/KINO_FIELD_BODY: no row.
    expect(ids).not.toContain('body');
    // The six field shells are OFFICIAL_CAD as well.
    for (const shell of ['field-chassis-front', 'field-chassis-rear', 'field-face-shell', 'field-lens-cover', 'field-slider-keeper', 'field-rear-door']) {
      expect(ids).not.toContain(`dims-${shell}`);
    }

    // Every row says where the measured value gets recorded.
    for (const task of tasks) {
      expect(task.recordIn.length).toBeGreaterThan(0);
      expect(task.current.length).toBeGreaterThan(0);
    }
  });

  it('does not ask for parts the field body does not fit', () => {
    // `components` still carries the battery build's BOM history; none of
    // these has an instance in the USB-C powered field body (ECN-0004), and a
    // part that is not in the camera cannot be measured on the bench.
    const ids = measurementTasks(D4_V1).map((t) => t.id);
    const fitted = new Set(D4_V1.instances.map((i) => i.component));
    const unfitted = D4_V1.components.filter((c) => !fitted.has(c.id)).map((c) => c.id);
    expect(unfitted).toEqual(expect.arrayContaining(['battery', 'fuse', 'bms', 'power-module', 'speaker', 'slide-switch']));
    for (const id of unfitted) expect(ids, `${id} has no instance`).not.toContain(`dims-${id}`);
    // Every dims row names a placed component.
    for (const id of ids.filter((i) => i.startsWith('dims-'))) {
      expect(fitted.has(id.slice('dims-'.length)), `${id} should be fitted`).toBe(true);
    }
  });

  it('a component owes a measurement only once it is placed', () => {
    expect(measurementTasks(withPart('test-part', false)).map((t) => t.id)).not.toContain('dims-test-part');
    const placed = measurementTasks(withPart('test-part', true)).find((t) => t.id === 'dims-test-part');
    expect(placed).toBeDefined();
    expect(placed!.current).toMatch(/^PROVISIONAL 10×10×10 mm/);
    expect(placed!.recordIn).toMatch(/MEASURE ACTUAL PART/);
  });

  it('a measured value removes its own row', () => {
    const measured = withPart('test-part', true);
    measured.components = measured.components.map((c) =>
      c.id === 'test-part' ? { ...c, sources: [{ ...c.sources[0]!, kind: 'MEASURED' as const }] } : c,
    );
    expect(measurementTasks(measured).map((t) => t.id)).not.toContain('dims-test-part');
  });

  it('the body row exists only while the envelope is neither measured nor released CAD', () => {
    const at = (confidence: HardwareProfile['body']['confidence']) =>
      measurementTasks({ ...D4_V1, body: { ...D4_V1.body, confidence } }).find((t) => t.id === 'body');
    expect(at('OFFICIAL_CAD')).toBeUndefined();
    expect(at('MEASURED')).toBeUndefined();
    const provisional = at('PROVISIONAL');
    expect(provisional).toBeDefined();
    // The enclosure-shell/enclosure-chassis skeleton is gone; the row must not
    // send anyone to measure ribs on a part that no longer exists.
    expect(`${provisional!.task} ${provisional!.recordIn}`).not.toMatch(/skeleton|rib|enclosure-shell|enclosure-chassis/);
    expect(provisional!.recordIn).toMatch(/field-/);
  });

  it('stages and acceptance describe the USB-C field body', () => {
    const text = [
      ...BENCH_STAGES.flatMap((s) => s.items.map((i) => i.text)),
      ...ACCEPTANCE_ITEMS.map((i) => i.text),
    ].join('\n');
    for (const gone of [/SW6106/, /LiPo/i, /batter(y|ies)/i, /\bBMS\b/, /\bflash\b/i]) {
      expect(text, `bench text still mentions ${String(gone)}`).not.toMatch(gone);
    }
    expect(BENCH_STAGES[0]!.items[0]!.text).toMatch(/USB-C/);
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
