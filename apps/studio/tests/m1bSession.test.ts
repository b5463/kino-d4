// Studio's real session path against the honest Milestone 1B firmware
// profile (issue #80). This is the code path physical hardware exercises
// first: connect, handshake, populateAll, capability degradation, store
// wiring — none of which the raw-client contract tests touch. The demo
// device is flipped to `d4-m1b` mid-session, exactly like plugging in a
// bench camera after browsing the full-featured demo.
import { afterEach, describe, expect, it } from 'vitest';
import { connectDemo, disconnect, getDemoDevice, getDevice } from '../src/app/session';
import { supports, supportsRollUpload, useDeviceStore } from '../src/state/deviceStore';
import { useConnectionStore } from '../src/state/connectionStore';
import { navItems } from '../src/components/Sidebar';

describe('session against M1B firmware', () => {
  afterEach(async () => {
    await disconnect();
  });

  it('connects, degrades honestly, and hides the sections M1B cannot serve', async () => {
    // First contact: the full demo profile, so stale state exists to shed.
    await connectDemo();
    expect(useConnectionStore.getState().phase).toBe('connected');
    expect(useDeviceStore.getState().power).not.toBeNull();

    // Same unit, honest firmware. The profile survives the reconnect the way
    // a flashed image survives a reboot.
    getDemoDevice()!.setFirmwareProfile('d4-m1b');
    await connectDemo();
    expect(useConnectionStore.getState().phase).toBe('connected');

    const s = useDeviceStore.getState();
    expect(s.capabilitiesState).toBe('loaded');
    expect(s.capabilities?.benchDiagnostics).toBe(true);
    expect(s.capabilities?.gallery).toBe(false);

    // Reads M1B NACKs degrade to absent — and the full-profile values from
    // the first connection must not survive as ghosts.
    expect(s.power).toBeNull();
    expect(s.config).toBeNull();
    expect(s.calibration).toBeNull();
    expect(s.factoryRecipes).toEqual([]);
    expect(s.customRecipes).toEqual([]);
    // Whitelisted reads still land.
    expect(s.stats).not.toBeNull();
    expect(s.storage).not.toBeNull();

    // GET_LOGS still answers under the newest-that-fit budget rule.
    const logs = await getDevice()!.getLogs();
    expect(Array.isArray(logs.entries)).toBe(true);

    // Nav filtering driven by the reported capabilities: sections the
    // firmware cannot serve are not listed (02 §27).
    const ids = navItems({
      developerMode: false,
      rollUpload: supportsRollUpload(s),
      gallery: supports(s, 'gallery'),
      wiggle: supports(s, 'wiggle'),
      quad: supports(s, 'quad'),
    }).map((item) => item.id);
    expect(ids).toContain('overview');
    expect(ids).toContain('updates');
    for (const hidden of ['gallery', 'wiggle', 'quad', 'roll'] as const) {
      expect(ids).not.toContain(hidden);
    }
  }, 20000);
});
