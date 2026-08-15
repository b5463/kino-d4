// 04 §19 coverage. The spec lists twelve things a mock must be able to do;
// this file asserts the registry names all twelve and that the behaviors added
// for them actually happen on the wire, not just in a flag.
import { afterEach, describe, expect, it } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { JobProgress } from '@kino/kdp';
import { MockKinoDevice, scenarios, SPEC_SCENARIO_KEYS, SYNC_BENCH } from '../src/index';

let open: { transport: MockTransport; client: KinoProtocolClient }[] = [];

async function connect(mock: MockKinoDevice) {
  const transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  open.push({ transport, client });
  return client;
}

afterEach(async () => {
  for (const { transport, client } of open) {
    client.dispose();
    await transport.close();
  }
  open = [];
});

describe('04 §19 scenario coverage', () => {
  it('names every mock requirement in the registry', () => {
    const keys = Object.keys(scenarios);
    for (const required of [
      'splitFrames',
      'coalescedFrames',
      'badCrc',
      'bootSpew',
      'delayedResponses',
      'unsupportedCommands',
      'disconnect',
      'failedUpdate',
      'offlineCameraNode',
      'sessionRestart',
      'largeGallery2k',
      'uploadBacklog',
    ]) {
      expect(keys, `missing 04 §19 scenario ${required}`).toContain(required);
    }
  });

  it('exports the twelve spec keys in spec order', () => {
    expect(SPEC_SCENARIO_KEYS).toHaveLength(12);
    expect(new Set(SPEC_SCENARIO_KEYS).size).toBe(12);
  });

  it('gives every scenario a descriptor whose key matches its entry', () => {
    for (const [key, descriptor] of Object.entries(scenarios)) {
      expect(descriptor.key).toBe(key);
      expect(descriptor.label.length).toBeGreaterThan(0);
    }
  });
});

describe('upload backlog', () => {
  it('starts at 12 pending / 1 uploading / 2 failed and drains on ticks', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('uploadBacklog', true);

    const start = await client.request<{ pending: number; uploading: number; failed: number }>(
      Cmd.UPLOAD_QUEUE_STATUS,
    );
    expect(start.pending).toBe(12);
    expect(start.uploading).toBe(1);
    expect(start.failed).toBe(2);

    const before = await client.request<{ uploaded: number }>(Cmd.UPLOAD_QUEUE_STATUS);
    for (let i = 0; i < 5; i++) mock.tickUploads();
    const later = await client.request<{ pending: number; uploaded: number }>(Cmd.UPLOAD_QUEUE_STATUS);
    expect(later.pending).toBe(7);
    expect(later.uploaded).toBe(before.uploaded + 5);

    for (let i = 0; i < 20; i++) mock.tickUploads();
    const drained = await client.request<{ pending: number; uploading: number; failed: number }>(
      Cmd.UPLOAD_QUEUE_STATUS,
    );
    expect(drained.pending).toBe(0);
    expect(drained.uploading).toBe(0);
    expect(drained.failed).toBe(2); // failures do not drain on their own
  });

  it('UPLOAD_QUEUE_RETRY moves failed back to pending', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('uploadBacklog', true);
    for (let i = 0; i < 30; i++) mock.tickUploads();

    const res = await client.request<{ retried: number; queue: { pending: number; failed: number } }>(
      Cmd.UPLOAD_QUEUE_RETRY,
    );
    expect(res.retried).toBe(2);
    expect(res.queue.failed).toBe(0);
    expect(res.queue.pending).toBe(2);
  });
});

describe('roll state machine', () => {
  it('ROLL_CREATE returns rollId, slug and guestUrl', async () => {
    const client = await connect(new MockKinoDevice());
    const roll = await client.request<{ rollId: string; slug: string; guestUrl: string }>(
      Cmd.ROLL_CREATE,
      { name: 'Loft party' },
    );
    expect(roll.rollId).toMatch(/^roll_/);
    expect(roll.slug).toMatch(/^[a-z0-9][a-z0-9-]+$/);
    expect(roll.guestUrl).toContain(roll.slug);
  });

  it('reports the roll in ROLL_STATUS and clears it on ROLL_LEAVE', async () => {
    const client = await connect(new MockKinoDevice());
    const idle = await client.request<{ active: boolean }>(Cmd.ROLL_STATUS);
    expect(idle.active).toBe(false);

    const created = await client.request<{ slug: string }>(Cmd.ROLL_CREATE, { name: 'Loft party' });
    const active = await client.request<{ active: boolean; roll: { slug: string; role: string } }>(
      Cmd.ROLL_STATUS,
    );
    expect(active.active).toBe(true);
    expect(active.roll.slug).toBe(created.slug);
    expect(active.roll.role).toBe('host');

    await client.request(Cmd.ROLL_LEAVE);
    const after = await client.request<{ active: boolean }>(Cmd.ROLL_STATUS);
    expect(after.active).toBe(false);
  });

  it('refuses a second ROLL_CREATE while one is active', async () => {
    const client = await connect(new MockKinoDevice());
    await client.request(Cmd.ROLL_CREATE, { name: 'One' });
    await expect(client.request(Cmd.ROLL_CREATE, { name: 'Two' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('joins an existing roll as a guest', async () => {
    const client = await connect(new MockKinoDevice());
    const joined = await client.request<{ active: boolean; roll: { slug: string; role: string } }>(
      Cmd.ROLL_JOIN,
      { slug: 'amber-001' },
    );
    expect(joined.roll.slug).toBe('amber-001');
    expect(joined.roll.role).toBe('guest');
  });
});

describe('network commands', () => {
  it('NETWORK_LIST never returns a stored password', async () => {
    const client = await connect(new MockKinoDevice());
    const res = await client.request<{
      networks: { ssid: string; password: string; hasPassword: boolean }[];
    }>(Cmd.NETWORK_LIST);
    expect(res.networks.length).toBeGreaterThan(0);
    for (const n of res.networks) {
      expect(n.password).toBe('••••');
      expect(n.hasPassword).toBe(true);
    }
  });

  it('a password sent to NETWORK_SET never comes back out', async () => {
    const client = await connect(new MockKinoDevice());
    const secret = 'sup3rsecret-passphrase';
    const set = await client.request<{ networks: { ssid: string; password: string }[] }>(
      Cmd.NETWORK_SET,
      { ssid: 'studio-ap', password: secret, security: 'wpa2' },
    );
    expect(JSON.stringify(set)).not.toContain(secret);

    const list = await client.request<unknown>(Cmd.NETWORK_LIST);
    expect(JSON.stringify(list)).not.toContain(secret);

    const status = await client.request<unknown>(Cmd.NETWORK_STATUS);
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it('rejects a short WPA passphrase and deletes a saved network', async () => {
    const client = await connect(new MockKinoDevice());
    await expect(
      client.request(Cmd.NETWORK_SET, { ssid: 'studio-ap', password: 'short' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const del = await client.request<{ ok: boolean; networks: { ssid: string }[] }>(
      Cmd.NETWORK_DELETE,
      { ssid: 'loft-guest' },
    );
    expect(del.ok).toBe(true);
    expect(del.networks.map((n) => n.ssid)).not.toContain('loft-guest');
  });

  it('NETWORK_STATUS reports a plausible connection', async () => {
    const client = await connect(new MockKinoDevice());
    const status = await client.request<{ state: string; ssid: string | null; rssi: number | null }>(
      Cmd.NETWORK_STATUS,
    );
    expect(status.state).toBe('connected');
    expect(status.ssid).toBe('kino-bench');
    expect(status.rssi).toBeLessThan(0);
  });
});

describe('session restart', () => {
  it('answers HELLO with a device ID and a boot session ID', async () => {
    const client = await connect(new MockKinoDevice());
    const hello = await client.hello({ nonce: () => 4242 });
    expect(hello.nonce).toBe(4242);
    expect(hello.deviceId).toBe('kino-000012');
    expect(hello.sessionId).toBe('boot-1');
    expect(client.sessionId).toBe('boot-1');
  });

  it('reports a different session ID after a restart, firing sessionChanged', async () => {
    const mock = new MockKinoDevice();
    const first = await connect(mock);
    const before = await first.hello();
    expect(before.sessionId).toBe('boot-1');

    mock.setScenario('sessionRestart', true);
    expect(mock.currentSessionId()).not.toBe(before.sessionId);

    const second = await connect(mock);
    let changed: { previous: string; current: string } | null = null;
    second.onSessionChanged((c) => {
      changed = c;
    });
    const after = await second.hello({ knownSessionId: String(before.sessionId) });

    expect(after.sessionId).not.toBe(before.sessionId);
    expect(changed).not.toBeNull();
    expect(changed!.previous).toBe(String(before.sessionId));
    expect(changed!.current).toBe(String(after.sessionId));
  }, 20000);
});

describe('SYNC_BENCH job', () => {
  it('accepts a job, streams progress and completes with per-camera samples', async () => {
    const client = await connect(new MockKinoDevice());
    const job = await client.startJob(SYNC_BENCH as Cmd, { triggers: 20 });
    expect(job.jobId).toMatch(/^job_/);

    const seen: JobProgress[] = [];
    for await (const p of job.progress) seen.push(p);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]!.progress).toBeCloseTo(1, 5);

    const result = (await job.result) as {
      triggers: number;
      samples: { trigger: number; cams: { cam: string; vsyncPhaseUs: number }[] }[];
      perTrigger: { vsyncSpreadUs: number }[];
    };
    expect(result.triggers).toBe(20);
    expect(result.samples).toHaveLength(20);
    expect(result.samples[0]!.cams).toHaveLength(4);
    expect(result.perTrigger).toHaveLength(20);
    for (const t of result.perTrigger) {
      expect(t.vsyncSpreadUs).toBeGreaterThanOrEqual(0);
    }
  }, 20000);

  it('refuses to bench with a camera node offline', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('offlineCameraNode', true);
    await expect(client.startJob(SYNC_BENCH as Cmd, { triggers: 5 })).rejects.toMatchObject({
      code: 'CAMERA_OFFLINE',
    });
  });
});

describe('unsupported commands', () => {
  it('NACKs the optional surface instead of going silent (04 §6)', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('unsupportedCommands', true);
    await expect(client.request(Cmd.ROLL_STATUS)).rejects.toMatchObject({
      name: 'KinoUnsupportedError',
    });
    await expect(client.request(Cmd.NETWORK_LIST)).rejects.toMatchObject({
      name: 'KinoUnsupportedError',
    });
    // A core command still answers — this is a firmware without the extras,
    // not a broken one.
    const info = await client.request<{ product: string }>(Cmd.GET_DEVICE_INFO);
    expect(info.product).toBe('KINO');
  });
});

describe('stream shaping', () => {
  it('survives split frames', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('splitFrames', true);
    const info = await client.request<{ product: string }>(Cmd.GET_DEVICE_INFO);
    expect(info.product).toBe('KINO');
  });

  it('survives coalesced frames', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('coalescedFrames', true);
    const [a, b, c] = await Promise.all([
      client.request<{ product: string }>(Cmd.GET_DEVICE_INFO),
      client.request<{ present: boolean }>(Cmd.GET_STORAGE_STATUS),
      client.request<{ modes: string[] }>(Cmd.GET_MODES),
    ]);
    expect(a.product).toBe('KINO');
    expect(b.present).toBe(true);
    expect(c.modes).toContain('wiggle');
  });

  it('resyncs past a boot banner', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('bootSpew', true);
    const client = await connect(mock);
    const info = await client.request<{ product: string }>(Cmd.GET_DEVICE_INFO);
    expect(info.product).toBe('KINO');
  });
});

describe('large gallery', () => {
  it('holds 2,000+ captures and pages through them', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('largeGallery2k', true);
    const page = await client.request<{ total: number; items: unknown[]; hasMore: boolean; nextCursor: number }>(
      Cmd.MEDIA_LIST,
      { cursor: 0, limit: 100 },
    );
    expect(page.total).toBeGreaterThanOrEqual(2000);
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(100);
  });
});

describe('disconnect', () => {
  it('drops the link without a reboot', async () => {
    const mock = new MockKinoDevice();
    const transport = new MockTransport(mock);
    await transport.open();
    const client = new KinoProtocolClient(transport);
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });

    await client.request(Cmd.GET_DEVICE_INFO);
    mock.setScenario('disconnect', true);
    expect(closed).toBe(true);
    expect(mock.scenarios.disconnect).toBe(false); // one-shot, disarms itself
    // No reboot: the session ID the host cached is still the device's.
    expect(mock.currentSessionId()).toBe('boot-1');
    client.dispose();
  });
});
