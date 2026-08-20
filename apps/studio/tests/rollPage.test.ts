// Roll page (02 §17) — device-side behaviour against the reference device.
//
// Everything that touches the camera runs over the real protocol stack
// (MockTransport → KinoProtocolClient → MockKinoDevice) so the payload shapes
// asserted here are the ones firmware will have to answer. Rendering goes
// through `react-dom/server`, which needs no DOM: the panels take their data
// as props exactly so a static render can assert what they print.
//
// The Wi-Fi password test is the 05 §13 guarantee and is written as a
// containment check: the passphrase must reach NETWORK_SET and nothing else —
// not the log store, not the console, not any RollServerClient call.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cmd, Evt, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { LogEntry } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';

import { KinoDevice } from '../src/device/KinoDevice';
import {
  DEFAULT_ROLL_SERVER_URL,
  SERVER_NOT_CONFIGURED,
  StubRollServerClient,
} from '../src/roll/RollServerClient';
import type { RollServerClient } from '../src/roll/RollServerClient';
import { startRoll, submitNetwork } from '../src/roll/rollOps';
import { NetworkPanel } from '../src/pages/Roll/NetworkPanel';
import { RollPanel, GuestQr } from '../src/pages/Roll/RollPanel';
import { UploadQueuePanel } from '../src/pages/Roll/UploadQueuePanel';
import { PushToRoll } from '../src/pages/Gallery/PushToRoll';
import type { RollView } from '../src/roll/rollTypes';
import { navItems } from '../src/components/Sidebar';
import { setDeviceState, clearDeviceState, supportsRollUpload, useDeviceStore } from '../src/state/deviceStore';
import { appendLog, clearLogs, useLogStore } from '../src/state/logStore';
import { putRollLinks, resetRollLinks, rollLinksFor } from '../src/state/rollLinks';
import type { RollLinkView } from '../src/state/rollLinks';

/** A passphrase distinctive enough that a substring search cannot miss it. */
const SECRET = 'ZzTopSecret-9917';

let transport: MockTransport | null = null;

/**
 * The stack a connected Studio has: a device facade over a live client, with
 * device LOG events fed into the log store exactly the way `session.ts` wires
 * them. Without that wiring the log-store assertion would prove nothing.
 */
async function connectMock(mock = new MockKinoDevice()) {
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  client.onEvent<LogEntry>(Evt.LOG, (entry) => appendLog(entry));
  const sent: { cmd: number; payload: unknown }[] = [];
  const order: string[] = [];
  const request = client.request.bind(client);
  vi.spyOn(client, 'request').mockImplementation((cmd, payload, timeoutMs) => {
    sent.push({ cmd, payload });
    order.push(Cmd[cmd] ?? `0x${cmd.toString(16)}`);
    return request(cmd, payload, timeoutMs);
  });
  return { mock, client, device: new KinoDevice(client), sent, order };
}

/**
 * Every RollServerClient call this test made, with its arguments. `trace` is
 * the same array the KDP commands are recorded into, so server calls and
 * device commands interleave in one ordered sequence.
 */
function recordingServer(
  calls: { method: string; args: unknown[] }[],
  trace: string[] = [],
): RollServerClient {
  return {
    baseUrl: DEFAULT_ROLL_SERVER_URL,
    async testConnection() {
      calls.push({ method: 'testConnection', args: [] });
      trace.push('server:testConnection');
      return { ok: true, latencyMs: 31 };
    },
    async registerDevice(serial, product, hardwareRevision) {
      calls.push({ method: 'registerDevice', args: [serial, product, hardwareRevision] });
      trace.push('server:registerDevice');
      return { deviceId: 'dev_0001', deviceToken: 'tok_live_0001' };
    },
    async createRoll(opts) {
      calls.push({ method: 'createRoll', args: [opts] });
      trace.push('server:createRoll');
      return {
        rollId: 'roll_srv_0001',
        slug: '7f3k9q',
        guestUrl: 'https://kino.acronym.sk/r/7F3K9Q',
        hostUrl: 'https://kino.acronym.sk/host/roll_srv_0001',
      };
    },
  };
}

beforeEach(() => {
  clearLogs();
  clearDeviceState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await transport?.close();
  transport = null;
  clearLogs();
  clearDeviceState();
});

describe('(a) Wi-Fi provisioning keeps the passphrase on the camera (05 §13)', () => {
  it('sends NETWORK_SET {ssid, password} and leaks the password nowhere else', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const serverCalls: { method: string; args: unknown[] }[] = [];
    const server = recordingServer(serverCalls);

    const { device, sent } = await connectMock();

    const networks = await submitNetwork(device, {
      ssid: 'loft-5g',
      password: SECRET,
      security: 'wpa2',
      autoJoin: true,
    });

    // 1. It really went to the device, as NETWORK_SET, with the passphrase.
    const setCalls = sent.filter((c) => c.cmd === Cmd.NETWORK_SET);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].payload).toMatchObject({ ssid: 'loft-5g', password: SECRET });

    // 2. What comes back is masked — the camera never hands it out again.
    const saved = networks.find((n) => n.ssid === 'loft-5g');
    expect(saved).toBeDefined();
    expect(saved!.password).toBe('••••');
    expect(saved!.hasPassword).toBe(true);
    expect(JSON.stringify(networks)).not.toContain(SECRET);

    // 3. Not in the log store, which did receive the device's LOG event.
    const entries = useLogStore.getState().entries;
    expect(entries.some((e) => e.msg.includes('loft-5g'))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(SECRET);

    // 4. Not on the console.
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
    }

    // 5. Not in anything sent to the Roll server — including a roll created
    //    while the credential is live in the same session.
    await startRoll(device, server, { title: 'Friday party', downloadsEnabled: true });
    expect(serverCalls.map((c) => c.method)).toContain('createRoll');
    expect(JSON.stringify(serverCalls)).not.toContain(SECRET);

    // 6. Not in what the panel renders.
    const html = renderToStaticMarkup(
      createElement(NetworkPanel, { networks, status: null, busy: false, error: null, onSave: async () => {}, onForget: async () => {} }),
    );
    expect(html).not.toContain(SECRET);
  });

  /**
   * The form advertises "leave empty to keep the passphrase already stored on
   * the camera" for a known SSID. Studio can only honour that by omitting the
   * field — it never had the secret to send back — so the round trip has to
   * succeed without one.
   */
  it('edits a known network without retyping the passphrase', async () => {
    const { device, sent } = await connectMock();
    const before = (await device.networkList()).networks.find((n) => n.ssid === 'kino-bench');
    expect(before?.hasPassword).toBe(true);

    const networks = await submitNetwork(device, {
      ssid: 'kino-bench',
      password: '',
      security: 'wpa2',
      autoJoin: false,
    });

    // Nothing that could be mistaken for a passphrase went out.
    const setCall = sent.find((c) => c.cmd === Cmd.NETWORK_SET);
    expect(setCall?.payload).not.toHaveProperty('password');

    const after = networks.find((n) => n.ssid === 'kino-bench');
    expect(after?.hasPassword).toBe(true);
    expect(after?.autoJoin).toBe(false);
  });

  it('uses a password input so the passphrase is never shown or autofilled into view', () => {
    const html = renderToStaticMarkup(
      createElement(NetworkPanel, { networks: [], status: null, busy: false, error: null, onSave: async () => {}, onForget: async () => {} }),
    );
    expect(html).toContain('type="password"');
  });
});

describe('(b) saved networks render from NETWORK_LIST with masked passwords', () => {
  it('lists what the device reports and prints the mask, never a secret', async () => {
    const { device } = await connectMock();
    const { networks } = await device.networkList();
    const status = await device.networkStatus();

    expect(networks.map((n) => n.ssid)).toEqual(['kino-bench', 'loft-guest']);
    expect(networks.every((n) => n.password === '••••')).toBe(true);

    const html = renderToStaticMarkup(
      createElement(NetworkPanel, { networks, status, busy: false, error: null, onSave: async () => {}, onForget: async () => {} }),
    );
    expect(html).toContain('kino-bench');
    expect(html).toContain('loft-guest');
    expect(html).toContain('••••');
    // The lamp is symbol + text, never colour alone.
    expect(html).toContain('WIFI CONNECTED');
    expect(html).toContain('kino-bench');
  });
});

describe('(c) Start a Roll — server first, then the device', () => {
  it('creates the roll on the server before ROLL_CREATE reaches the camera', async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const { device, order } = await connectMock();
    const server = recordingServer(calls, order);

    const started = await startRoll(device, server, {
      title: 'Friday party',
      pin: '4417',
      downloadsEnabled: true,
    });

    // Server first: the device is only told about a roll that exists.
    expect(calls.map((c) => c.method)).toEqual(['createRoll']);
    expect(calls[0].args[0]).toMatchObject({ title: 'Friday party', pin: '4417', downloadsEnabled: true });
    expect(order.filter((o) => o === 'server:createRoll' || o === 'ROLL_CREATE')).toEqual([
      'server:createRoll',
      'ROLL_CREATE',
    ]);

    // The public URLs come from the server, which owns the slug (05 §14).
    expect(started.guestUrl).toBe('https://kino.acronym.sk/r/7F3K9Q');
    expect(started.hostUrl).toBe('https://kino.acronym.sk/host/roll_srv_0001');

    // And the camera really is on a roll now.
    const view = await device.rollStatus();
    expect(view.active).toBe(true);
    expect(view.roll?.role).toBe('host');
  });

  it('renders the guest QR and the guest URL for the active roll', async () => {
    const server = recordingServer([]);
    const { device } = await connectMock();
    const started = await startRoll(device, server, { title: 'Friday party', downloadsEnabled: true });
    const view = await device.rollStatus();

    const qr = renderToStaticMarkup(createElement(GuestQr, { url: started.guestUrl }));
    expect(qr).toContain('<canvas');
    expect(qr).toContain(started.guestUrl);

    const html = renderToStaticMarkup(
      createElement(RollPanel, {
        view,
        guestUrl: started.guestUrl,
        hostUrl: started.hostUrl,
        origin: 'server' as const,
        busy: false,
        error: null,
        onStart: async () => {},
        onJoin: async () => {},
        onLeave: async () => {},
      }),
    );
    expect(html).toContain('Leave Roll');
    expect(html).toContain('OPEN HOST DASHBOARD');
    expect(html).toContain(started.hostUrl!);
    expect(html).toContain('<canvas');
  });

  it('offers Start a Roll and Join a Roll when the camera is not on one', async () => {
    const { device } = await connectMock();
    const view = await device.rollStatus();
    expect(view.active).toBe(false);

    const html = renderToStaticMarkup(
      createElement(RollPanel, {
        view,
        guestUrl: null,
        hostUrl: null,
        origin: 'unknown' as const,
        busy: false,
        error: null,
        onStart: async () => {},
        onJoin: async () => {},
        onLeave: async () => {},
      }),
    );
    expect(html).toContain('Start a Roll');
    expect(html).toContain('Join a Roll');
    expect(html).not.toContain('Leave Roll');
  });

  it('refuses to touch the device when the server is not configured', async () => {
    const { device, order } = await connectMock();
    await expect(
      startRoll(device, new StubRollServerClient(), { title: 'Friday party', downloadsEnabled: true }),
    ).rejects.toThrow(SERVER_NOT_CONFIGURED);

    expect(order).not.toContain('ROLL_CREATE');
    expect((await device.rollStatus()).active).toBe(false);
  });

  it('falls back to a device-only roll in demo mode, with no host dashboard', async () => {
    const { device } = await connectMock();
    const started = await startRoll(
      device,
      new StubRollServerClient(),
      { title: 'Friday party', downloadsEnabled: true },
      { allowDeviceOnly: true },
    );

    expect(started.guestUrl).toMatch(/^https:\/\/kino\.roll\//);
    expect(started.hostUrl).toBeNull();
    expect(started.deviceOnly).toBe(true);
    expect((await device.rollStatus()).active).toBe(true);
  });
});

/**
 * The panel is unmounted by any sidebar click. Everything the camera reports
 * survives that on its own; the host dashboard address does not, because the
 * camera never had it. These are the assertions that a page swap does not turn
 * a published Roll into a "camera only" one.
 */
describe('published Roll links survive an unmount', () => {
  afterEach(() => resetRollLinks());

  /** What RollPage does on mount: derive the links from ROLL_STATUS alone. */
  const remount = async (device: KinoDevice) => rollLinksFor(await device.rollStatus());

  const renderPanel = (view: Awaited<ReturnType<KinoDevice['rollStatus']>>, links: RollLinkView) =>
    renderToStaticMarkup(
      createElement(RollPanel, {
        view,
        guestUrl: links.guestUrl,
        hostUrl: links.hostUrl,
        origin: links.origin,
        busy: false,
        error: null,
        onStart: async () => {},
        onJoin: async () => {},
        onLeave: async () => {},
      }),
    );

  it('still offers the host dashboard after the page was left and reopened', async () => {
    const { device } = await connectMock();
    const started = await startRoll(device, recordingServer([]), {
      title: 'Friday party',
      downloadsEnabled: true,
    });
    // What RollPage stores once the create returns.
    putRollLinks(started.deviceRollId, {
      guestUrl: started.guestUrl,
      hostUrl: started.hostUrl,
      origin: 'server',
    });

    // ---- unmount: every piece of component state is gone ----

    const links = await remount(device);
    expect(links.origin).toBe('server');
    expect(links.hostUrl).toBe('https://kino.acronym.sk/host/roll_srv_0001');
    expect(links.guestUrl).toBe('https://kino.acronym.sk/r/7F3K9Q');

    const html = renderPanel(await device.rollStatus(), links);
    expect(html).toContain('OPEN HOST DASHBOARD');
    expect(html).not.toContain('camera only');
  });

  it('keeps calling a device-only Roll device-only after a remount', async () => {
    const { device } = await connectMock();
    const started = await startRoll(
      device,
      new StubRollServerClient(),
      { title: 'Friday party', downloadsEnabled: true },
      { allowDeviceOnly: true },
    );
    putRollLinks(started.deviceRollId, {
      guestUrl: started.guestUrl,
      hostUrl: null,
      origin: 'device-only',
    });

    const links = await remount(device);
    expect(links.origin).toBe('device-only');

    const html = renderPanel(await device.rollStatus(), links);
    expect(html).toContain('No host dashboard — this Roll exists on the camera only.');
  });

  it('claims nothing about a Roll this session did not create', async () => {
    const { device } = await connectMock();
    // A Roll joined here, or created before Studio was reloaded: the camera is
    // on it, and this session has no idea whether a server published it.
    await device.rollJoin('amber-001');

    const links = await remount(device);
    expect(links.origin).toBe('unknown');
    expect(links.hostUrl).toBeNull();
    // The camera's own guest URL is real, so the QR is still shown.
    expect(links.guestUrl).toBe('https://kino.roll/amber-001');

    const html = renderPanel(await device.rollStatus(), links);
    expect(html).toContain('Host link not available in this session.');
    expect(html).not.toContain('camera only');
    expect(html).toContain('<canvas');
  });
});

describe('(d) upload queue', () => {
  it('renders UPLOAD_QUEUE_STATUS counts and requeues failures on retry', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('uploadBacklog', true);
    const { device, sent } = await connectMock(mock);

    const queue = await device.uploadQueueStatus();
    expect(queue).toMatchObject({ pending: 12, uploading: 1, failed: 2 });

    const html = renderToStaticMarkup(
      createElement(UploadQueuePanel, { queue, busy: false, error: null, onRetry: async () => {} }),
    );
    expect(html).toContain('12 PENDING');
    expect(html).toContain('2 FAILED');
    expect(html).toContain('RETRY FAILED');

    const retried = await device.uploadQueueRetry();
    expect(sent.some((c) => c.cmd === Cmd.UPLOAD_QUEUE_RETRY)).toBe(true);
    expect(retried.retried).toBe(2);
    expect(retried.queue.failed).toBe(0);
    expect(retried.queue.pending).toBe(14);
  });

  it('reflects the backlog draining on the next read', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('uploadBacklog', true);
    const { device } = await connectMock(mock);

    const before = await device.uploadQueueStatus();
    mock.tickUploads();
    mock.tickUploads();
    const after = await device.uploadQueueStatus();

    expect(after.pending).toBeLessThan(before.pending);
    expect(after.uploaded).toBeGreaterThan(before.uploaded);
  });

  it('says the queue is empty rather than printing four zeroes', () => {
    const html = renderToStaticMarkup(
      createElement(UploadQueuePanel, {
        queue: { pending: 0, uploading: 0, failed: 0, uploaded: 118, draining: false },
        busy: false,
        error: null,
        onRetry: async () => {},
      }),
    );
    expect(html).toContain('NOTHING QUEUED');
  });
});

/**
 * Push to Roll (02 §16). The action only exists when there is somewhere for
 * the capture to go: an active Roll on a camera whose firmware advertises
 * `rollUpload`. Everything else is a button that enqueues into nothing.
 */
describe('(f) push to Roll', () => {
  /**
   * Exactly what CaptureInspector passes: the capability off the device store
   * and ROLL_STATUS as the gallery last read it.
   */
  const renderPush = (roll: RollView | null, rollUpload = supportsRollUpload(useDeviceStore.getState())) =>
    renderToStaticMarkup(
      createElement(PushToRoll, { captureId: 'CAP_0042', rollUpload, roll, onPush: async () => {} }),
    );

  const withCaps = async (mock?: MockKinoDevice) => {
    const ctx = await connectMock(mock);
    const caps = await ctx.device.getCapabilities();
    setDeviceState({ capabilities: caps.capabilities });
    return ctx;
  };

  /** A Roll the camera is on — the only state that unlocks the action. */
  const ACTIVE_ROLL: RollView = {
    active: true,
    roll: {
      rollId: 'roll_0001',
      slug: 'amber-001',
      guestUrl: 'https://kino.roll/amber-001',
      name: 'Friday party',
      role: 'host',
      joinedAt: 1755301234567,
    },
    queue: { pending: 0, uploading: 0, failed: 0, uploaded: 0, draining: false },
  };

  it('is not offered while the camera is not on a Roll', async () => {
    const { device } = await withCaps();
    const view = await device.rollStatus();
    expect(view.active).toBe(false);
    expect(renderPush(view)).toBe('');
    // Nor before ROLL_STATUS has been read at all.
    expect(renderPush(null)).toBe('');
  });

  it('is not offered on firmware that cannot upload, Roll or no Roll', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('legacyFirmware', true);
    await withCaps(mock);
    expect(supportsRollUpload(useDeviceStore.getState())).toBe(false);

    // A camera that cannot upload cannot be on a Roll either, so this is the
    // synthetic worst case: capability off, view claiming a Roll.
    expect(renderPush(ACTIVE_ROLL)).toBe('');
  });

  it('offers PUSH TO ROLL once the camera is on one, naming the Roll', async () => {
    const { device } = await withCaps();
    await startRoll(device, recordingServer([]), { title: 'Friday party', downloadsEnabled: true });
    const view = await device.rollStatus();
    expect(view.active).toBe(true);
    expect(supportsRollUpload(useDeviceStore.getState())).toBe(true);

    const html = renderPush(view);
    expect(html).toContain('PUSH TO ROLL');
    expect(html).toContain('Friday party');
  });

  it('sends UPLOAD_ENQUEUE and the Roll page prints the longer queue', async () => {
    const { device, sent } = await withCaps();
    await startRoll(device, recordingServer([]), { title: 'Friday party', downloadsEnabled: true });

    const before = await device.uploadQueueStatus();
    expect(before.pending).toBe(0);

    const list = await device.mediaList({ limit: 1 });
    const capture = list.items[0];
    const res = await device.uploadEnqueue(capture.id);

    const enqueued = sent.filter((c) => c.cmd === Cmd.UPLOAD_ENQUEUE);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].payload).toEqual({ captureId: capture.id });
    expect(res.queue.pending).toBe(before.pending + 1);

    const queue = await device.uploadQueueStatus();
    expect(queue.pending).toBe(before.pending + 1);

    const html = renderToStaticMarkup(
      createElement(UploadQueuePanel, { queue, busy: false, error: null, onRetry: async () => {} }),
    );
    expect(html).toContain('1 PENDING');
    expect(html).not.toContain('NOTHING QUEUED');
  });

  it('NACKs UPLOAD_ENQUEUE when the camera is not on a Roll', async () => {
    const { device } = await withCaps();
    expect((await device.rollStatus()).active).toBe(false);
    await expect(device.uploadEnqueue('CAP_0001')).rejects.toThrow(/not on a roll/i);
    expect((await device.uploadQueueStatus()).pending).toBe(0);
  });

  it('NACKs UPLOAD_ENQUEUE on firmware without rollUpload', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('legacyFirmware', true);
    const { device } = await connectMock(mock);
    await expect(device.uploadEnqueue('CAP_0001')).rejects.toThrow(/not implemented/i);
  });

  it('NACKs a blank capture id rather than queueing nothing', async () => {
    const { device } = await withCaps();
    await startRoll(device, recordingServer([]), { title: 'Friday party', downloadsEnabled: true });
    await expect(device.uploadEnqueue('')).rejects.toThrow(/capture/i);
  });
});

describe('(e) capability gating (02 §27)', () => {
  it('drops the Roll entry from the nav when the firmware cannot upload', async () => {
    const mock = new MockKinoDevice();
    mock.setScenario('legacyFirmware', true);
    const { device } = await connectMock(mock);

    const caps = await device.getCapabilities();
    setDeviceState({ capabilities: caps.capabilities });
    expect(supportsRollUpload(useDeviceStore.getState())).toBe(false);

    const ids = navItems({ developerMode: false, rollUpload: false }).map((i) => i.id);
    expect(ids).not.toContain('roll');
  });

  it('places Roll between Gallery and Device when the firmware supports it (02 §3)', async () => {
    const { device } = await connectMock();
    const caps = await device.getCapabilities();
    setDeviceState({ capabilities: caps.capabilities });
    expect(supportsRollUpload(useDeviceStore.getState())).toBe(true);

    const ids = navItems({ developerMode: false, rollUpload: true }).map((i) => i.id);
    expect(ids).toEqual([
      'overview',
      'shoot',
      'wiggle',
      'quad',
      'looks',
      'calibration',
      'gallery',
      'roll',
      'device',
      'updates',
    ]);
  });
});
