// Acceptance record for 07 §13 "Critical Studio transport acceptance".
//
// Requirement            Covered by
// ---------------------  ------------------------------------------------------
// split frame            packet.test.ts "reassembles a frame delivered one byte
//                        at a time" (every read boundary, including mid-header
//                        and mid-length-field) + "decodes a single complete frame"
// multiple frames/read   packet.test.ts "splits multiple frames received in one read"
// bad CRC                packet.test.ts "drops a corrupted frame and recovers the
//                        next one" (resync without reset, 04 §3) + "rejects an
//                        insane length field without stalling the stream"
// boot text              this file, "decoder / boot text"
// random bytes           this file, "decoder / random bytes"
// wrong protocol         this file, "decoder / wrong protocol" (frame version is
//                        surfaced, never coerced) + "HELLO / protocol negotiation"
// disconnect/reconnect   this file, "client / disconnect + reconnect"
// new session ID         this file, "client / session ID" (04 §17)
// HELLO retry            this file, "HELLO / retry"
// HELLO nonce            this file, "HELLO / nonce echo"
// HELLO timeout          this file, "HELLO / timeout"
// HELLO negotiation      this file, "HELLO / protocol negotiation"
//
// Cases already covered above are cross-referenced, not copied: duplicating them
// here would mean two places to update when the decoder changes.
//
// Imports come from the package barrel on purpose — it doubles as the smoke test
// that everything the apps consume is actually re-exported.

import { describe, expect, it } from 'vitest';
import {
  Cmd,
  Evt,
  FrameDecoder,
  FrameFlags,
  KinoHandshakeError,
  KinoProtocolClient,
  KinoTimeoutError,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJson,
  decodeJson,
} from '../src/index';
import type { Frame, HelloResponse, SessionChange, Transport } from '../src/index';

// ---------------------------------------------------------------------------
// Harness: a transport with a hand-cranked inbound stream. Outbound bytes are
// decoded back into frames so a test can answer whatever the client asked for.
// ---------------------------------------------------------------------------

class PipeTransport implements Transport {
  readonly kind = 'mock' as const;
  readonly written: Frame[] = [];
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private readonly outbound = new FrameDecoder();
  private onWrite: ((frame: Frame) => void) | null = null;
  open = async (): Promise<void> => {};
  close = async (): Promise<void> => {
    this.closeCb?.('closed');
  };

  async write(data: Uint8Array): Promise<void> {
    for (const frame of this.outbound.push(data)) {
      this.written.push(frame);
      this.onWrite?.(frame);
    }
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }

  /** Push bytes at the client as if they arrived from the wire. */
  feed(bytes: Uint8Array): void {
    this.dataCb?.(bytes);
  }

  /** Answer outbound frames as a device would. */
  serve(handler: (frame: Frame) => void): void {
    this.onWrite = handler;
  }
}

function respond(frame: Frame, payload: unknown, flags = FrameFlags.RESPONSE): Uint8Array {
  return encodeFrame({
    version: PROTOCOL_VERSION,
    type: frame.type,
    flags,
    seq: frame.seq,
    payload: encodeJson(payload),
  });
}

function event(type: Evt, payload: unknown): Uint8Array {
  return encodeFrame({
    version: PROTOCOL_VERSION,
    type,
    flags: FrameFlags.EVENT,
    seq: 0,
    payload: encodeJson(payload),
  });
}

function dataFrame(seq: number, payload: unknown, version = PROTOCOL_VERSION): Uint8Array {
  return encodeFrame({
    version,
    type: Cmd.HELLO,
    flags: FrameFlags.RESPONSE,
    seq,
    payload: encodeJson(payload),
  });
}

/** Deterministic "random" bytes — a fixed LCG keeps the case reproducible. */
function pseudoRandom(n: number, seed = 0x1234abcd): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

const FAST_HELLO = { timeoutMs: 20, retryDelayMs: 0 } as const;

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

describe('decoder / boot text', () => {
  // An ESP32 prints its ROM banner before firmware runs, so the very first
  // bytes of a session are never a frame. packet.test.ts covers short binary
  // garbage; this is the real thing, split across reads the way a CDC port
  // delivers it.
  const BOOT_TEXT =
    'ets Jul 29 2019 12:21:46\r\n\r\n' +
    'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\n' +
    'configsip: 0, SPIWP:0xee\r\n' +
    'clk_drv:0x00,q_drv:0x00,d_drv:0x00,cs0_drv:0x00,hd_drv:0x00,wp_drv:0x00\r\n' +
    'mode:DIO, clock div:2\r\nload:0x3fff0030,len:1344\r\nentry 0x400805e4\r\n' +
    'I (31) boot: ESP-IDF v5.1 2nd stage bootloader\r\n';

  it('decodes the first frame after a full ROM boot banner', () => {
    const decoder = new FrameDecoder();
    const banner = new TextEncoder().encode(BOOT_TEXT);
    const frame = dataFrame(1, { product: 'KINO' });

    const collected: Frame[] = [];
    // Banner in three reads, then the frame — nothing decodes until the frame.
    for (const chunk of [banner.subarray(0, 40), banner.subarray(40, 120), banner.subarray(120)]) {
      collected.push(...decoder.push(chunk));
    }
    expect(collected).toHaveLength(0);

    collected.push(...decoder.push(frame));
    expect(collected).toHaveLength(1);
    expect(decodeJson<{ product: string }>(collected[0]!.payload).product).toBe('KINO');
  });

  it('decodes a frame whose header is glued to the tail of the boot banner', () => {
    const decoder = new FrameDecoder();
    const bytes = new Uint8Array([...new TextEncoder().encode(BOOT_TEXT), ...dataFrame(2, { ok: true })]);
    // One read that straddles banner and frame, split mid-header.
    const cut = BOOT_TEXT.length + 7;
    const collected = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
    expect(collected.map((f) => f.seq)).toEqual([2]);
  });
});

describe('decoder / random bytes', () => {
  it('emits nothing for a burst of random bytes and still decodes the next frame', () => {
    const decoder = new FrameDecoder();
    const noise = pseudoRandom(4096);
    const fromNoise: Frame[] = [];
    for (let i = 0; i < noise.length; i += 137) {
      fromNoise.push(...decoder.push(noise.subarray(i, i + 137)));
    }
    expect(fromNoise).toHaveLength(0);
    expect(decoder.push(dataFrame(11, { after: 'noise' })).map((f) => f.seq)).toEqual([11]);
  });

  it('does not accumulate magic-free noise in the reassembly buffer', () => {
    const decoder = new FrameDecoder();
    // 0x4b/0x49 stripped: nothing here can ever start a frame, so nothing may
    // be retained — an unbounded buffer is how a noisy link becomes an OOM.
    const noise = pseudoRandom(8192, 0x0badc0de).map((b) => (b === 0x4b || b === 0x49 ? 0x00 : b));
    for (let i = 0; i < noise.length; i += 512) decoder.push(noise.subarray(i, i + 512));
    expect(decoder.stats.discardedBytes).toBeGreaterThanOrEqual(noise.length - 1);
    expect(decoder.push(dataFrame(12, {})).map((f) => f.seq)).toEqual([12]);
  });
});

describe('decoder / wrong protocol', () => {
  it('surfaces the frame version instead of coercing it', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(dataFrame(3, { product: 'KINO', protocol: 9 }, 9));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.version).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// HELLO (04 §4)
// ---------------------------------------------------------------------------

describe('HELLO / retry', () => {
  it('retries a silent device up to three times and succeeds on the last', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    let seen = 0;
    t.serve((frame) => {
      seen++;
      if (seen < 3) return; // silence
      t.feed(respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION, nonce: decodeJson<{ nonce: number }>(frame.payload).nonce }));
    });

    const hello = await client.hello(FAST_HELLO);
    expect(hello.product).toBe('KINO');
    expect(t.written.filter((f) => f.type === Cmd.HELLO)).toHaveLength(3);
    client.dispose();
  });

  it('sends the supported protocol range, a fresh nonce and the client version', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    const nonces: number[] = [];
    t.serve((frame) => {
      const req = decodeJson<{ nonce: number; protocolMin: number; protocolMax: number; client: string | null }>(frame.payload);
      nonces.push(req.nonce);
      expect(req.protocolMin).toBe(1);
      expect(req.protocolMax).toBe(PROTOCOL_VERSION);
      expect(req.client).toBe('studio-test');
      if (nonces.length < 2) return;
      t.feed(respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION, nonce: req.nonce }));
    });

    await client.hello({ ...FAST_HELLO, protocolMin: 1, clientVersion: 'studio-test' });
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]); // a replayed nonce proves nothing
    client.dispose();
  });
});

describe('HELLO / nonce echo', () => {
  it('rejects a reply carrying somebody else\'s nonce and retries', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    let seen = 0;
    t.serve((frame) => {
      seen++;
      const req = decodeJson<{ nonce: number }>(frame.payload);
      // First two replies are a stale serial buffer: right shape, wrong nonce.
      t.feed(respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION, nonce: seen < 3 ? req.nonce ^ 0xffff : req.nonce }));
    });

    const hello = await client.hello(FAST_HELLO);
    expect(hello.product).toBe('KINO');
    expect(seen).toBe(3);
    client.dispose();
  });

  it('fails the handshake when the nonce never matches', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve((frame) => {
      t.feed(respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION, nonce: 0 }));
    });

    await expect(client.hello({ ...FAST_HELLO, nonce: () => 1234 })).rejects.toMatchObject({
      name: 'KinoHandshakeError',
      reason: 'nonce',
    });
    client.dispose();
  });

  it('accepts firmware that omits the nonce echo entirely', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve((frame) => t.feed(respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION })));
    await expect(client.hello(FAST_HELLO)).resolves.toMatchObject({ product: 'KINO' });
    client.dispose();
  });
});

describe('HELLO / timeout', () => {
  it('gives up with a handshake error after three silent attempts', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve(() => {}); // device never answers

    const err = await client.hello(FAST_HELLO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KinoHandshakeError);
    expect((err as KinoHandshakeError).reason).toBe('timeout');
    expect((err as KinoHandshakeError).attempts).toBe(3);
    expect(t.written.filter((f) => f.type === Cmd.HELLO)).toHaveLength(3);
    expect(client.stats.timeouts).toBe(3);
    client.dispose();
  });

  it('a plain request still reports KinoTimeoutError', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve(() => {});
    await expect(client.request(Cmd.GET_DEVICE_INFO, {}, 20)).rejects.toBeInstanceOf(KinoTimeoutError);
    client.dispose();
  });
});

describe('HELLO / protocol negotiation', () => {
  it('accepts the protocol the device selected inside the offered range', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve((frame) => {
      const req = decodeJson<{ nonce: number; protocolMin: number }>(frame.payload);
      t.feed(respond(frame, { product: 'KINO', protocol: req.protocolMin, nonce: req.nonce }));
    });

    const hello = await client.hello({ ...FAST_HELLO, protocolMin: 1, protocolMax: PROTOCOL_VERSION });
    expect(hello.protocol).toBe(1);
    expect(client.negotiatedProtocol).toBe(1);
    client.dispose();
  });

  it('fails immediately — no retry — when the device picks a protocol we do not speak', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve((frame) => {
      const req = decodeJson<{ nonce: number }>(frame.payload);
      t.feed(respond(frame, { product: 'KINO', protocol: 7, nonce: req.nonce }));
    });

    await expect(client.hello(FAST_HELLO)).rejects.toMatchObject({
      name: 'KinoHandshakeError',
      reason: 'protocol',
    });
    // Version mismatch does not fix itself: retrying it just delays the message.
    expect(t.written.filter((f) => f.type === Cmd.HELLO)).toHaveLength(1);
    expect(client.negotiatedProtocol).toBeNull();
    client.dispose();
  });
});

// ---------------------------------------------------------------------------
// Session ID (04 §17) and reconnect
// ---------------------------------------------------------------------------

function helloServer(t: PipeTransport, sessionId: () => string | number | undefined, deviceId = 'kino-0001') {
  t.serve((frame) => {
    const req = decodeJson<{ nonce: number }>(frame.payload);
    t.feed(
      respond(frame, {
        product: 'KINO',
        protocol: PROTOCOL_VERSION,
        nonce: req.nonce,
        deviceId,
        sessionId: sessionId(),
      } satisfies HelloResponse),
    );
  });
}

describe('client / session ID', () => {
  it('records the first session without announcing a change', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    const changes: SessionChange[] = [];
    client.onSessionChanged((c) => changes.push(c));
    helloServer(t, () => 'boot-1');

    await client.hello(FAST_HELLO);
    expect(client.sessionId).toBe('boot-1');
    expect(changes).toEqual([]);
    client.dispose();
  });

  it('stays quiet when the same device answers with the same session', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    const changes: SessionChange[] = [];
    client.onSessionChanged((c) => changes.push(c));
    helloServer(t, () => 'boot-1');

    await client.hello(FAST_HELLO);
    await client.hello(FAST_HELLO);
    expect(changes).toEqual([]);
    client.dispose();
  });

  it('announces sessionChanged when the device came back on a new boot', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    const changes: SessionChange[] = [];
    client.onSessionChanged((c) => changes.push(c));
    let session = 'boot-1';
    helloServer(t, () => session);

    await client.hello(FAST_HELLO);
    session = 'boot-2'; // device rebooted underneath us
    await client.hello(FAST_HELLO);

    expect(changes).toEqual([{ previous: 'boot-1', current: 'boot-2', deviceId: 'kino-0001' }]);
    expect(client.sessionId).toBe('boot-2');
    client.dispose();
  });

  it('detects the reboot across a reconnect, when the client itself is new', async () => {
    // Studio builds a fresh client per connection, so the previous session ID
    // has to be handed back in or an unexpected reboot reads as a clean start.
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    const changes: SessionChange[] = [];
    client.onSessionChanged((c) => changes.push(c));
    helloServer(t, () => 4242); // numeric session IDs normalize to strings

    await client.hello({ ...FAST_HELLO, knownSessionId: '4141' });
    expect(changes).toEqual([{ previous: '4141', current: '4242', deviceId: 'kino-0001' }]);
    client.dispose();
  });

  it('tolerates firmware that predates session IDs', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    const changes: SessionChange[] = [];
    client.onSessionChanged((c) => changes.push(c));
    helloServer(t, () => undefined);

    await client.hello(FAST_HELLO);
    expect(client.sessionId).toBeNull();
    expect(changes).toEqual([]);
    client.dispose();
  });
});

describe('client / disconnect + reconnect', () => {
  it('fails every in-flight request with the disconnect reason', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    t.serve(() => {});
    const inflight = client.request(Cmd.GET_DEVICE_INFO, {}, 5000);
    client.dispose('KINO disconnected unexpectedly');
    await expect(inflight).rejects.toThrow('KINO disconnected unexpectedly');
  });

  it('refuses new requests after disconnect instead of hanging until timeout', async () => {
    const t = new PipeTransport();
    const client = new KinoProtocolClient(t);
    client.dispose();
    await expect(client.request(Cmd.GET_DEVICE_INFO)).rejects.toThrow(/closed/i);
  });

  it('a fresh client over the reopened port handshakes and talks again', async () => {
    const first = new PipeTransport();
    const a = new KinoProtocolClient(first);
    helloServer(first, () => 'boot-1');
    await a.hello(FAST_HELLO);
    a.dispose('KINO is rebooting');

    // Reconnect: new transport, new client, device came up on a new session.
    const second = new PipeTransport();
    const b = new KinoProtocolClient(second);
    const changes: SessionChange[] = [];
    b.onSessionChanged((c) => changes.push(c));
    second.serve((frame) => {
      if (frame.type === Cmd.HELLO) {
        const req = decodeJson<{ nonce: number }>(frame.payload);
        second.feed(respond(frame, { product: 'KINO', protocol: PROTOCOL_VERSION, nonce: req.nonce, sessionId: 'boot-2' }));
      } else {
        second.feed(respond(frame, { serial: 'K-0001' }));
      }
    });

    await b.hello({ ...FAST_HELLO, knownSessionId: a.sessionId });
    expect(changes.map((c) => c.current)).toEqual(['boot-2']);
    await expect(b.request<{ serial: string }>(Cmd.GET_DEVICE_INFO, {}, 200)).resolves.toEqual({ serial: 'K-0001' });
    b.dispose();
  });

  it('half a frame left over from the dropped link cannot corrupt the next one', () => {
    // Reconnect builds a new decoder; prove the truncated tail of the old
    // session is not what makes the next session's first frame decodable.
    const truncated = dataFrame(99, { partial: true }).subarray(0, 9);
    const fresh = new FrameDecoder();
    expect(fresh.push(dataFrame(1, { product: 'KINO' })).map((f) => f.seq)).toEqual([1]);

    // Same bytes fed to a decoder that still holds the stale half: the stale
    // frame is discarded on resync, the live frame still arrives.
    const stale = new FrameDecoder();
    stale.push(truncated);
    expect(stale.push(dataFrame(1, { product: 'KINO' })).map((f) => f.seq)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

describe('package barrel', () => {
  it('re-exports the protocol surface the apps import', () => {
    expect(typeof KinoProtocolClient).toBe('function');
    expect(typeof FrameDecoder).toBe('function');
    expect(typeof encodeFrame).toBe('function');
    expect(Cmd.HELLO).toBe(0x01);
    expect(Evt.JOB_PROGRESS).toBeGreaterThan(Evt.LOG);
    expect(FrameFlags.EVENT).toBe(0x02);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
