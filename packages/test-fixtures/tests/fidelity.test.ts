// Firmware 0.4.55 fidelity on D4-V1 hardware: the reference device answers
// what firmware/p4/main/kdp_server.c answers, on the profiles that pin a real
// build. Everything here was found by an audit of the mock against the C.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type {
  CameraInfo,
  CameraLinkStats,
  CapabilitiesResponse,
  CaptureInfo,
  RuntimeStats,
  SyncBenchResponse,
} from '@kino/kdp';
import { MockKinoDevice, SETTINGS_0_4_9_COMMANDS, FIRMWARE_PROFILES, PROFILE_FOR_VERSION, encodeWav, SOUND_SAMPLE_RATE, DEFAULT_SCENARIOS } from '../src/index';

let open: { transport: MockTransport; client: KinoProtocolClient }[] = [];

async function connect(mock = new MockKinoDevice({ seed: 3, ambientCaptures: false })) {
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  open.push({ transport, client });
  return { mock, client };
}

afterEach(async () => {
  for (const { transport, client } of open) {
    client.dispose();
    await transport.close();
  }
  open = [];
});

function chunk(sessionId: number, offset: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(8 + data.length);
  const view = new DataView(payload.buffer);
  view.setUint32(0, sessionId, true);
  view.setUint32(4, offset, true);
  payload.set(data, 8);
  return payload;
}

async function uploadSound(client: KinoProtocolClient, id: string, data: Uint8Array) {
  const begin = await client.request<{ sessionId: number }>(Cmd.SOUND_BEGIN, {
    id,
    name: id.slice(4),
    sizeBytes: data.length,
    durationMs: 100,
  });
  await client.requestBinary(Cmd.SOUND_CHUNK, chunk(begin.sessionId, 0, data));
  return client.request<{ ok: boolean }>(Cmd.SOUND_END, {});
}

describe('profiles: 0.4.9..0.4.56 answer what the dispatcher answers', () => {
  it('SETTINGS_0_4_9_COMMANDS adds SYNC_BENCH and STORAGE_BENCH to the 0.4.8 surface, and only those', () => {
    const looks = FIRMWARE_PROFILES['d4-looks-0-4-8'].implementedCommands!;
    const settings = FIRMWARE_PROFILES['d4-settings-0-4-9'].implementedCommands!;
    expect(settings).toBe(SETTINGS_0_4_9_COMMANDS);
    expect(settings.filter((c) => !looks.includes(c))).toEqual([Cmd.SYNC_BENCH, Cmd.STORAGE_BENCH]);
    expect(looks).not.toContain(Cmd.SYNC_BENCH);
    expect(looks).not.toContain(Cmd.STORAGE_BENCH);
    expect(PROFILE_FOR_VERSION['0.4.56']).toBe('d4-settings-0-4-9');
  });

  it('no real profile advertises the mock-only syncBench flag', () => {
    for (const p of Object.values(FIRMWARE_PROFILES)) {
      if (p.capabilities) expect(p.capabilities).not.toHaveProperty('syncBench');
    }
  });

  it('the 0.4.8 profile still refuses both, the 0.4.9 profile answers both', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-looks-0-4-8');
    await expect(client.request(Cmd.SYNC_BENCH, { pulses: 2, gapMs: 20 })).rejects.toMatchObject({ name: 'KinoUnsupportedError' });
    await expect(client.request(Cmd.STORAGE_BENCH, { sizeKB: 64 })).rejects.toMatchObject({ name: 'KinoUnsupportedError' });
    mock.setFirmwareProfile('d4-settings-0-4-9');
    const bench = await client.request<SyncBenchResponse>(Cmd.SYNC_BENCH, { pulses: 2, gapMs: 20 });
    expect(bench.ok).toBe(true);
    const storage = await client.request<{ ok: boolean }>(Cmd.STORAGE_BENCH, { sizeKB: 64 }, 30000);
    expect(storage.ok).toBe(true);
  });
});

describe('SYNC_BENCH on a real profile is one blocking RESPONSE of edge counts', () => {
  it('answers SyncBenchResponse with the wired camera watched and the others not', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-settings-0-4-9');
    const r = await client.request<SyncBenchResponse>(Cmd.SYNC_BENCH, { pulses: 10, gapMs: 20 });
    expect(r).toMatchObject({ ok: true, pulses: 10, gapMs: 20, polled: true, refusedByCapture: 0 });
    expect(r.pulseWidthUs).toBeGreaterThan(0);
    expect(r.cameras.map((c) => c.cam)).toEqual(['cam1', 'cam2', 'cam3', 'cam4']);
    const cam1 = r.cameras[0];
    expect(cam1).toMatchObject({
      watched: true,
      inputReady: true,
      acceptedEdges: 10,
      expected: 10,
      shortBy: 0,
      polledMissed: 0,
      polledExtra: 0,
      firstBadPulse: null,
      edgeMonotonic: true,
      clean: true,
    });
    expect(cam1.seqAfter! - cam1.seqBefore!).toBe(10);
    // No all-four-cameras rule: an unwired node is reported, not refused.
    for (const c of r.cameras.slice(1)) expect(c).toEqual({ cam: c.cam, watched: false });
    // No skew figures anywhere in the reply.
    expect(JSON.stringify(r)).not.toMatch(/vsync|exposure|gpioUs|samples|jobId/);
  });

  it('defaults to 100 pulses at 100 ms, ignoring the async form\'s `triggers`', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-settings-0-4-9');
    const r = await client.request<SyncBenchResponse>(Cmd.SYNC_BENCH, { triggers: 5 }, 5000);
    expect(r.pulses).toBe(100);
    expect(r.gapMs).toBe(100);
  });

  it('poll:false drops the polled fields', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-settings-0-4-9');
    const r = await client.request<SyncBenchResponse>(Cmd.SYNC_BENCH, { pulses: 3, gapMs: 20, poll: false });
    expect(r.polled).toBe(false);
    expect(r.cameras[0]).not.toHaveProperty('polledMissed');
    expect(r.cameras[0]).not.toHaveProperty('edgeMonotonic');
    expect(r.cameras[0].clean).toBe(true);
  });

  it('INVALID_ARGUMENT outside 1..200 pulses / 20..1000 ms, BUSY during a capture', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-settings-0-4-9');
    await expect(client.request(Cmd.SYNC_BENCH, { pulses: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.request(Cmd.SYNC_BENCH, { pulses: 201 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.request(Cmd.SYNC_BENCH, { gapMs: 19 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(client.request(Cmd.SYNC_BENCH, { gapMs: 1001 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await client.request(Cmd.CAMERA_CAPTURE, {});
    await expect(client.request(Cmd.SYNC_BENCH, { pulses: 2, gapMs: 20 })).rejects.toMatchObject({ code: 'BUSY' });
  });

  it('the simulated future keeps the async job form', async () => {
    const { mock, client } = await connect();
    expect(mock.getFirmwareProfile()).toBe('d4-sim-full');
    const job = await client.startJob(Cmd.SYNC_BENCH, { triggers: 2 });
    expect(job.jobId).toMatch(/^job_/);
    for await (const _p of job.progress) {
      /* drain */
    }
    const result = (await job.result) as { triggers: number };
    expect(result.triggers).toBe(2);
  }, 20000);
});

describe('GET_CAPABILITIES states the D4-V1 hardware facts', () => {
  it('base object carries the seven D17 flags, flashHardware and powerTelemetry false, no firmwareMismatch', async () => {
    const { client } = await connect();
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities).toMatchObject({
      configStore: true,
      mediaIndex: true,
      powerManagement: true,
      powerTelemetry: false,
      flashHardware: false,
      flashControl: true,
      radioFitted: true,
    });
    expect(caps).not.toHaveProperty('firmwareMismatch');
  });

  it('a real profile reports powerTelemetry false and GET_POWER_STATUS agrees', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-settings-0-4-9');
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.powerTelemetry).toBe(false);
    expect(caps.capabilities.flashHardware).toBe(false);
    const power = await client.request<{ batteryV: number | null; batteryMeasured: boolean; displayStage: string }>(Cmd.GET_POWER_STATUS);
    expect(power).toMatchObject({ batteryV: null, batteryMeasured: false, displayStage: 'awake' });
  });
});

describe('GET_RUNTIME_STATS, GET_CAMERA_INFO and CAMERA_LINK_STATS carry the 0.4.10+/0.4.18+ blocks', () => {
  it('ui liveness, droppedTxFrames, and null die temperature for a node that is not answering', async () => {
    const { mock, client } = await connect();
    mock.setFirmwareProfile('d4-settings-0-4-9'); // one node wired
    const stats = await client.request<RuntimeStats>(Cmd.GET_RUNTIME_STATS);
    expect(stats.ui).toMatchObject({ stalled: false });
    expect(stats.ui!.passes).toBeGreaterThanOrEqual(0);
    expect(stats.ui!.lastPassAgeMs).toBeLessThan(1000);
    expect(stats.protocol.droppedTxFrames).toBe(0);
    expect(stats.protocol.droppedLogEvents).toBe(0);
    expect(typeof stats.tempC.cams[0]).toBe('number');
    expect(stats.tempC.cams.slice(1)).toEqual([null, null, null]);
  });

  it('viewfinder counters count served previews and noLink drops, and the fps reaches the link stats', async () => {
    const { mock, client } = await connect();
    const before = await client.request<CameraInfo>(Cmd.CAMERA_STATUS, { cam: 'cam2' });
    expect(before.viewfinder).toEqual({ frames: 0, fpsX10: 0, drops: { noLink: 0, empty: 0, oversize: 0, shortRead: 0, decode: 0 } });
    for (let i = 0; i < 3; i++) await client.requestBytes(Cmd.CAMERA_PREVIEW, { cam: 'cam2' }, 5000);
    const after = await client.request<CameraInfo>(Cmd.CAMERA_STATUS, { cam: 'cam2' });
    expect(after.viewfinder!.frames).toBe(3);
    expect(after.viewfinder!.fpsX10).toBeGreaterThan(0);
    const link = await client.request<CameraLinkStats>(Cmd.CAMERA_LINK_STATS, { cam: 'cam2' });
    expect(link.viewfinderFpsX10).toBe(after.viewfinder!.fpsX10);
    mock.setCamFault('cam3', 'offline');
    await expect(client.requestBytes(Cmd.CAMERA_PREVIEW, { cam: 'cam3' })).rejects.toThrow();
    const all = await client.request<{ cameras: CameraInfo[] }>(Cmd.GET_CAMERA_INFO);
    expect(all.cameras[2].viewfinder!.drops.noLink).toBe(1);
  });
});

describe('network and Roll answer the firmware shapes', () => {
  it('NETWORK_LIST {scan:true} adds available[], scanMs and scanComplete', async () => {
    const { client } = await connect();
    const plain = await client.request<Record<string, unknown>>(Cmd.NETWORK_LIST, {});
    expect(plain).not.toHaveProperty('available');
    const scanned = await client.request<{ networks: unknown[]; available: { ssid: string; bssid: string; rssi: number; channel: number; security: string; hidden: boolean }[]; scanMs: number; scanComplete: boolean }>(
      Cmd.NETWORK_LIST,
      { scan: true },
      5000,
    );
    expect(scanned.networks).toHaveLength(2);
    expect(scanned.scanComplete).toBe(true);
    expect(scanned.scanMs).toBeGreaterThan(0);
    expect(scanned.available.length).toBeGreaterThan(2);
    for (const a of scanned.available) {
      expect(a).toMatchObject({ bssid: expect.stringMatching(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) });
      expect(typeof a.rssi).toBe('number');
      expect(typeof a.hidden).toBe('boolean');
    }
  });

  it('NETWORK_STATUS {probe:true} adds a timed DNS + healthz probe block', async () => {
    const { mock, client } = await connect();
    const plain = await client.request<Record<string, unknown>>(Cmd.NETWORK_STATUS, {});
    expect(plain).not.toHaveProperty('probe');
    const probed = await client.request<{ probe: Record<string, unknown> }>(Cmd.NETWORK_STATUS, { probe: true }, 5000);
    expect(probed.probe).toMatchObject({ dnsOk: true, family: 'inet', httpStatus: 200, tls: true, base: 'https://kino.acronym.sk', host: 'kino.acronym.sk' });
    expect(probed.probe.totalMs).toBe((probed.probe.dnsMs as number) + (probed.probe.httpMs as number));
    mock.setScenario('rollServerUnreachable', true);
    const down = await client.request<{ probe: Record<string, unknown> }>(Cmd.NETWORK_STATUS, { probe: true }, 5000);
    expect(down.probe).toMatchObject({ dnsOk: false });
    expect(down.probe).not.toHaveProperty('httpStatus');
  });

  it('ROLL_STATUS carries serverState; ROLL_CREATE answers the flat five fields AND the full RollView', async () => {
    const { mock, client } = await connect();
    // 118 uploads since power-on: the server has been asked, so `reachable`.
    const idle = await client.request<{ serverState: string; serverReachable: boolean }>(Cmd.ROLL_STATUS);
    expect(idle).toMatchObject({ serverState: 'reachable', serverReachable: true });
    const created = await client.request<Record<string, unknown>>(Cmd.ROLL_CREATE, { name: 'Loft' });
    expect(created).toMatchObject({ slug: expect.any(String), rollId: expect.any(String), guestUrl: expect.any(String), name: 'Loft', role: 'host' });
    expect(created.active).toBe(true);
    expect(created.roll).toMatchObject({ slug: created.slug, rollId: created.rollId, guestUrl: created.guestUrl, name: 'Loft', role: 'host' });
    expect(created.queue).toBeDefined();
    const on = await client.request<{ serverState: string }>(Cmd.ROLL_STATUS);
    expect(on.serverState).toBe('reachable');
    mock.setScenario('rollServerUnreachable', true);
    expect((await client.request<{ serverState: string; serverReachable: boolean }>(Cmd.ROLL_STATUS))).toMatchObject({ serverState: 'unreachable', serverReachable: false });
    mock.setScenario('wifiLost', true);
    expect((await client.request<{ serverState: string }>(Cmd.ROLL_STATUS)).serverState).toBe('offline');
  });

  it('UPLOAD_QUEUE_STATUS returns all nine fields', async () => {
    const { mock, client } = await connect();
    const q = await client.request<Record<string, unknown>>(Cmd.UPLOAD_QUEUE_STATUS);
    expect(Object.keys(q).sort()).toEqual(
      ['cardPending', 'draining', 'failed', 'halted', 'lastError', 'pending', 'scanComplete', 'uploaded', 'uploading'].sort(),
    );
    expect(q).toMatchObject({ cardPending: 0, scanComplete: true, halted: false, lastError: null });
    mock.setScenario('rollTokenExpired', true);
    const halted = await client.request<{ halted: boolean; lastError: string | null }>(Cmd.UPLOAD_QUEUE_STATUS);
    expect(halted.halted).toBe(true);
    expect(halted.lastError).toMatch(/401/);
  });

  it('SET_CONFIG validates network.apiBase per README D3', async () => {
    const { client } = await connect();
    for (const bad of ['kino.acronym.sk', 'https://kino.acronym.sk/api', 'https://kino.acronym.sk/', 'https://user@host', 'https://host:abc', 'ftp://host', `https://${'h'.repeat(100)}`]) {
      await expect(client.request(Cmd.SET_CONFIG, { config: { network: { apiBase: bad } } }), bad).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    await client.request(Cmd.SET_CONFIG, { config: { network: { apiBase: 'http://192.168.1.20:8080' } } });
    const cfg = await client.request<{ config: { network?: { apiBase?: string } } }>(Cmd.GET_CONFIG);
    expect(cfg.config.network?.apiBase).toBe('http://192.168.1.20:8080');
  });
});

describe('looks, sounds and media', () => {
  it('DELETE_RECIPE of an unknown id is NOT_FOUND', async () => {
    const { client } = await connect();
    await expect(client.request(Cmd.DELETE_RECIPE, { id: 'no-such-look' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('SOUND_END checks the WAV header: 16 kHz mono 16-bit PCM or BAD_FORMAT', async () => {
    const { client } = await connect();
    const good = encodeWav(new Float32Array(320), SOUND_SAMPLE_RATE);
    expect((await uploadSound(client, 'snd-good', good)).ok).toBe(true);
    await expect(uploadSound(client, 'snd-rate', encodeWav(new Float32Array(320), 44100))).rejects.toMatchObject({
      code: 'BAD_FORMAT',
      message: expect.stringMatching(/44100 Hz, need 16000/),
    });
    await expect(uploadSound(client, 'snd-junk', new Uint8Array(256))).rejects.toMatchObject({
      code: 'BAD_FORMAT',
      message: 'not a RIFF/WAVE file',
    });
    // A refused clip is not stored and the session is gone.
    const sounds = await client.request<{ custom: { id: string }[] }>(Cmd.GET_SOUNDS);
    expect(sounds.custom.map((s) => s.id)).toContain('snd-good');
    expect(sounds.custom.map((s) => s.id)).not.toContain('snd-rate');
    await expect(client.request(Cmd.SOUND_END, {})).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  it('MEDIA_INFO omits digests and meta by default; switching the scenario off opts in', async () => {
    expect(DEFAULT_SCENARIOS.mediaInfoAsShipped).toBe(true);
    const { mock, client } = await connect();
    const page = await client.request<{ items: { id: string }[] }>(Cmd.MEDIA_LIST, { cursor: 0, limit: 1 });
    const shipped = await client.request<CaptureInfo>(Cmd.MEDIA_INFO, { id: page.items[0].id });
    for (const f of shipped.files) expect(f).not.toHaveProperty('sha256');
    expect(shipped).not.toHaveProperty('meta');
    mock.setScenario('mediaInfoAsShipped', false);
    const rich = await client.request<CaptureInfo>(Cmd.MEDIA_INFO, { id: page.items[0].id });
    expect(rich.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rich.meta).toBeDefined();
  }, 20000);
});
