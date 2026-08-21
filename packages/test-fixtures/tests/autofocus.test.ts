import { describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { CameraFocus, CameraInfo, Capabilities } from '@kino/kdp';
import { MockKinoDevice } from '../src/MockKinoDevice';
import type { TwinTelemetry } from '../src/telemetry';

async function connect(mock = new MockKinoDevice({ seed: 21, ambientCaptures: false })) {
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  await client.hello({ attempts: 1 });
  return { mock, client, transport };
}

describe('autofocus architecture (audit #55)', () => {
  it('OV3660 firmware has no focus surface: capability absent, CAMERA_FOCUS unsupported', async () => {
    const { client, transport } = await connect();
    try {
      const caps = await client.request<{ capabilities: Capabilities }>(Cmd.GET_CAPABILITIES);
      expect(caps.capabilities.autofocus).toBeFalsy();
      await expect(client.request(Cmd.CAMERA_FOCUS, { action: 'trigger' })).rejects.toThrow(/not supported|autofocus/i);
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('one OV5640_AF module lights the capability and only that camera reports focus', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.setSensorProfile('cam2', 'OV5640_AF');
      const caps = await client.request<{ capabilities: Capabilities }>(Cmd.GET_CAPABILITIES);
      expect(caps.capabilities.autofocus).toBe(true);
      expect(caps.capabilities.manualFocus).toBe(true);

      const info = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
      const cam2 = info.cameras.find((c) => c.id === 'cam2')!;
      const cam1 = info.cameras.find((c) => c.id === 'cam1')!;
      expect(cam2.sensor).toBe('OV5640');
      expect(cam2.focus).toMatchObject({ state: 'idle', vcmPosition: null });
      expect(cam1.sensor).toBe('OV3660');
      expect(cam1.focus).toBeUndefined();
    } finally {
      client.dispose();
      await transport.close();
    }
  });

  it('trigger: searching → locked with a VCM position, and telemetry narrates it', async () => {
    const { mock, client, transport } = await connect();
    const events: TwinTelemetry[] = [];
    mock.onTelemetry((e) => events.push(e));
    try {
      mock.setSensorProfile('cam2', 'OV5640_AF');
      const result = await client.request<{ cams: Record<string, CameraFocus> }>(Cmd.CAMERA_FOCUS, { action: 'trigger' });
      expect(result.cams.cam2).toMatchObject({ state: 'locked', locked: true });
      expect(result.cams.cam2.vcmPosition).toBeGreaterThan(0);
      expect(result.cams.cam2.estimatedDistanceM).toBeGreaterThan(0);

      const af = events.filter((e): e is Extract<TwinTelemetry, { t: 'af' }> => e.t === 'af');
      expect(af.map((e) => e.state)).toEqual(['searching', 'locked']);
    } finally {
      client.dispose();
      await transport.close();
    }
  }, 10000);

  it('af-fail and vcm-stuck shape the outcome; manual set NACKs on a stuck lens', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.setSensorProfile('cam2', 'OV5640_AF');
      mock.setSensorProfile('cam3', 'OV5640_AF');
      mock.setCamFault('cam3', 'af-fail');
      const result = await client.request<{ cams: Record<string, CameraFocus> }>(Cmd.CAMERA_FOCUS, { action: 'trigger' });
      expect(result.cams.cam2.state).toBe('locked');
      expect(result.cams.cam3.state).toBe('failed');

      mock.setCamFault('cam3', 'vcm-stuck');
      await expect(client.request(Cmd.CAMERA_FOCUS, { action: 'set', cam: 'cam3', position: 128 })).rejects.toThrow(/does not move/i);
      const ok = await client.request<{ ok: boolean; position: number }>(Cmd.CAMERA_FOCUS, {
        action: 'set',
        cam: 'cam2',
        position: 300, // clamps to the 0..255 VCM range
      });
      expect(ok.position).toBe(255);
    } finally {
      client.dispose();
      await transport.close();
    }
  }, 10000);

  it('PARTY FIXED uses the stored calibrated position: store-fixed after a lock, then mode party-fixed', async () => {
    const { mock, client, transport } = await connect();
    try {
      mock.setSensorProfile('cam2', 'OV5640_AF');
      // Nothing stored yet — party-fixed leaves the lens idle rather than inventing a position.
      await client.request(Cmd.CAMERA_FOCUS, { action: 'mode', mode: 'party-fixed' });
      let info = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
      expect(info.cameras.find((c) => c.id === 'cam2')!.focus).toMatchObject({ state: 'idle' });
      await expect(client.request(Cmd.CAMERA_FOCUS, { action: 'store-fixed' })).rejects.toThrow(/locked/i);

      await client.request(Cmd.CAMERA_FOCUS, { action: 'trigger' });
      const stored = await client.request<{ stored: string[] }>(Cmd.CAMERA_FOCUS, { action: 'store-fixed' });
      expect(stored.stored).toEqual(['cam2']);

      await client.request(Cmd.CAMERA_FOCUS, { action: 'mode', mode: 'party-fixed' });
      info = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
      const focus = info.cameras.find((c) => c.id === 'cam2')!.focus!;
      expect(focus.state).toBe('locked');
      expect(focus.mode).toBe('party-fixed');
      expect(focus.vcmPosition).toBeGreaterThan(0);
    } finally {
      client.dispose();
      await transport.close();
    }
  }, 10000);
});
