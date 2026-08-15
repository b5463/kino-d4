// Async job model, 04 §15: a long operation answers { jobId, accepted } and
// then reports through JOB_PROGRESS / JOB_COMPLETE / JOB_FAILED events. Those
// events carry no request sequence ID (04 §16), so the client has to route
// them by jobId — that routing is what these tests pin down.

import { describe, expect, it } from 'vitest';
import {
  Cmd,
  Evt,
  FrameDecoder,
  FrameFlags,
  KinoJobError,
  KinoProtocolClient,
  PROTOCOL_VERSION,
  encodeFrame,
  encodeJson,
} from '../src/index';
import type { Frame, JobFailure, JobProgress, Transport } from '../src/index';

// ---------------------------------------------------------------------------
// Scripted device harness
// ---------------------------------------------------------------------------

type Step =
  | { onCommand: Cmd; reply: unknown }
  | { emit: { type: Evt; payload: unknown } };

/** Just enough of Node's process to observe unhandled rejections. */
interface RejectionHost {
  on(event: 'unhandledRejection', cb: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', cb: (reason: unknown) => void): void;
}

interface ScriptOptions {
  /**
   * 'burst' packs the reply and every event that follows it into one read —
   * the hostile case, because the events land before the caller's `await
   * startJob(...)` has even resumed. 'paced' delivers them on later ticks.
   */
  delivery?: 'burst' | 'paced';
}

class ScriptedTransport implements Transport {
  readonly kind = 'mock' as const;
  private dataCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private readonly outbound = new FrameDecoder();
  private cursor = 0;

  constructor(
    private readonly script: Step[],
    private readonly options: ScriptOptions = {},
  ) {}

  open = async (): Promise<void> => {};
  close = async (): Promise<void> => {
    this.closeCb?.('closed');
  };

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }

  async write(data: Uint8Array): Promise<void> {
    for (const frame of this.outbound.push(data)) this.run(frame);
  }

  private run(frame: Frame): void {
    const step = this.script[this.cursor];
    if (!step || !('onCommand' in step) || step.onCommand !== frame.type) {
      this.send([this.error(frame, 'UNSUPPORTED_COMMAND', 'Not in script')]);
      return;
    }
    this.cursor++;
    const chunks = [this.response(frame, step.reply)];
    // Everything up to the next command belongs to this reply.
    while (this.cursor < this.script.length) {
      const next = this.script[this.cursor];
      if (!next || !('emit' in next)) break;
      this.cursor++;
      chunks.push(this.event(next.emit.type, next.emit.payload));
    }
    this.send(chunks);
  }

  private send(chunks: Uint8Array[]): void {
    if (this.options.delivery === 'paced') {
      chunks.forEach((c, i) => setTimeout(() => this.dataCb?.(c), i));
      return;
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      merged.set(c, at);
      at += c.length;
    }
    this.dataCb?.(merged);
  }

  private response(frame: Frame, payload: unknown): Uint8Array {
    return encodeFrame({
      version: PROTOCOL_VERSION,
      type: frame.type,
      flags: FrameFlags.RESPONSE,
      seq: frame.seq,
      payload: encodeJson(payload),
    });
  }

  private error(frame: Frame, code: string, message: string): Uint8Array {
    return encodeFrame({
      version: PROTOCOL_VERSION,
      type: frame.type,
      flags: FrameFlags.RESPONSE | FrameFlags.ERROR,
      seq: frame.seq,
      payload: encodeJson({ code, message }),
    });
  }

  private event(type: Evt, payload: unknown): Uint8Array {
    return encodeFrame({
      version: PROTOCOL_VERSION,
      type,
      flags: FrameFlags.EVENT,
      seq: 0,
      payload: encodeJson(payload),
    });
  }

  /** Push an event outside the script, e.g. after the caller started iterating. */
  emit(type: Evt, payload: unknown): void {
    this.dataCb?.(this.event(type, payload));
  }
}

function makeClientWithScriptedDevice(script: Step[], options?: ScriptOptions) {
  const transport = new ScriptedTransport(script, options);
  const client = new KinoProtocolClient(transport);
  return { client, transport };
}

// ---------------------------------------------------------------------------

describe('async job model (04 §15)', () => {
  it('startJob yields progress then resolves result', async () => {
    const { client } = makeClientWithScriptedDevice([
      { onCommand: Cmd.SELF_TEST, reply: { jobId: 'job_1', accepted: true } },
      { emit: { type: Evt.JOB_PROGRESS, payload: { jobId: 'job_1', progress: 0.5 } } },
      { emit: { type: Evt.JOB_COMPLETE, payload: { jobId: 'job_1', result: { ok: true } } } },
    ]);

    const job = await client.startJob(Cmd.SELF_TEST, {});
    expect(job.jobId).toBe('job_1');
    const seen: number[] = [];
    for await (const p of job.progress) seen.push(p.progress);
    expect(seen).toEqual([0.5]);
    expect(await job.result).toEqual({ ok: true });
    client.dispose();
  });

  it('delivers progress that arrives only after iteration started', async () => {
    const { client, transport } = makeClientWithScriptedDevice([
      { onCommand: Cmd.CAMERA_CALIBRATE, reply: { jobId: 'job_2', accepted: true } },
    ]);

    const job = await client.startJob(Cmd.CAMERA_CALIBRATE, {});
    const seen: JobProgress[] = [];
    const drain = (async () => {
      for await (const p of job.progress) {
        seen.push(p);
        if (p.progress < 1) transport.emit(Evt.JOB_PROGRESS, { jobId: 'job_2', progress: 1, step: 'analyze' });
        else transport.emit(Evt.JOB_COMPLETE, { jobId: 'job_2', result: { reference: 'cam1' } });
      }
    })();

    transport.emit(Evt.JOB_PROGRESS, { jobId: 'job_2', progress: 0.25, step: 'capture' });
    await drain;
    expect(seen.map((p) => p.progress)).toEqual([0.25, 1]);
    expect(seen[1]?.step).toBe('analyze');
    expect(await job.result).toEqual({ reference: 'cam1' });
    client.dispose();
  });

  it('buffers events that beat the caller to the jobId (events carry no seq)', async () => {
    // 'burst': reply + both events arrive in a single read, before startJob's
    // promise even resumes. Nothing may be lost in that window.
    const { client } = makeClientWithScriptedDevice(
      [
        { onCommand: Cmd.LINK_BENCH, reply: { jobId: 'job_3', accepted: true } },
        { emit: { type: Evt.JOB_PROGRESS, payload: { jobId: 'job_3', progress: 0.2 } } },
        { emit: { type: Evt.JOB_PROGRESS, payload: { jobId: 'job_3', progress: 0.9 } } },
        { emit: { type: Evt.JOB_COMPLETE, payload: { jobId: 'job_3', result: { clean: true } } } },
      ],
      { delivery: 'burst' },
    );

    const job = await client.startJob(Cmd.LINK_BENCH, { seconds: 5 });
    const seen: number[] = [];
    for await (const p of job.progress) seen.push(p.progress);
    expect(seen).toEqual([0.2, 0.9]);
    expect(await job.result).toEqual({ clean: true });
    client.dispose();
  });

  it('routes concurrent jobs by jobId, not by arrival order', async () => {
    const { client, transport } = makeClientWithScriptedDevice([
      { onCommand: Cmd.SELF_TEST, reply: { jobId: 'job_a', accepted: true } },
      { onCommand: Cmd.LINK_BENCH, reply: { jobId: 'job_b', accepted: true } },
    ]);

    const a = await client.startJob(Cmd.SELF_TEST, {});
    const b = await client.startJob(Cmd.LINK_BENCH, {});
    const seenA: number[] = [];
    const seenB: number[] = [];
    const drainA = (async () => {
      for await (const p of a.progress) seenA.push(p.progress);
    })();
    const drainB = (async () => {
      for await (const p of b.progress) seenB.push(p.progress);
    })();

    transport.emit(Evt.JOB_PROGRESS, { jobId: 'job_b', progress: 0.1 });
    transport.emit(Evt.JOB_PROGRESS, { jobId: 'job_a', progress: 0.7 });
    transport.emit(Evt.JOB_COMPLETE, { jobId: 'job_b', result: { b: true } });
    transport.emit(Evt.JOB_COMPLETE, { jobId: 'job_a', result: { a: true } });

    await Promise.all([drainA, drainB]);
    expect(seenA).toEqual([0.7]);
    expect(seenB).toEqual([0.1]);
    expect(await a.result).toEqual({ a: true });
    expect(await b.result).toEqual({ b: true });
    client.dispose();
  });

  it('JOB_FAILED rejects result with the device error object', async () => {
    const deviceError: JobFailure = {
      code: 'CAMERA_OFFLINE',
      message: 'CAM3 did not respond',
      details: { camera: 3, uartErrors: 4 },
      recoverable: true,
      suggestedActions: ['CAMERA_TEST'],
    };
    const { client } = makeClientWithScriptedDevice([
      { onCommand: Cmd.SELF_TEST, reply: { jobId: 'job_4', accepted: true } },
      { emit: { type: Evt.JOB_PROGRESS, payload: { jobId: 'job_4', progress: 0.3 } } },
      { emit: { type: Evt.JOB_FAILED, payload: { jobId: 'job_4', error: deviceError } } },
    ]);

    const job = await client.startJob(Cmd.SELF_TEST, {});
    const seen: number[] = [];
    for await (const p of job.progress) seen.push(p.progress);
    expect(seen).toEqual([0.3]); // progress still ends cleanly on failure

    const err = await job.result.then(() => null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KinoJobError);
    expect((err as KinoJobError).code).toBe('CAMERA_OFFLINE');
    expect((err as KinoJobError).jobId).toBe('job_4');
    expect((err as KinoJobError).deviceError).toEqual(deviceError);
    client.dispose();
  });

  it('a failed job nobody awaits does not raise an unhandled rejection', async () => {
    const { client } = makeClientWithScriptedDevice([
      { onCommand: Cmd.SELF_TEST, reply: { jobId: 'job_5', accepted: true } },
      { emit: { type: Evt.JOB_FAILED, payload: { jobId: 'job_5', error: { code: 'BUSY', message: 'Try later' } } } },
    ]);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    // @types/node is not a dependency of this package, and one test is not a
    // reason to add it — reach the hook through globalThis instead.
    const host = (globalThis as unknown as { process?: RejectionHost }).process;
    host?.on('unhandledRejection', onUnhandled);
    let job;
    try {
      job = await client.startJob(Cmd.SELF_TEST, {});
      // Consume progress only — result is deliberately never awaited here.
      for await (const p of job.progress) void p;
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      host?.off('unhandledRejection', onUnhandled);
    }
    expect(rejections).toEqual([]);
    // The internal keep-alive catch must not have swallowed the failure.
    await expect(job.result).rejects.toMatchObject({ code: 'BUSY' });
    client.dispose();
  });

  it('fails the job when the device refuses to start it', async () => {
    const { client } = makeClientWithScriptedDevice([
      { onCommand: Cmd.SELF_TEST, reply: { accepted: false } },
    ]);
    await expect(client.startJob(Cmd.SELF_TEST, {})).rejects.toThrow(/did not start a job/i);
    client.dispose();
  });

  it('surfaces a NACK from the start command unchanged', async () => {
    const { client } = makeClientWithScriptedDevice([]); // scripted device NACKs everything
    await expect(client.startJob(Cmd.SELF_TEST, {})).rejects.toMatchObject({ name: 'KinoUnsupportedError' });
    client.dispose();
  });

  it('a disconnect ends the progress stream and rejects the result', async () => {
    const { client } = makeClientWithScriptedDevice([
      { onCommand: Cmd.CAMERA_CALIBRATE, reply: { jobId: 'job_6', accepted: true } },
    ]);
    const job = await client.startJob(Cmd.CAMERA_CALIBRATE, {});
    const drained = (async () => {
      const seen: JobProgress[] = [];
      for await (const p of job.progress) seen.push(p);
      return seen;
    })();

    client.dispose('KINO disconnected unexpectedly');
    await expect(drained).resolves.toEqual([]);
    await expect(job.result).rejects.toThrow('KINO disconnected unexpectedly');
  });

  it('ignores job events for a job that was never started', async () => {
    const { client, transport } = makeClientWithScriptedDevice([
      { onCommand: Cmd.SELF_TEST, reply: { jobId: 'job_7', accepted: true } },
    ]);
    transport.emit(Evt.JOB_PROGRESS, { jobId: 'ghost', progress: 0.5 });
    transport.emit(Evt.JOB_COMPLETE, { jobId: 'ghost', result: {} });
    transport.emit(Evt.JOB_PROGRESS, { progress: 0.5 }); // malformed: no jobId

    const job = await client.startJob(Cmd.SELF_TEST, {});
    transport.emit(Evt.JOB_COMPLETE, { jobId: 'job_7', result: { ok: true } });
    expect(await job.result).toEqual({ ok: true });
    client.dispose();
  });
});
