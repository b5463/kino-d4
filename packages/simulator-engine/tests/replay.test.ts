// KINO Twin §21: a bug report is one `.kino-sim.json` file + Replay. This
// records a short scripted exchange (HELLO, GET_CAMERA_INFO, a per-camera
// fault injection, CAMERA_STATUS), then proves the recording is a faithful,
// byte-for-byte replayable artifact: verifyReplay reconstructs the same
// outbound bytes from a fresh, identically-seeded device, a single tampered
// recorded byte is caught as a divergence, and idle time an operator leaves
// after the last command (long enough to capture an ambient log tick) still
// replays cleanly rather than reporting a false divergence.
import { describe, expect, it, vi } from 'vitest';
import { Cmd, FrameFlags, PROTOCOL_VERSION, encodeFrame, encodeJson } from '@kino/kdp';
import { parseVersioned } from '@kino/schemas';
import { TwinSimulator } from '../src/TwinSimulator';
import { SimRecorder, simSessionDoc, base64ToBytes } from '../src/recorder';
import type { SimSessionDoc } from '../src/recorder';
import { verifyReplay } from '../src/replay';

// No @types/node in this monorepo (Task 3's history) — compare bytes
// directly instead of via Buffer, which fails `tsc --noEmit` even though it
// runs fine under vitest.
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sendIn(sim: TwinSimulator, recorder: SimRecorder, seq: number, cmd: Cmd, payload: unknown) {
  const bytes = encodeFrame({ version: PROTOCOL_VERSION, type: cmd, flags: FrameFlags.NONE, seq, payload: encodeJson(payload) });
  recorder.noteIn(bytes);
  sim.device.receive(bytes);
}

/**
 * verifyReplay's own `done` promise only resolves once its internally
 * fake-timer-scheduled deliveries fire — under `vi.useFakeTimers()` that
 * requires something to actually advance the clock. `Promise.all` here lets
 * `vi.advanceTimersByTimeAsync` do that concurrently with (not before)
 * verifyReplay's internal `await done`, since a plain sequential await would
 * deadlock: verifyReplay would never return control to advance the clock.
 */
async function runVerify(doc: SimSessionDoc) {
  const [result] = await Promise.all([verifyReplay(doc), vi.advanceTimersByTimeAsync(5_000)]);
  return result;
}

/**
 * Records the brief's scripted exchange under fake timers and returns the
 * finished doc. Every step advances the fake clock by a small, fixed 50 ms —
 * three steps keeps the whole session comfortably under 600 ms, the delay
 * before MockKinoDevice's first ambient log tick (`startAmbient`), so this
 * short session's replay can never pick up an ambient event the original
 * recording didn't also see.
 */
async function recordScriptedSession(): Promise<SimSessionDoc> {
  const sim = new TwinSimulator({ seed: 7 });
  const recorder = new SimRecorder(sim);
  sim.device.attach(
    (bytes) => recorder.noteOut(bytes),
    () => {},
  );

  recorder.start();
  expect(recorder.recording()).toBe(true);

  sendIn(sim, recorder, 1, Cmd.HELLO, { nonce: 1 });
  await vi.advanceTimersByTimeAsync(50);

  sendIn(sim, recorder, 2, Cmd.GET_CAMERA_INFO, {});
  await vi.advanceTimersByTimeAsync(50);

  sim.device.setCamFault('cam3', 'offline');
  sendIn(sim, recorder, 3, Cmd.CAMERA_STATUS, { cam: 'cam3' });
  await vi.advanceTimersByTimeAsync(50);

  const doc = recorder.stop();
  expect(recorder.recording()).toBe(false);

  sim.device.detach();
  sim.dispose();
  return doc;
}

describe('SimRecorder', () => {
  it('records in/out/fault entries with monotonic atMs, and round-trips through parseVersioned', async () => {
    vi.useFakeTimers();
    try {
      const doc = await recordScriptedSession();

      expect(doc.schema).toBe('kino.sim-session');
      expect(doc.version).toBe(1);
      expect(doc.seed).toBe(7);
      expect(typeof doc.startedAtIso).toBe('string');

      const inEvents = doc.events.filter((e) => e.kind === 'in');
      const outEvents = doc.events.filter((e) => e.kind === 'out');
      const faultEvents = doc.events.filter((e) => e.kind === 'fault');
      expect(inEvents).toHaveLength(3);
      expect(outEvents.length).toBeGreaterThan(0);
      expect(
        faultEvents.some(
          (e) => e.kind === 'fault' && e.op === 'camFault' && e.cam === 'cam3' && e.fault === 'offline',
        ),
      ).toBe(true);

      // atMs must be monotonic (non-decreasing) across the whole recording —
      // this is what lets a UI scrub the session in wall-clock order.
      let last = -Infinity;
      for (const e of doc.events) {
        expect(e.atMs).toBeGreaterThanOrEqual(last);
        last = e.atMs;
      }

      // kino.sim-session v1 must survive a real JSON round-trip (a
      // .kino-sim.json file on disk), not just an in-memory object.
      const reparsed = parseVersioned(simSessionDoc, JSON.parse(JSON.stringify(doc)));
      expect(reparsed).toEqual(doc);
    } finally {
      vi.useRealTimers();
    }
  });

  it('verifyReplay reconstructs the recorded session byte-for-byte from a fresh device', async () => {
    vi.useFakeTimers();
    try {
      const doc = await recordScriptedSession();

      const result = await runVerify(doc);
      expect(result.ok).toBe(true);
      expect(result.firstDivergenceAtMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('idle time after the last input still replays byte-for-byte, including a captured ambient log tick', async () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 11 });
      const recorder = new SimRecorder(sim);
      sim.device.attach(
        (bytes) => recorder.noteOut(bytes),
        () => {},
      );
      recorder.start();

      sendIn(sim, recorder, 1, Cmd.HELLO, { nonce: 1 });
      // Well past startAmbient's 600 ms first log tick, with no further
      // input after it — the exact "operator leaves the recorder running"
      // pattern task-8 review finding #1 flagged: idle time after the last
      // command is an ordinary recording, not an exotic one.
      await vi.advanceTimersByTimeAsync(900);

      const doc = recorder.stop();
      sim.device.detach();
      sim.dispose();

      // Confirms this recording actually captured trailing activity after
      // the last input — otherwise this test wouldn't exercise the bug at
      // all (a `lastAtMs` computed from inputs alone would look identical
      // to one computed from every event whenever nothing follows the last
      // input).
      const ambientTickCaptured = doc.events.some((e) => e.kind === 'out' && e.atMs >= 600);
      expect(ambientTickCaptured).toBe(true);

      const result = await runVerify(doc);
      expect(result.ok).toBe(true);
      expect(result.firstDivergenceAtMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a single tampered recorded out-byte is caught as a divergence, not silently replayed', async () => {
    vi.useFakeTimers();
    try {
      const doc = await recordScriptedSession();
      const outIndex = doc.events.findIndex((e) => e.kind === 'out');
      expect(outIndex).toBeGreaterThanOrEqual(0);
      const tamperedEntry = doc.events[outIndex];
      if (tamperedEntry.kind !== 'out') throw new Error('unreachable');

      const bytes = base64ToBytes(tamperedEntry.b64);
      const tamperedBytes = bytes.slice();
      tamperedBytes[0] ^= 0xff; // flip one byte — never fed back to the device either way
      const tamperedB64 = btoa(String.fromCharCode(...tamperedBytes));

      const tamperedDoc: SimSessionDoc = {
        ...doc,
        events: doc.events.map((e, i) => (i === outIndex ? { ...tamperedEntry, b64: tamperedB64 } : e)),
      };

      const result = await runVerify(tamperedDoc);
      expect(result.ok).toBe(false);
      expect(result.firstDivergenceAtMs).toBe(tamperedEntry.atMs);
      // Sanity check the byte comparison itself, independent of verifyReplay.
      expect(bytesEqual(bytes, tamperedBytes)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an empty recording round-trips and replays as a no-op', async () => {
    vi.useFakeTimers();
    try {
      const sim = new TwinSimulator({ seed: 3 });
      const recorder = new SimRecorder(sim);
      recorder.start();
      const doc = recorder.stop();
      sim.dispose();

      expect(doc.events).toEqual([]);
      const reparsed = parseVersioned(simSessionDoc, JSON.parse(JSON.stringify(doc)));
      expect(reparsed).toEqual(doc);

      const result = await runVerify(doc);
      expect(result.ok).toBe(true);
      expect(result.firstDivergenceAtMs).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
