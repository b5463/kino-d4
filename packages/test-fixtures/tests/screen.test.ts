// Issue #246: the Screen group (0xb0-0xb3) on the reference device, held to
// the rules firmware/p4/main/kdp_ui.c answers with: GET_SCREEN renders once
// and pages at most 3072 bytes, a page of a stale render is INVALID_STATE, a
// move is BUSY, the plate is a picture of its own, and the capability and the
// gate agree.
import { afterEach, describe, expect, it } from 'vitest';
import {
  Cmd,
  KinoCommandError,
  KinoProtocolClient,
  KinoUnsupportedError,
  MockTransport,
  SCREEN_CHUNK_MAX,
  SCREEN_H,
  SCREEN_W,
} from '@kino/kdp';
import type { CapabilitiesResponse, ScreenShotInfo } from '@kino/kdp';
import { MOCK_SCREEN_MOVE_MS, MockKinoDevice } from '../src/index';

let transport: MockTransport | null = null;

async function connect() {
  let clock = 1_000_000;
  const mock = new MockKinoDevice({ seed: 11, ambientCaptures: false, now: () => clock });
  transport = new MockTransport(mock);
  await transport.open();
  const client = new KinoProtocolClient(transport);
  return { mock, client, advance: (ms: number) => (clock += ms) };
}

afterEach(async () => {
  await transport?.close();
  transport = null;
});

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof KinoUnsupportedError) return 'UNSUPPORTED_COMMAND';
    if (err instanceof KinoCommandError) return err.code;
    throw err;
  }
};

/** One pixel of a render, read as a two-byte page: a whole screen is 250
 * pages, and the reference transport paces every reply like the wire. */
async function pixelOf(client: KinoProtocolClient, shot: number, x: number, y: number) {
  const b = await client.requestBytes(Cmd.GET_SCREEN, { shot, offset: (y * SCREEN_W + x) * 2, length: 2 });
  expect(b.length).toBe(2);
  return b[0] | (b[1] << 8);
}

describe('GET_SCREEN', () => {
  it('describes a render, and its pages read the picture it described', async () => {
    const { client } = await connect();
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.screenControl).toBe(true);

    const info = await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {});
    expect(info).toMatchObject({
      width: SCREEN_W,
      height: SCREEN_H,
      format: 'rgb565le',
      bytes: SCREEN_W * SCREEN_H * 2,
      chunkMax: SCREEN_CHUNK_MAX,
      screen: 'menu',
      plate: false,
    });
    expect(info.shot).toBeGreaterThan(0);
    expect(Math.ceil(info.bytes / info.chunkMax)).toBe(250);
    // The ground in the corner, the MAO pink on the menu card.
    expect(await pixelOf(client, info.shot, 0, 0)).toBe(0x0841);
    expect(await pixelOf(client, info.shot, 600, 240)).toBe(0xf518);
    // The first full page and the empty answer at the end.
    const first = await client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: 0 });
    expect(first.length).toBe(SCREEN_CHUNK_MAX);
    const tail = await client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: info.bytes });
    expect(tail.length).toBe(0);
  });

  it('clamps a page to 3072 bytes and refuses an offset past the end', async () => {
    const { client } = await connect();
    const info = await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {});
    const big = await client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: 0, length: 9000 });
    expect(big.length).toBe(SCREEN_CHUNK_MAX);
    // As pure_screen_page(): length 0 is a full page, not one byte.
    const zero = await client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: 0, length: 0 });
    expect(zero.length).toBe(SCREEN_CHUNK_MAX);
    const last = await client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: info.bytes - 10 });
    expect(last.length).toBe(10);
    expect(await codeOf(client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: info.bytes + 1 }))).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('refuses a page of a render the canvas no longer holds, and a move in progress', async () => {
    const { client, advance } = await connect();
    const info = await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {});
    // The LOOK row on the menu, right hand.
    expect(await client.request(Cmd.UI_TAP, { x: 190, y: 58 })).toEqual({ ok: true, queued: 1 });
    expect(await codeOf(client.request(Cmd.GET_SCREEN, {}))).toBe('BUSY');
    advance(MOCK_SCREEN_MOVE_MS);
    expect(await codeOf(client.requestBytes(Cmd.GET_SCREEN, { shot: info.shot, offset: 0 }))).toBe('INVALID_STATE');
    const again = await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {});
    expect(again.screen).toBe('look');
    expect(again.shot).not.toBe(info.shot);
  });
});

describe('UI_TAP and UI_KEY', () => {
  it('walks MENU -> SETTINGS -> ABOUT and back by taps', async () => {
    const { client, advance } = await connect();
    const on = async () => {
      advance(MOCK_SCREEN_MOVE_MS);
      return (await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {})).screen;
    };
    await client.request(Cmd.UI_TAP, { x: 190, y: 331 });
    expect(await on()).toBe('settings');
    await client.request(Cmd.UI_TAP, { x: 400, y: 367 });
    expect(await on()).toBe('about');
    await client.request(Cmd.UI_TAP, { x: 752, y: 31 });
    expect(await on()).toBe('settings');
    await client.request(Cmd.UI_TAP, { x: 752, y: 31 });
    expect(await on()).toBe('menu');
  });

  it('has a STATUS row on SETTINGS only while the body reports a condition', async () => {
    const { mock, client, advance } = await connect();
    const on = async () => {
      advance(MOCK_SCREEN_MOVE_MS);
      return client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {});
    };
    await client.request(Cmd.UI_TAP, { x: 190, y: 331 });
    let info = await on();
    expect(info.screen).toBe('settings');
    // Healthy: five rows. The sixth row's place is ground, and a tap there
    // opens nothing.
    expect(await pixelOf(client, info.shot, 400, 431)).toBe(0x0841);
    await client.request(Cmd.UI_TAP, { x: 400, y: 431 });
    expect((await on()).screen).toBe('settings');

    mock.setScenario('sdMissing', true);
    info = await on();
    expect(await pixelOf(client, info.shot, 400, 431)).toBe(0x18c3);
    await client.request(Cmd.UI_TAP, { x: 400, y: 431 });
    expect((await on()).screen).toBe('status');
  });

  it('opens SHOOT with the shutter key and refuses what is not a key or a point', async () => {
    const { client, advance } = await connect();
    expect(await client.request(Cmd.UI_KEY, { key: 'shutter' })).toEqual({ ok: true, key: 'shutter' });
    advance(MOCK_SCREEN_MOVE_MS);
    expect((await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {})).screen).toBe('shoot');
    expect(await codeOf(client.request(Cmd.UI_KEY, { key: 'menu' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(client.request(Cmd.UI_TAP, { x: 800, y: 10 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(client.request(Cmd.UI_TAP, { x: 10, y: -1 }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(client.request(Cmd.UI_TAP, { x: 10, y: 10, holdMs: 5 }))).toBe('INVALID_ARGUMENT');
  });
});

describe('SCREEN_PLATE', () => {
  it('shows the plate until a key ends it', async () => {
    const { client } = await connect();
    expect(await client.request(Cmd.SCREEN_PLATE, { on: true })).toEqual({ ok: true, on: true });
    const info = await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {});
    expect(info.plate).toBe(true);
    expect(info.screen).toBe('menu');
    // Black at the ramp's first step, white at its last, MAO pink at the
    // first launch patch, the 1 px grid in the light ink.
    expect(await pixelOf(client, info.shot, 5, 40)).toBe(0x0000);
    expect(await pixelOf(client, info.shot, 795, 40)).toBe(0xffff);
    expect(await pixelOf(client, info.shot, 50, 180)).toBe(0xf518);
    expect(await pixelOf(client, info.shot, 20, 310)).toBe(0xf77c);
    expect(await pixelOf(client, info.shot, 21, 301)).toBe(0x0000);

    await client.request(Cmd.UI_KEY, { key: 'fn' });
    expect((await client.request<ScreenShotInfo>(Cmd.GET_SCREEN, {})).plate).toBe(false);
    expect(await codeOf(client.request(Cmd.SCREEN_PLATE, {}))).toBe('INVALID_ARGUMENT');
  });
});

describe('the gate', () => {
  it('answers UNSUPPORTED_COMMAND and drops the flag on firmware without the group', async () => {
    const { mock, client } = await connect();
    mock.setScenario('legacyFirmware', true);
    const caps = await client.request<CapabilitiesResponse>(Cmd.GET_CAPABILITIES);
    expect(caps.capabilities.screenControl).toBe(false);
    for (const cmd of [Cmd.GET_SCREEN, Cmd.SCREEN_PLATE, Cmd.UI_TAP, Cmd.UI_KEY]) {
      expect(await codeOf(client.request(cmd, {}))).toBe('UNSUPPORTED_COMMAND');
    }
  });
});
