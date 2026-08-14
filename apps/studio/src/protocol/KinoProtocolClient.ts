import type { Transport } from '../transport/Transport';
import { Cmd, Evt, FrameFlags, PROTOCOL_VERSION } from './commands';
import { FrameDecoder, encodeFrame, encodeJson, decodeJson } from './packet';
import type { Frame } from './packet';
import type { ProtocolError } from './types';

export class KinoCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KinoCommandError';
    this.code = code;
  }
}

/** Firmware answered but does not implement the command. */
export class KinoUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KinoUnsupportedError';
  }
}

export class KinoTimeoutError extends Error {
  constructor(cmd: Cmd) {
    super(`No response to ${Cmd[cmd] ?? cmd} — command timed out`);
    this.name = 'KinoTimeoutError';
  }
}

interface Pending {
  cmd: Cmd;
  resolve: (payload: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClientStats {
  txFrames: number;
  rxFrames: number;
  rxEvents: number;
  crcFailures: number;
  timeouts: number;
  resyncs: number;
}

/** One line of the developer protocol monitor. */
export interface FrameTraceEntry {
  t: number;
  dir: 'tx' | 'rx';
  type: number;
  flags: number;
  seq: number;
  len: number;
}

const TRACE_MAX = 200;
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Request/response + event layer over a byte transport. One instance per
 * connection; sequence numbers match responses to pending requests, and
 * unsolicited EVENT frames are fanned out to subscribers.
 */
export class KinoProtocolClient {
  private readonly transport: Transport;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private eventHandlers = new Map<Evt, Set<(payload: unknown) => void>>();
  private seq = 1;
  private closed = false;

  readonly stats: ClientStats = {
    txFrames: 0,
    rxFrames: 0,
    rxEvents: 0,
    crcFailures: 0,
    timeouts: 0,
    resyncs: 0,
  };

  /** Bounded ring of recent frames for the developer protocol monitor. */
  readonly trace: FrameTraceEntry[] = [];

  private pushTrace(entry: FrameTraceEntry) {
    this.trace.push(entry);
    if (this.trace.length > TRACE_MAX) this.trace.splice(0, this.trace.length - TRACE_MAX);
  }

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onData((data) => this.handleData(data));
  }

  get transportKind() {
    return this.transport.kind;
  }

  onEvent<T = unknown>(evt: Evt, handler: (payload: T) => void): () => void {
    let set = this.eventHandlers.get(evt);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(evt, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => set.delete(handler as (payload: unknown) => void);
  }

  /** Send a JSON command and decode the JSON response. */
  async request<TRes>(cmd: Cmd, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TRes> {
    const raw = await this.requestRaw(cmd, encodeJson(payload), FrameFlags.NONE, timeoutMs);
    return decodeJson<TRes>(raw);
  }

  /** Send a binary command (firmware chunks) and decode the JSON response. */
  async requestBinary<TRes>(cmd: Cmd, payload: Uint8Array, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TRes> {
    const raw = await this.requestRaw(cmd, payload, FrameFlags.BINARY, timeoutMs);
    return decodeJson<TRes>(raw);
  }

  /** Send a JSON command whose response payload is raw bytes (media reads). */
  async requestBytes(cmd: Cmd, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
    return this.requestRaw(cmd, encodeJson(payload), FrameFlags.NONE, timeoutMs);
  }

  private requestRaw(
    cmd: Cmd,
    payload: Uint8Array,
    flags: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    if (this.closed) {
      return Promise.reject(new Error('Connection closed'));
    }
    const seq = this.seq++;
    const frame = encodeFrame({
      version: PROTOCOL_VERSION,
      type: cmd,
      flags,
      seq,
      payload,
    });

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        this.stats.timeouts++;
        reject(new KinoTimeoutError(cmd));
      }, timeoutMs);
      this.pending.set(seq, { cmd, resolve, reject, timer });
      this.stats.txFrames++;
      this.pushTrace({ t: Date.now(), dir: 'tx', type: cmd, flags, seq, len: payload.length });
      this.transport.write(frame).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private handleData(data: Uint8Array) {
    const frames = this.decoder.push(data);
    this.stats.crcFailures = this.decoder.stats.crcFailures;
    this.stats.resyncs = this.decoder.stats.resyncs;
    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame) {
    this.pushTrace({
      t: Date.now(),
      dir: 'rx',
      type: frame.type,
      flags: frame.flags,
      seq: frame.seq,
      len: frame.payload.length,
    });
    if (frame.flags & FrameFlags.EVENT) {
      this.stats.rxEvents++;
      const handlers = this.eventHandlers.get(frame.type as Evt);
      if (handlers) {
        const payload = decodeJson<unknown>(frame.payload);
        for (const handler of handlers) handler(payload);
      }
      return;
    }

    if (frame.flags & FrameFlags.RESPONSE) {
      this.stats.rxFrames++;
      const pending = this.pending.get(frame.seq);
      if (!pending) return; // late response after timeout — drop
      this.pending.delete(frame.seq);
      clearTimeout(pending.timer);
      if (frame.flags & FrameFlags.ERROR) {
        const err = decodeJson<ProtocolError>(frame.payload);
        const code = err.code ?? 'ERROR';
        pending.reject(
          code === 'UNSUPPORTED_COMMAND'
            ? new KinoUnsupportedError(err.message ?? 'Command not supported by this firmware')
            : new KinoCommandError(code, err.message ?? 'Device error'),
        );
      } else {
        pending.resolve(frame.payload);
      }
    }
  }

  /** Fail all in-flight requests and stop accepting new ones. */
  dispose(reason = 'Connection closed') {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }
}
