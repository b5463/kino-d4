// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { KinoDevice } from '../src/device/KinoDevice';
import { HttpRollServerClient } from '../src/roll/HttpRollServerClient';
import { registerRollDevice, startRoll } from '../src/roll/rollOps';

const SERVER = 'https://roll.example.test';
const TOKEN = 'kdt_one-time-secret';
const DEVICE_ID = 'dev_registered';

let transport: MockTransport | null = null;

async function camera() {
  transport = new MockTransport(new MockKinoDevice());
  await transport.open();
  const protocol = new KinoProtocolClient(transport);
  const sent: { cmd: number; payload: unknown }[] = [];
  const request = protocol.request.bind(protocol);
  vi.spyOn(protocol, 'request').mockImplementation((cmd, payload, timeoutMs) => {
    sent.push({ cmd, payload });
    return request(cmd, payload, timeoutMs);
  });
  return { device: new KinoDevice(protocol), sent };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await transport?.close();
  transport = null;
  localStorage.clear();
  sessionStorage.clear();
});

describe('HttpRollServerClient', () => {
  it('uses the Studio registration route, then authenticates device Roll creation', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ deviceId: DEVICE_ID, deviceToken: TOKEN }))
      .mockResolvedValueOnce(
        json({
          rollId: 'roll_server',
          slug: 'ABC234',
          guestUrl: `${SERVER}/r/ABC234`,
          hostUrl: `${SERVER}/host#token=hrt_host-secret`,
        }, 201),
      );
    const client = new HttpRollServerClient(`${SERVER}/`);

    await client.registerDevice('KINO000012', 'KINO', 'V1');
    const created = await client.createRoll({ title: 'Party', downloadsEnabled: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${SERVER}/api/studio/devices/register`);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      serial: 'KINO000012',
      product: 'KINO',
      hardwareRevision: 'V1',
    });
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(created.hostUrl).toContain('#token=hrt_');
  });

  it('passes the one-time token directly into SET_CONFIG and never browser storage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ deviceId: DEVICE_ID, deviceToken: TOKEN }));
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const client = new HttpRollServerClient(SERVER);
    const mock = new MockKinoDevice();
    transport = new MockTransport(mock);
    await transport.open();
    const protocol = new KinoProtocolClient(transport);
    const sent: { cmd: number; payload: unknown }[] = [];
    const request = protocol.request.bind(protocol);
    vi.spyOn(protocol, 'request').mockImplementation((cmd, payload, timeoutMs) => {
      sent.push({ cmd, payload });
      return request(cmd, payload, timeoutMs);
    });
    const device = new KinoDevice(protocol);
    const info = await device.getDeviceInfo();

    await registerRollDevice(device, client, {
      serial: info.serial,
      product: info.product,
      hardwareRevision: info.hardware,
    });

    const setConfig = sent.find((call) => call.cmd === Cmd.SET_CONFIG);
    expect(setConfig?.payload).toMatchObject({
      config: {
        roll: { credentials: { deviceId: DEVICE_ID, deviceToken: TOKEN, serverUrl: SERVER } },
      },
    });
    expect(sent.some((call) => call.cmd === Cmd.SAVE_CONFIG)).toBe(true);
    const returnedCredentials = (await device.getConfig()).config.roll?.credentials;
    expect(returnedCredentials).toEqual({
      deviceId: DEVICE_ID,
      serverUrl: SERVER,
      hasDeviceToken: true,
    });
    expect(JSON.stringify(returnedCredentials)).not.toContain(TOKEN);
    expect(mock.hasRollCredential()).toBe(true);
    expect(storageWrite).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(TOKEN);
  });

  it('assigns a server-created Roll with ROLL_JOIN and its upload scope', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ deviceId: DEVICE_ID, deviceToken: TOKEN }))
      .mockResolvedValueOnce(
        json({
          rollId: 'roll_server',
          slug: 'ABC234',
          guestUrl: `${SERVER}/r/ABC234`,
          hostUrl: `${SERVER}/host#token=hrt_host-secret`,
        }, 201),
      );
    const client = new HttpRollServerClient(SERVER);
    const { device, sent } = await camera();
    await client.registerDevice('KINO000012', 'KINO', 'V1');

    const started = await startRoll(device, client, { title: 'Party', downloadsEnabled: true });

    expect(sent.some((call) => call.cmd === Cmd.ROLL_CREATE)).toBe(false);
    expect(sent.find((call) => call.cmd === Cmd.ROLL_JOIN)?.payload).toMatchObject({
      rollId: 'roll_server',
      slug: 'ABC234',
      uploadScope: 'upload',
      role: 'host',
    });
    expect(started.deviceRollId).toBe('roll_server');
    expect((await device.rollStatus()).roll?.role).toBe('host');
  });

  it('keeps camera and gallery operations working when the backend is offline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network offline'));
    const client = new HttpRollServerClient(SERVER);
    const { device } = await camera();

    await expect(client.testConnection()).resolves.toMatchObject({ ok: false });
    await expect(client.registerDevice('KINO000012', 'KINO', 'V1')).rejects.toMatchObject({
      code: 'SERVER_UNREACHABLE',
    });

    await expect(device.getDeviceInfo()).resolves.toMatchObject({ serial: 'KINO000012' });
    const gallery = await device.mediaList({ limit: 2 });
    expect(gallery.items).toHaveLength(2);
    await expect(device.setMode('quad')).resolves.toBeDefined();
  });
});
