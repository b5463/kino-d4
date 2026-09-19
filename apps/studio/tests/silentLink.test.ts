// A link that stays open while nobody answers (02 §6 "hardware error").
//
// USB CDC on a hung board never closes; a Twin relay whose device let go
// never used to say so. Either way Studio sat on CONNECTED with every poll
// timing out. Three unanswered polls in a row now raise the close the
// transport never will.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';
import { connectTransport, disconnect } from '../src/app/session';
import { setConnection, useConnectionStore } from '../src/state/connectionStore';
import { clearDeviceState, useDeviceStore } from '../src/state/deviceStore';

/**
 * Fake timers from before the connect, not after: the poller's interval is
 * created when the session comes up, and an interval made on the real clock
 * never fires in fake time. The connect itself has a few short timers (boot
 * delay, port-open feel), so it is advanced through rather than awaited cold.
 */
async function connectUnderFakeTimers(mock: MockKinoDevice): Promise<void> {
  vi.useFakeTimers();
  const pending = connectTransport(() => new MockTransport(mock), 'mock');
  await vi.advanceTimersByTimeAsync(6000);
  await pending;
}

afterEach(async () => {
  const pending = disconnect();
  await vi.advanceTimersByTimeAsync(1000).catch(() => {});
  await pending;
  vi.useRealTimers();
  clearDeviceState();
  setConnection({ phase: 'disconnected', fault: null, error: null, transportKind: null });
});

describe('a silent device on an open link', () => {
  it('is reported as a hardware error after three unanswered polls, not left CONNECTED', async () => {
    const mock = new MockKinoDevice();
    await connectUnderFakeTimers(mock);
    expect(useConnectionStore.getState().phase).toBe('connected');

    // The device stops talking without closing anything: its byte sink is
    // gone, so every request from here on times out.
    mock.detach();

    // Poll every 4 s, each read times out after 3 s; the third failure ends it.
    for (let i = 0; i < 4 && useConnectionStore.getState().phase === 'connected'; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(3500);
    }

    const state = useConnectionStore.getState();
    expect(state.phase).toBe('error');
    expect(state.fault).toBe('hardware');
    expect(state.error).toMatch(/stopped answering/i);
    // The close handler cleared device state the way a pulled cable does.
    expect(useDeviceStore.getState().info).toBeNull();
  }, 20_000);

  it('does not count answered polls: a live device stays connected', async () => {
    const mock = new MockKinoDevice();
    await connectUnderFakeTimers(mock);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(useConnectionStore.getState().phase).toBe('connected');
    // Polls ran and answered: the counter that ends a silent link never moved.
    expect(useDeviceStore.getState().poll.failures).toBe(0);
    expect(useDeviceStore.getState().poll.lastOkAt).not.toBeNull();
  }, 20_000);
});
