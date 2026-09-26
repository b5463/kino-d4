// #230: the customer shell's sentences against the real session path and
// the reference device — connected, unplugged, restarting, a protocol the
// two sides do not share — plus the mode word and a real config write with
// its read-back mark.
import { afterEach, describe, expect, it } from 'vitest';
import { MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { applyConfigChecked, connectTransport, disconnect, getDevice } from '../src/app/session';
import { useConnectionStore } from '../src/state/connectionStore';
import { useDeviceStore } from '../src/state/deviceStore';
import { useKnownCameras } from '../src/state/knownCameras';
import { cameraName, connectCopy, statusSentence } from '../src/customer/copy';
import { attentionRows } from '../src/customer/attention';
import { markFor } from '../src/customer/shoot/useSaved';
import { feelForFps, fpsForFeel } from '../src/customer/shoot/useWiggleStep';

describe('the shell against the reference device', () => {
  let sim: MockKinoDevice | null = null;
  const connectSim = async () => {
    sim ??= new MockKinoDevice();
    await connectTransport(() => new MockTransport(sim!), 'mock');
  };

  afterEach(async () => {
    await disconnect();
    sim = null;
  });

  it('recognises the camera by its serial and says nothing while ready', async () => {
    await connectSim();
    const { info, config, storage, cameras, calibration, stats, network, roll } = useDeviceStore.getState();
    expect(useConnectionStore.getState().phase).toBe('connected');
    expect(cameraName(info, config)).toMatch(/^KINO \d{4}$/);
    expect(statusSentence('connected', null)).toBeNull();
    const rows = attentionRows({ storage, cameras, calibration, stats, network, roll, updateVersion: null });
    // A fresh reference device has nothing to say beyond first-photo matching.
    expect(rows.filter((r) => r.id !== 'not-measured')).toEqual([]);
    expect(useKnownCameras.getState().cameras[0]?.serial).toBe(info?.serial);
  });

  it('writes the feel through the real read-back path and marks it Saved', async () => {
    await connectSim();
    const before = useDeviceStore.getState().config!;
    const fps = fpsForFeel('Fast');
    const { config, refused } = await applyConfigChecked({ wiggle: { ...before.wiggle, fps } });
    expect(feelForFps(config.wiggle.fps)).toBe('Fast');
    expect(markFor({ differs: refused.length > 0 })).toBe('Saved');
    // What the camera reports afterwards is what the store holds: the mirror, not the request.
    expect(useDeviceStore.getState().config?.wiggle.fps).toBe(fps);
  });

  it('says KINO was unplugged when the link drops without warning', async () => {
    await connectSim();
    expect(getDevice()).not.toBeNull();
    sim!.setScenario('disconnect', true);
    for (let i = 0; i < 50 && useConnectionStore.getState().phase === 'connected'; i++) await new Promise((r) => setTimeout(r, 100));
    const s = useConnectionStore.getState();
    expect(s.phase).toBe('error');
    expect(connectCopy(s.phase, s.fault, s.error, true, null).sentence).toBe('KINO was unplugged.');
  }, 15000);

  it('refuses a camera that speaks another protocol with the compatibility sentence', async () => {
    sim = new MockKinoDevice();
    sim.setScenario('protocolMismatch', true);
    await connectTransport(() => new MockTransport(sim!), 'mock');
    const s = useConnectionStore.getState();
    expect(s.phase).toBe('error');
    expect(s.fault).toBe('protocol-mismatch');
    const copy = connectCopy(s.phase, s.fault, s.error, true, null);
    expect(copy.sentence).toMatch(/needs (an update|updating) before/);
    expect(copy.sentence).not.toMatch(/protocol/i);
  }, 15000);
});
