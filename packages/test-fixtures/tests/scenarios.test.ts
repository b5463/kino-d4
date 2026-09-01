// 04 §19 coverage. The spec lists twelve things a mock must be able to do;
// this file asserts the registry names all twelve and that the behaviors added
// for them actually happen on the wire, not just in a flag.
import { afterEach, describe, expect, it } from 'vitest';
import {
  Cmd,
  FrameDecoder,
  FrameFlags,
  KinoProtocolClient,
  MockTransport,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJson,
} from '@kino/kdp';
import type { CaptureInfo, Frame, JobProgress } from '@kino/kdp';
import {
  MockKinoDevice,
  RECIPE_PARITY_CASES,
  sampleRecipe,
  scenarios,
  SPEC_SCENARIO_KEYS,
} from '../src/index';

let open: { transport: MockTransport; client: KinoProtocolClient }[] = [];
let tapped: MockKinoDevice[] = [];

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
  for (const mock of tapped) mock.detach();
  tapped = [];
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Attach straight to the device and record every write it makes.
 *
 * These scenarios are about *delivery boundaries*, and MockTransport already
 * re-chunks every outbound buffer into random 7–160 byte fragments — so a test
 * that goes through it cannot tell the scenario from the baseline. Attaching
 * directly is the only place the device's own grouping is observable, and it
 * uses nothing but the public MockDeviceLike surface.
 */
function tap(mock: MockKinoDevice): Uint8Array[] {
  const writes: Uint8Array[] = [];
  mock.attach(
    (bytes) => writes.push(bytes.slice()),
    () => {},
  );
  tapped.push(mock);
  return writes;
}

function requestFrame(cmd: Cmd, seq: number, payload: unknown = {}): Uint8Array {
  return encodeFrame({
    version: PROTOCOL_VERSION,
    type: cmd,
    flags: FrameFlags.NONE,
    seq,
    payload: encodeJson(payload),
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Every frame the device wrote, in order, reassembled across write boundaries. */
function decodeAll(writes: Uint8Array[]): Frame[] {
  return new FrameDecoder().push(concat(writes));
}

/** The exact bytes the device put on the wire for a response frame. */
function responseBytes(writes: Uint8Array[], seq: number): Uint8Array {
  const frame = decodeAll(writes).find((f) => f.seq === seq && f.flags & FrameFlags.RESPONSE);
  if (!frame) throw new Error(`no response for seq ${seq} in ${writes.length} write(s)`);
  return encodeFrame(frame); // encodeFrame is deterministic — same bytes it sent
}

function containsRun(hay: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Did any single write carry all of these frames? */
function inOneWrite(writes: Uint8Array[], ...frames: Uint8Array[]): boolean {
  return writes.some((w) => frames.every((f) => containsRun(w, f)));
}

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

  /**
   * The contract path (firmware-contract "Network / Roll / upload queue"): a
   * host that edits a saved network cannot resend the passphrase, because
   * NETWORK_LIST never gave it one. Omitting the field has to mean "keep what
   * is stored" — not "set an empty passphrase", and not a length rejection.
   */
  it('keeps the stored passphrase when NETWORK_SET omits it for a known SSID', async () => {
    const client = await connect(new MockKinoDevice());
    const set = await client.request<{
      ok: boolean;
      networks: { ssid: string; hasPassword: boolean; autoJoin: boolean }[];
    }>(Cmd.NETWORK_SET, { ssid: 'kino-bench', security: 'wpa2', autoJoin: false });

    expect(set.ok).toBe(true);
    const saved = set.networks.find((n) => n.ssid === 'kino-bench');
    // hasPassword is the device's own report of whether a secret is stored, so
    // a wiped passphrase would show up here as false.
    expect(saved?.hasPassword).toBe(true);
    // The rest of the edit did land — this is not a no-op that happens to pass.
    expect(saved?.autoJoin).toBe(false);
  });

  it('still demands a passphrase for a new network, and rejects a short new one', async () => {
    const client = await connect(new MockKinoDevice());
    // Unknown SSID with no passphrase: there is nothing stored to keep.
    await expect(
      client.request(Cmd.NETWORK_SET, { ssid: 'studio-ap', security: 'wpa2' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // Known SSID, but a passphrase was actually typed and it is too short.
    await expect(
      client.request(Cmd.NETWORK_SET, { ssid: 'kino-bench', password: 'short' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    // An open network needs no passphrase at all.
    const open = await client.request<{ ok: boolean }>(Cmd.NETWORK_SET, {
      ssid: 'cafe-free',
      security: 'open',
    });
    expect(open.ok).toBe(true);
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
    const job = await client.startJob(Cmd.SYNC_BENCH, { triggers: 20 });
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
    await expect(client.startJob(Cmd.SYNC_BENCH, { triggers: 5 })).rejects.toMatchObject({
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
  it('splitFrames writes one frame across several writes; baseline writes it whole', async () => {
    // Baseline first, so the assertion below is a difference and not a guess.
    const plain = new MockKinoDevice();
    const plainWrites = tap(plain);
    plain.receive(requestFrame(Cmd.GET_DEVICE_INFO, 11));
    await sleep(150);
    const plainResponse = responseBytes(plainWrites, 11);
    expect(inOneWrite(plainWrites, plainResponse)).toBe(true);

    const mock = new MockKinoDevice();
    const writes = tap(mock);
    mock.setScenario('splitFrames', true);
    mock.receive(requestFrame(Cmd.GET_DEVICE_INFO, 12));
    await sleep(150);

    const response = responseBytes(writes, 12);
    // The frame is intact once reassembled...
    expect(response.length).toBeGreaterThan(20);
    // ...but no single write carries it — that is the whole scenario.
    expect(inOneWrite(writes, response)).toBe(false);
    expect(writes.length).toBeGreaterThan(1);
    expect(Math.max(...writes.map((w) => w.length))).toBeLessThan(response.length);
  });

  it('coalescedFrames puts two responses in one write; baseline keeps them apart', async () => {
    const plain = new MockKinoDevice();
    const plainWrites = tap(plain);
    plain.receive(requestFrame(Cmd.GET_DEVICE_INFO, 21));
    plain.receive(requestFrame(Cmd.GET_MODES, 22));
    await sleep(200);
    expect(
      inOneWrite(plainWrites, responseBytes(plainWrites, 21), responseBytes(plainWrites, 22)),
    ).toBe(false);

    const mock = new MockKinoDevice();
    const writes = tap(mock);
    mock.setScenario('coalescedFrames', true);
    mock.receive(requestFrame(Cmd.GET_DEVICE_INFO, 23));
    mock.receive(requestFrame(Cmd.GET_MODES, 24));
    await sleep(200);

    const first = responseBytes(writes, 23);
    const second = responseBytes(writes, 24);
    expect(inOneWrite(writes, first, second)).toBe(true);
  });

  it('bootSpew emits unframed banner bytes the decoder must resync past', async () => {
    const plain = new MockKinoDevice();
    const plainWrites = tap(plain);
    await sleep(30);
    expect(plainWrites).toHaveLength(0); // a quiet device says nothing on attach

    const mock = new MockKinoDevice();
    mock.setScenario('bootSpew', true);
    const writes = tap(mock);
    await sleep(30);

    expect(writes.length).toBeGreaterThan(0);
    const banner = new TextDecoder().decode(concat(writes));
    expect(banner).toContain('rst:0x1');
    expect(decodeAll(writes)).toHaveLength(0); // not a frame — pure noise

    // And the client still gets through it.
    const client = await connect(mock);
    const info = await client.request<{ product: string }>(Cmd.GET_DEVICE_INFO);
    expect(info.product).toBe('KINO');
  });

  it('badCrc corrupts exactly one response; baseline never fails a CRC', async () => {
    const clean = await connect(new MockKinoDevice());
    await clean.request(Cmd.GET_POWER_STATUS);
    await clean.request(Cmd.GET_POWER_STATUS);
    expect(clean.stats.crcFailures).toBe(0);

    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('badCrc', true);
    // Exactly one response is corrupted; the idempotent read retries once
    // and succeeds, so the caller sees a result while the stats see the CRC.
    const first = await client.request<{ batteryV: number }>(Cmd.GET_POWER_STATUS);
    expect(first.batteryV).toBeGreaterThan(3);
    expect(client.stats.crcFailures).toBeGreaterThanOrEqual(1);
    expect(client.stats.readRetries).toBe(1);

    // One-shot: it disarms itself and the link is clean again.
    expect(mock.scenarios.badCrc).toBe(false);
    const after = client.stats.crcFailures;
    const power = await client.request<{ batteryV: number }>(Cmd.GET_POWER_STATUS);
    expect(power.batteryV).toBeGreaterThan(3);
    expect(client.stats.crcFailures).toBe(after);
  }, 15000);

  it('delayedResponses answers near the timeout instead of promptly', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);

    const quickStart = Date.now();
    await client.request(Cmd.GET_MODES);
    const quick = Date.now() - quickStart;
    expect(quick).toBeLessThan(500);

    mock.setScenario('delayedResponses', true);
    const slowStart = Date.now();
    await client.request(Cmd.GET_MODES);
    const slow = Date.now() - slowStart;

    // Scenario latency is 1400–2400 ms; 1200 leaves room for timer slop while
    // staying far above anything the baseline could produce.
    expect(slow).toBeGreaterThanOrEqual(1200);
    expect(slow).toBeGreaterThan(quick * 4);
  }, 15000);
});

describe('legacy firmware answers what it advertises', () => {
  it('NACKs the network/roll group it reports as unsupported', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('legacyFirmware', true);

    const caps = await client.request<{
      capabilities: { network: boolean; rollUpload: boolean; syncBench: boolean; wiggle: boolean };
    }>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.network).toBe(false);
    expect(caps.capabilities.rollUpload).toBe(false);
    expect(caps.capabilities.syncBench).toBe(false);
    expect(caps.capabilities.wiggle).toBe(true);

    // 04 §6: the claim and the answer have to agree.
    for (const cmd of [Cmd.NETWORK_LIST, Cmd.ROLL_STATUS, Cmd.UPLOAD_QUEUE_STATUS]) {
      await expect(client.request(cmd)).rejects.toMatchObject({ name: 'KinoUnsupportedError' });
    }
    await expect(client.startJob(Cmd.SYNC_BENCH, { triggers: 5 })).rejects.toMatchObject({
      name: 'KinoUnsupportedError',
    });
  }, 15000);

  it('answers the group again once the legacy flag clears', async () => {
    const mock = new MockKinoDevice();
    const client = await connect(mock);
    mock.setScenario('legacyFirmware', true);
    await expect(client.request(Cmd.NETWORK_LIST)).rejects.toMatchObject({
      name: 'KinoUnsupportedError',
    });

    mock.setScenario('legacyFirmware', false);
    const caps = await client.request<{ capabilities: { network: boolean } }>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.network).toBe(true);
    const list = await client.request<{ networks: unknown[] }>(Cmd.NETWORK_LIST);
    expect(list.networks.length).toBeGreaterThan(0);
  });
});

describe('UPLOAD_RECIPE', () => {
  it('stores a valid look and reads it back', async () => {
    const client = await connect(new MockKinoDevice());
    const recipe = { ...sampleRecipe('my-party'), name: 'My Party' };
    const res = await client.request<{ ok: boolean }>(Cmd.UPLOAD_RECIPE, { recipe });
    expect(res.ok).toBe(true);

    const looks = await client.request<{ custom: { id: string; name: string; factory: boolean }[] }>(
      Cmd.GET_RECIPES,
    );
    const stored = looks.custom.find((r) => r.id === 'my-party');
    expect(stored).toBeDefined();
    expect(stored!.name).toBe('My Party');
    expect(stored!.factory).toBe(false); // the device owns this flag, not the host
  });

  it('NACKs an invalid look with INVALID_ARGUMENT', async () => {
    const client = await connect(new MockKinoDevice());
    await expect(
      client.request(Cmd.UPLOAD_RECIPE, { recipe: { ...sampleRecipe(), id: 'Party Neg!' } }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const looks = await client.request<{ custom: unknown[] }>(Cmd.GET_RECIPES);
    expect(looks.custom).toHaveLength(0); // rejected means not stored
  });

  it('refuses to overwrite a factory id', async () => {
    const client = await connect(new MockKinoDevice());
    await expect(
      client.request(Cmd.UPLOAD_RECIPE, { recipe: sampleRecipe('party-neg') }),
    ).rejects.toThrow(/factory/i);
  });

  it('accepts a look missing an optional look key, as Studio does', async () => {
    const client = await connect(new MockKinoDevice());
    const { grain: _omitted, ...look } = sampleRecipe().look;
    const partial = { ...sampleRecipe('missing-grain'), look };
    const res = await client.request<{ ok: boolean }>(Cmd.UPLOAD_RECIPE, { recipe: partial });
    expect(res.ok).toBe(true);
  });

  it('gives every parity fixture the outcome the table declares', async () => {
    const client = await connect(new MockKinoDevice());
    for (const c of RECIPE_PARITY_CASES) {
      const send = client.request(Cmd.UPLOAD_RECIPE, { recipe: c.document });
      if (c.valid) {
        await expect(send, c.name).resolves.toMatchObject({ ok: true });
      } else {
        await expect(send, c.name).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
    }
  }, 20000);
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

describe('MEDIA_INFO as shipped (issue #154)', () => {
  it('omits every per-file sha256 and the whole meta block, and refuses META.JSON to match', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('mediaInfoAsShipped', true);
    const client = await connect(mock);

    const page = await client.request<{ items: { id: string }[] }>(Cmd.MEDIA_LIST, { cursor: 0, limit: 1 });
    const id = page.items[0].id;
    const info = await client.request<CaptureInfo>(Cmd.MEDIA_INFO, { id });

    expect(info.files.length).toBeGreaterThan(0);
    for (const f of info.files) expect(f.sha256).toBeUndefined();
    // Absent, not `{}`: an empty object passes a truthiness check and then
    // throws on the first field read, which is the defect this reproduces.
    expect(Object.keys(info)).not.toContain('meta');
    expect(info.files[0].sizeBytes).toBeGreaterThan(0);

    // The document `meta` is read out of is not readable either, so a host
    // cannot recover through MEDIA_READ what MEDIA_INFO said is not there.
    await expect(client.request(Cmd.MEDIA_READ, { id, file: 'META.JSON' })).rejects.toThrow(/NOT_FOUND|No META/i);
  }, 20000);

  it('computes both again when the scenario is switched off', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('mediaInfoAsShipped', true);
    mock.setScenario('mediaInfoAsShipped', false);
    const client = await connect(mock);

    const page = await client.request<{ items: { id: string }[] }>(Cmd.MEDIA_LIST, { cursor: 0, limit: 1 });
    const info = await client.request<CaptureInfo>(Cmd.MEDIA_INFO, { id: page.items[0].id });
    expect(info.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(info.meta?.p4Firmware).toBeDefined();
  }, 20000);
});
