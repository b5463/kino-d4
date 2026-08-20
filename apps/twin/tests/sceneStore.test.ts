import { beforeEach, describe, expect, it } from 'vitest';
import { D4_V1, NET_CLASSES } from '@kino/hardware-profiles';
import { useSceneStore } from '../src/state/sceneStore';
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
