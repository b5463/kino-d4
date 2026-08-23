import type { Transport } from '../transport/Transport';
import { Cmd, Evt, FrameFlags, PROTOCOL_VERSION } from './commands';
import { FrameDecoder, encodeFrame, nextSeq, encodeJson, decodeJson } from './packet';
import type { Frame } from './packet';
import type {
  HelloRequest,
  HelloResponse,
  JobCompleteEvent,
  JobFailedEvent,
  JobFailure,
  JobProgress,
  JobResult,
  JobStartResponse,
  ProtocolError,
} from './types';

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

export type HandshakeFailure = 'timeout' | 'nonce' | 'protocol';

/** HELLO did not produce a usable session (04 §4). */
export class KinoHandshakeError extends Error {
  readonly reason: HandshakeFailure;
  readonly attempts: number;
  constructor(reason: HandshakeFailure, message: string, attempts: number) {
    super(message);
    this.name = 'KinoHandshakeError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

/** A job the device accepted and then failed (04 §15 JOB_FAILED). */
export class KinoJobError extends Error {
  readonly code: string;
  readonly jobId: string;
  /** The device's error object exactly as it arrived (04 §18). */
  readonly deviceError: JobFailure;
  constructor(jobId: string, deviceError: JobFailure) {
    super(deviceError.message || `Job ${jobId} failed`);
    this.name = 'KinoJobError';
    this.jobId = jobId;
    this.code = deviceError.code || 'JOB_FAILED';
    this.deviceError = deviceError;
  }
}

export interface HelloOptions {
  /** 04 §4: retry up to 3 times. */
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** Oldest protocol this client can still speak. */
  protocolMin?: number;
  /** Newest protocol this client can speak. */
  protocolMax?: number;
  /** Reported to the device so its logs name the peer. */
  clientVersion?: string;
  /**
   * Session ID carried over from the previous connection. Studio builds a
   * fresh client per connection, so without this a reboot during a reconnect
   * would read as a clean first session and never raise sessionChanged.
   */
  knownSessionId?: string | null;
  /** Injection point for tests; production uses a random nonce per attempt. */
  nonce?: () => number;
}

/** The device answered HELLO with a different boot/session ID (04 §17). */
export interface SessionChange {
  previous: string;
  current: string;
  deviceId?: string;
}

/**
 * A running device job. `progress` is single-consumer: it completes when
 * JOB_COMPLETE or JOB_FAILED arrives, and `result` settles at the same moment.
 */
export interface JobHandle<TResult = JobResult> {
  jobId: string;
  progress: AsyncIterable<JobProgress>;
  result: Promise<TResult>;
}

type JobOutcome =
  | { kind: 'complete'; result: JobResult }
  | { kind: 'failed'; error: JobFailure };

interface JobRecord {
  queue: JobProgress[];
  waiters: ((r: IteratorResult<JobProgress>) => void)[];
  finished: boolean;
  resolve: (value: JobResult) => void;
  reject: (err: Error) => void;
}

/** Job events that arrived before their caller registered the jobId. */
interface OrphanEvents {
  progress: JobProgress[];
  outcome: JobOutcome | null;
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
  /** Idempotent reads re-sent after a timeout (one retry each, fresh seq). */
  readRetries: number;
  /** CRC-valid frames dropped for carrying a frame VERSION this client does
   * not speak. The decoder surfaces the version untouched (its documented
   * contract); the client is the layer that decides what it accepts. */
  versionRejects: number;
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
const READ_RETRY_DELAY_MS = 60;
/**
 * Commands that read device state without changing it. Only these retry on a
 * timeout — a lost read costs one round trip; a doubled mutation costs
 * correctness. HELLO has its own retry ladder and is deliberately absent.
 */
const RETRYABLE_READS: ReadonlySet<Cmd> = new Set([
  Cmd.GET_DEVICE_INFO,
  Cmd.GET_CAMERA_INFO,
  Cmd.GET_POWER_STATUS,
  Cmd.GET_STORAGE_STATUS,
  Cmd.GET_CAPABILITIES,
  Cmd.GET_CONFIG,
  Cmd.GET_MODES,
  Cmd.GET_RECIPES,
  Cmd.GET_SOUNDS,
  Cmd.CAMERA_STATUS,
  Cmd.GET_LOGS,
  Cmd.GET_RUNTIME_STATS,
  Cmd.FW_QUERY,
  Cmd.FW_STATUS,
  Cmd.MEDIA_LIST,
  Cmd.MEDIA_INFO,
  Cmd.NETWORK_LIST,
  Cmd.NETWORK_STATUS,
  Cmd.ROLL_STATUS,
  Cmd.UPLOAD_QUEUE_STATUS,
]);
const HELLO_ATTEMPTS = 3;
const HELLO_TIMEOUT_MS = 500;
const HELLO_RETRY_MS = 150;
/**
 * Cap on jobIds whose events arrived before anyone claimed them. A device that
 * streams events for jobs this client never started must not grow the map
 * without bound; the oldest entry is dropped.
 */
const ORPHAN_JOBS_MAX = 32;
/**
 * Cap on buffered progress per unclaimed jobId. Bounding the number of buckets
 * is not enough: one chatty job whose start reply never arrived would retain
 * every update it ever sent. The newest are kept — they are what a UI shows.
 */
const ORPHAN_PROGRESS_MAX = 16;
/**
 * Tombstones for jobIds that already settled. A trailing or retransmitted
 * event must not be buffered under a settled ID, or the next job that reuses
 * that ID (a rebooted device restarting at job_1) inherits the old run's
 * result. Bounded like everything else here.
 */
const SETTLED_JOBS_MAX = 32;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomNonce = () => Math.floor(Math.random() * 0xffffffff);

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
  private sessionHandlers = new Set<(change: SessionChange) => void>();
  /** Live jobs only — a record leaves this map the moment it settles. */
  private readonly jobs = new Map<string, JobRecord>();
  private readonly orphanJobs = new Map<string, OrphanEvents>();
  private readonly settledJobs = new Set<string>();
  private session: string | null = null;
  private protocol: number | null = null;
  private seq = 1;
  private closed = false;

  readonly stats: ClientStats = {
    txFrames: 0,
    rxFrames: 0,
    rxEvents: 0,
    crcFailures: 0,
    timeouts: 0,
    resyncs: 0,
    readRetries: 0,
    versionRejects: 0,
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
    // Job events go through the normal event fan-out, so an app can still
    // subscribe to them directly for a raw protocol view.
    this.onEvent<JobProgress>(Evt.JOB_PROGRESS, (p) => {
      if (p && typeof p.jobId === 'string') this.deliverProgress(p);
    });
    this.onEvent<JobCompleteEvent>(Evt.JOB_COMPLETE, (e) => {
      if (e && typeof e.jobId === 'string') {
        this.settleJob(e.jobId, { kind: 'complete', result: e.result ?? {} });
      }
    });
    this.onEvent<JobFailedEvent>(Evt.JOB_FAILED, (e) => {
      if (e && typeof e.jobId === 'string') {
        this.settleJob(e.jobId, {
          kind: 'failed',
          error: e.error ?? { code: 'JOB_FAILED', message: `Job ${e.jobId} failed` },
        });
      }
    });
  }

  get transportKind() {
    return this.transport.kind;
  }

  /** Boot/session ID of the connected device (04 §17), null before HELLO. */
  get sessionId(): string | null {
    return this.session;
  }

  /** Protocol selected by the device during HELLO, null before HELLO. */
  get negotiatedProtocol(): number | null {
    return this.protocol;
  }

  /** Fires when HELLO reports a different boot/session ID than last seen. */
  onSessionChanged(handler: (change: SessionChange) => void): () => void {
    this.sessionHandlers.add(handler);
    return () => this.sessionHandlers.delete(handler);
  }

  /**
   * Handshake (04 §4). Offers a protocol range, a fresh nonce per attempt and
   * the client version; the device answers with the protocol it selected, the
   * nonce echo and its boot/session ID.
   *
   * Silence and a mismatched nonce are both retried — an ESP32 that is still
   * printing its boot banner, and a stale reply left in the serial buffer, are
   * the two ways a first HELLO normally fails, and both clear on the next try.
   * A protocol outside the offered range is final: retrying cannot change it.
   */
  async hello(options: HelloOptions = {}): Promise<HelloResponse> {
    const attempts = options.attempts ?? HELLO_ATTEMPTS;
    const timeoutMs = options.timeoutMs ?? HELLO_TIMEOUT_MS;
    const retryDelayMs = options.retryDelayMs ?? HELLO_RETRY_MS;
    const protocolMin = options.protocolMin ?? PROTOCOL_VERSION;
    const protocolMax = options.protocolMax ?? PROTOCOL_VERSION;
    const nextNonce = options.nonce ?? randomNonce;
    if (options.knownSessionId !== undefined) this.session = options.knownSessionId;

    let reason: HandshakeFailure = 'timeout';
    let detail = 'device stayed silent';

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const nonce = nextNonce();
      const request: HelloRequest = {
        protocolMin,
        protocolMax,
        nonce,
        client: options.clientVersion ?? null,
      };

      let res: HelloResponse;
      try {
        res = await this.request<HelloResponse>(Cmd.HELLO, request, timeoutMs);
      } catch (err) {
        if (!(err instanceof KinoTimeoutError)) throw err;
        reason = 'timeout';
        detail = 'device stayed silent';
        if (attempt < attempts) await sleep(retryDelayMs);
        continue;
      }

      // Nonce echo. Firmware that omits it is tolerated; firmware that echoes
      // the wrong one is answering an older request, so the reply proves
      // nothing about the device being alive right now.
      if (res.nonce !== undefined && res.nonce !== nonce) {
        reason = 'nonce';
        detail = `reply echoed nonce ${res.nonce}, expected ${nonce}`;
        if (attempt < attempts) await sleep(retryDelayMs);
        continue;
      }

      if (typeof res.protocol !== 'number' || res.protocol < protocolMin || res.protocol > protocolMax) {
        throw new KinoHandshakeError(
          'protocol',
          `Device selected protocol ${res.protocol}; this client speaks ${protocolMin}..${protocolMax}`,
          attempt,
        );
      }

      this.protocol = res.protocol;
      this.noteSession(res);
      return res;
    }

    throw new KinoHandshakeError(
      reason,
      `No usable HELLO reply after ${attempts} attempts — ${detail}`,
      attempts,
    );
  }

  private noteSession(res: HelloResponse) {
    if (res.sessionId === undefined || res.sessionId === null) return; // pre-§17 firmware
    const current = String(res.sessionId);
    const previous = this.session;
    this.session = current;
    if (previous === null || previous === current) return;
    // A new boot ID is proof every job from the old session died with it —
    // including one still in flight over a port that never dropped. Tear them
    // down before anyone reacts to the change and starts new work.
    this.failAllJobs('SESSION_CHANGED', `Device restarted (session ${previous} → ${current})`);
    const change: SessionChange = { previous, current, deviceId: res.deviceId };
    for (const handler of this.sessionHandlers) handler(change);
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

  /**
   * Send a JSON command and decode the JSON response.
   *
   * Idempotent reads retry once on timeout (fresh sequence number, so a late
   * answer to the first attempt is dropped, never mistaken for the second).
   * Everything else stays one-shot: a NACK is a definitive answer, and
   * retrying a mutation invents at-least-once semantics the firmware
   * contract never promised.
   */
  async request<TRes>(cmd: Cmd, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TRes> {
    const body = encodeJson(payload);
    try {
      return decodeJson<TRes>(await this.requestRaw(cmd, body, FrameFlags.NONE, timeoutMs));
    } catch (err) {
      if (!(err instanceof KinoTimeoutError) || !RETRYABLE_READS.has(cmd) || this.closed) throw err;
      this.stats.readRetries++;
      await new Promise((r) => setTimeout(r, READ_RETRY_DELAY_MS));
      return decodeJson<TRes>(await this.requestRaw(cmd, body, FrameFlags.NONE, timeoutMs));
    }
  }

  /**
   * Start a long-running device job (04 §15) — calibration, firmware, stress
   * tests, storage checks, exports. The command answers { jobId, accepted }
   * immediately; everything after that arrives as JOB_* events routed by jobId.
   */
  async startJob<TResult = JobResult>(
    cmd: Cmd,
    payload?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<JobHandle<TResult>> {
    const started = await this.request<JobStartResponse>(cmd, payload, timeoutMs);
    if (!started || typeof started.jobId !== 'string' || started.accepted === false) {
      throw new KinoCommandError(
        'JOB_NOT_ACCEPTED',
        `${Cmd[cmd] ?? cmd} did not start a job`,
      );
    }
    return this.registerJob<TResult>(started.jobId);
  }

  private registerJob<TResult>(jobId: string): JobHandle<TResult> {
    let resolve!: (value: JobResult) => void;
    let reject!: (err: Error) => void;
    const result = new Promise<JobResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A caller may watch progress and never await the result. Keeping the
    // rejection handled here is what stops that from killing the process.
    void result.catch(() => {});

    // Anything still in this map under that ID is live (settled records leave
    // it), so the device handed out an ID that is already in flight. Whatever
    // it reports next belongs to the new run, and the old handle can never be
    // reported on again — end it rather than leave its consumer hanging.
    if (this.jobs.has(jobId)) {
      this.settleJob(jobId, {
        kind: 'failed',
        error: { code: 'JOB_SUPERSEDED', message: `Job ${jobId} was restarted by the device` },
      });
    }
    // A new job legitimately claims this ID, so its tombstone goes.
    this.settledJobs.delete(jobId);

    const record: JobRecord = { queue: [], waiters: [], finished: false, resolve, reject };
    this.jobs.set(jobId, record);

    // Events routinely beat this registration: the device can pack the reply
    // and the first progress event into one read, and the reply only resumes
    // this function a microtask later. Nothing from a *previous* run can be
    // waiting here — settled IDs never get a bucket.
    const orphan = this.orphanJobs.get(jobId);
    if (orphan) {
      this.orphanJobs.delete(jobId);
      for (const p of orphan.progress) this.deliverProgress(p);
      if (orphan.outcome) this.settleJob(jobId, orphan.outcome);
    }

    return {
      jobId,
      progress: this.progressIterable(record),
      result: result as Promise<TResult>,
    };
  }

  private progressIterable(record: JobRecord): AsyncIterable<JobProgress> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<JobProgress>> => {
          if (record.queue.length > 0) {
            return Promise.resolve({ value: record.queue.shift()!, done: false });
          }
          if (record.finished) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<JobProgress>>((r) => record.waiters.push(r));
        },
        return: (): Promise<IteratorResult<JobProgress>> => {
          // Abandoning the stream does not cancel the job; result still settles.
          record.waiters.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }

  private orphanBucket(jobId: string): OrphanEvents {
    let bucket = this.orphanJobs.get(jobId);
    if (!bucket) {
      if (this.orphanJobs.size >= ORPHAN_JOBS_MAX) {
        const oldest = this.orphanJobs.keys().next().value;
        if (oldest !== undefined) this.orphanJobs.delete(oldest);
      }
      bucket = { progress: [], outcome: null };
      this.orphanJobs.set(jobId, bucket);
    }
    return bucket;
  }

  /** Remember a settled jobId, evicting the oldest tombstone past the cap. */
  private markSettled(jobId: string) {
    this.settledJobs.delete(jobId);
    this.settledJobs.add(jobId);
    while (this.settledJobs.size > SETTLED_JOBS_MAX) {
      const oldest = this.settledJobs.values().next().value;
      if (oldest === undefined) break;
      this.settledJobs.delete(oldest);
    }
  }

  private deliverProgress(p: JobProgress) {
    const record = this.jobs.get(p.jobId);
    if (!record) {
      if (this.settledJobs.has(p.jobId)) return; // trailing event; that job is over
      const bucket = this.orphanBucket(p.jobId);
      bucket.progress.push(p);
      if (bucket.progress.length > ORPHAN_PROGRESS_MAX) bucket.progress.shift();
      return;
    }
    const waiter = record.waiters.shift();
    if (waiter) waiter({ value: p, done: false });
    else record.queue.push(p);
  }

  private settleJob(jobId: string, outcome: JobOutcome) {
    const record = this.jobs.get(jobId);
    if (!record) {
      // A duplicate or late JOB_COMPLETE for a job that already settled must
      // not be parked in a bucket: the next run to use this ID would drain it
      // and report the previous run's result as its own.
      if (this.settledJobs.has(jobId)) return;
      this.orphanBucket(jobId).outcome = outcome;
      return;
    }
    this.jobs.delete(jobId);
    this.markSettled(jobId);
    record.finished = true; // the iterator's terminal flag
    // Anything still queued is delivered by next() before it reports done.
    for (const waiter of record.waiters) waiter({ value: undefined, done: true });
    record.waiters.length = 0;
    if (outcome.kind === 'complete') record.resolve(outcome.result);
    else record.reject(new KinoJobError(jobId, outcome.error));
  }

  /**
   * End every live job with the same error and drop unclaimed buffers. Used
   * when the connection or the device session underneath the jobs is gone —
   * they can never report again, and a progress iterable left open hangs
   * whatever is rendering it.
   */
  private failAllJobs(code: string, message: string) {
    for (const jobId of [...this.jobs.keys()]) {
      this.settleJob(jobId, { kind: 'failed', error: { code, message } });
    }
    this.orphanJobs.clear();
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
    const seq = this.seq;
    this.seq = nextSeq(seq);
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
    if (frame.version !== PROTOCOL_VERSION) {
      // A CRC-valid frame in a dialect this client does not speak. Parsing
      // its payload by v1 rules would be a guess; drop it and count it.
      this.stats.versionRejects++;
      return;
    }
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

  /** Fail all in-flight requests and jobs, and stop accepting new ones. */
  dispose(reason = 'Connection closed') {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.failAllJobs('DISCONNECTED', reason);
    this.settledJobs.clear();
    this.eventHandlers.clear();
    this.sessionHandlers.clear();
  }
}
