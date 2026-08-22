import { beforeEach, describe, expect, it } from 'vitest';
import { D4_V1, NET_CLASSES } from '@kino/hardware-profiles';
import { selectPower, useSceneStore } from '../src/state/sceneStore';
import { visualModeFor } from '../src/scene/Assembly';

beforeEach(() => {
  useSceneStore.setState({
    selection: null,
    hovered: null,
    explode: 0,
    pitchMm: D4_V1.cameraPitchMm,
    visibility: {},
    viewMode: 'normal',
    netClasses: new Set(NET_CLASSES),
    netFocus: null,
    measureMode: false,
    measurePoints: [],
    powerProfileId: null,
    optics: {
      enabled: false,
      fovScenarioDeg: null,
      distancesM: [1],
      customM: null,
      subject: 'none',
      subjectWmm: 450,
      subjectHmm: 1700,
    },
  });
});

describe('selectPower — stock vs experimental alternate (audit #63)', () => {
  it('returns the profile power block while no alternate is selected', () => {
    expect(selectPower(useSceneStore.getState())).toBe(D4_V1.power);
  });

  it('returns the alternate power block once selected, and stock again on null', () => {
    useSceneStore.getState().setPowerProfileId('16340-bench');
    expect(useSceneStore.getState().powerProfileId).toBe('16340-bench');
    expect(selectPower(useSceneStore.getState())).toBe(D4_V1.alternatePower['16340-bench']!.power);
    useSceneStore.getState().setPowerProfileId(null);
    expect(selectPower(useSceneStore.getState())).toBe(D4_V1.power);
  });

  it('rejects an id the profile does not declare — falls back to stock', () => {
    useSceneStore.getState().setPowerProfileId('made-up-pack');
    expect(useSceneStore.getState().powerProfileId).toBeNull();
    expect(selectPower(useSceneStore.getState())).toBe(D4_V1.power);
  });
});

describe('sceneStore bounds and toggles', () => {
  it('clamps explode and pitch to profile limits', () => {
    useSceneStore.getState().setExplode(-2);
    expect(useSceneStore.getState().explode).toBe(0);
    useSceneStore.getState().setExplode(3);
    expect(useSceneStore.getState().explode).toBe(1);

    const [lo, hi] = D4_V1.cameraPitchRangeMm;
    useSceneStore.getState().setPitch(lo - 50);
    expect(useSceneStore.getState().pitchMm).toBe(lo);
    useSceneStore.getState().setPitch(hi + 50);
    expect(useSceneStore.getState().pitchMm).toBe(hi);
  });

  it('toggles visibility and net classes reversibly', () => {
    useSceneStore.getState().toggleVisible('cam2');
    expect(useSceneStore.getState().visibility.cam2).toBe(false);
    useSceneStore.getState().toggleVisible('cam2');
    expect(useSceneStore.getState().visibility.cam2).toBe(true);

    useSceneStore.getState().toggleNetClass('UART');
    expect(useSceneStore.getState().netClasses.has('UART')).toBe(false);
    useSceneStore.getState().setAllNetClasses(false);
    expect(useSceneStore.getState().netClasses.size).toBe(0);
    useSceneStore.getState().setAllNetClasses(true);
    expect([...useSceneStore.getState().netClasses]).toEqual(NET_CLASSES);
  });

  it('updates optics scenarios, distances and subject dimensions without invalid values', () => {
    useSceneStore.getState().setOpticsEnabled(true);
    useSceneStore.getState().setFovScenario(90);
    useSceneStore.getState().toggleOpticsDistance(2);
    useSceneStore.getState().setCustomDistance(-4);
    useSceneStore.getState().setSubject('group');
    expect(useSceneStore.getState().optics).toMatchObject({ subjectWmm: 1_600, subjectHmm: 1_700 });
    useSceneStore.getState().setSubjectSize(1_600, 1_700);

    expect(useSceneStore.getState().optics).toMatchObject({
      enabled: true,
      fovScenarioDeg: 90,
      distancesM: [1, 2],
      customM: null,
      subject: 'group',
      subjectWmm: 1_600,
      subjectHmm: 1_700,
    });

    useSceneStore.getState().toggleOpticsDistance(1);
    expect(useSceneStore.getState().optics.distancesM).toEqual([2]);
  });

  it('collects two measurement points, restarts on the third, and clears when disabled', () => {
    useSceneStore.getState().addMeasurePoint([99, 99, 99]);
    expect(useSceneStore.getState().measurePoints).toEqual([]);

    useSceneStore.getState().setMeasureMode(true);
    useSceneStore.getState().addMeasurePoint([1, 2, 3]);
    useSceneStore.getState().addMeasurePoint([4, 6, 8]);
    expect(useSceneStore.getState().measurePoints).toEqual([
      [1, 2, 3],
      [4, 6, 8],
    ]);

    useSceneStore.getState().addMeasurePoint([9, 10, 11]);
    expect(useSceneStore.getState().measurePoints).toEqual([[9, 10, 11]]);

    useSceneStore.getState().setMeasureMode(false);
    expect(useSceneStore.getState()).toMatchObject({ measureMode: false, measurePoints: [] });
  });
});

describe('visualModeFor precedence', () => {
  const base = { isShell: false, storeVisible: true, viewMode: 'normal' as const, isSelected: false, isHovered: false };

  it('keeps hidden above selection and selection above hover', () => {
    expect(visualModeFor({ ...base, storeVisible: false, isSelected: true })).toBe('hidden');
    expect(visualModeFor({ ...base, isSelected: true, isHovered: true })).toBe('selected');
    expect(visualModeFor({ ...base, isHovered: true })).toBe('highlight');
  });

  it('applies enclosure/internals hiding and wiring xray', () => {
    expect(visualModeFor({ ...base, viewMode: 'internals', isShell: true })).toBe('hidden');
    expect(visualModeFor({ ...base, viewMode: 'enclosure' })).toBe('hidden');
    expect(visualModeFor({ ...base, viewMode: 'wiring' })).toBe('xray');
  });
});
