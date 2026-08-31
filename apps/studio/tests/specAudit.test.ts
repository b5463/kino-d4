// Spec-audit sweep (Task 13) — the 02/07 checklist items that had no test.
//
// Each `describe` below is one row of `docs/studio-spec-audit.md`. Rows the
// audit found ALREADY PRESENT are cited there by file:line and are not
// re-tested here; what is left is the behaviour this task had to build, so
// every test in this file is the evidence column for a gap that was closed.
//
// Environment is node (see vitest.config.ts), so anything rendered goes
// through `react-dom/server` and every component under test takes its data as
// props — the same rule the Roll panels follow.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { CaptureSummary } from '@kino/kdp';
import { MockKinoDevice } from '@kino/test-fixtures';

import { KinoDevice } from '../src/device/KinoDevice';
import { parseCubeLut, DEVICE_LUT_SIZE } from '../src/recipes/cubeLut';
import {
  PHASE_LABEL,
  canStartConnection,
  connectionStrip,
  connectionNotice,
  setConnection,
  useConnectionStore,
} from '../src/state/connectionStore';
import {
  connectTransport,
  disconnect,
  getDevice,
  isSameCamera,
  isSimulated,
  recheckSession,
} from '../src/app/session';
import { clearLogs, useLogStore } from '../src/state/logStore';
import { putDraftEntry, setDraftDirty, useDraftStore } from '../src/state/draftStore';
import { getBenchResult, putBenchResult, resetBenchResults } from '../src/state/benchResults';
import type { ConnectionFault, ConnectionPhase } from '../src/state/connectionStore';
import { ConnectionNotice } from '../src/components/ConnectionNotice';
import { ConnectionStrip } from '../src/components/ConnectionStrip';
import {
  GALLERY_LIST_CAP,
  GALLERY_PAGE_SIZE,
  galleryPageSlice,
  galleryView,
  nextGalleryListLimit,
} from '../src/pages/Gallery/galleryPaging';
import { clearDeviceState, setDeviceState, supports, useDeviceStore } from '../src/state/deviceStore';
import { navItems } from '../src/components/Sidebar';
import type { Capabilities } from '@kino/kdp';

let transport: MockTransport | null = null;

async function connectMock(mock = new MockKinoDevice()) {
  transport = new MockTransport(mock);
  await transport.open();
  return { mock, device: new KinoDevice(new KinoProtocolClient(transport)) };
}

/**
 * The simulator behind the *session* tests below, as opposed to the raw
 * client `connectMock` above. Studio no longer owns a simulator of its own
 * (issue #110), so this file keeps the instance and drives it through the
 * `connectTransport` seam. One instance for the whole module is deliberate:
 * the session-restart and protocol-mismatch tests reconnect to the *same*
 * device and assert on what carried over.
 */
let sessionSim: MockKinoDevice | null = null;

async function connectSessionSim(): Promise<void> {
  sessionSim ??= new MockKinoDevice();
  await connectTransport(() => new MockTransport(sessionSim!), 'mock');
}

afterEach(async () => {
  await transport?.close();
  transport = null;
  clearDeviceState();
  setConnection({ phase: 'disconnected', fault: null, error: null, transportKind: null });
});

// ---------------------------------------------------------------------------
// 02 §14 — LUT support: `.cube` import, 17×17×17 device LUT
// ---------------------------------------------------------------------------

/**
 * A real `.cube` file, generated rather than pasted: at 17³ the data block is
 * 4,913 lines, and the point of the fixture is the size, not the numbers. The
 * ramp is the identity transform, so a parse can be checked entry by entry.
 */
function syntheticCube(size: number, title = 'KINO Bench Ramp'): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0', ''];
  const last = size - 1;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${(r / last).toFixed(6)} ${(g / last).toFixed(6)} ${(b / last).toFixed(6)}`);
      }
    }
  }
  return lines.join('\n');
}

describe('02 §14 — .cube LUT import', () => {
  it('parses a 17×17×17 cube into a Float32Array of RGB triplets', () => {
    const lut = parseCubeLut(syntheticCube(DEVICE_LUT_SIZE));

    expect(lut.title).toBe('KINO Bench Ramp');
    expect(lut.size).toBe(17);
    expect(lut.data).toBeInstanceOf(Float32Array);
    expect(lut.data.length).toBe(17 * 17 * 17 * 3);

    // Red runs fastest — entry 0 is black, entry 1 is one red step.
    expect([lut.data[0], lut.data[1], lut.data[2]]).toEqual([0, 0, 0]);
    expect(lut.data[3]).toBeCloseTo(1 / 16, 5);
    // And the last entry is white.
    const end = lut.data.length - 3;
    expect(lut.data[end]).toBeCloseTo(1, 5);
    expect(lut.data[end + 2]).toBeCloseTo(1, 5);
  });

  it('takes a cube with comments, blank lines and CRLF endings', () => {
    const body = syntheticCube(DEVICE_LUT_SIZE)
      .split('\n')
      .flatMap((line, i) => (i === 0 ? ['# exported by some grading app', '', line] : [line]))
      .join('\r\n');
    expect(parseCubeLut(body).data.length).toBe(17 * 17 * 17 * 3);
  });

  it('rejects a cube that is not 17×17×17 and says what KINO wants', () => {
    expect(() => parseCubeLut(syntheticCube(33))).toThrow(/33×33×33/);
    expect(() => parseCubeLut(syntheticCube(33))).toThrow(/17×17×17/);
  });

  it('rejects a 1D LUT rather than reading its rows as a cube', () => {
    const text = ['TITLE "curve"', 'LUT_1D_SIZE 32', '0.0 0.0 0.0', '1.0 1.0 1.0'].join('\n');
    expect(() => parseCubeLut(text)).toThrow(/1D/);
  });

  it('rejects a file with no LUT_3D_SIZE at all', () => {
    expect(() => parseCubeLut('0.0 0.0 0.0\n1.0 1.0 1.0\n')).toThrow(/LUT_3D_SIZE/);
  });

  it('rejects a truncated data block and states both counts', () => {
    const full = syntheticCube(DEVICE_LUT_SIZE).split('\n');
    const short = full.slice(0, full.length - 10).join('\n');
    expect(() => parseCubeLut(short)).toThrow(/4913/);
    expect(() => parseCubeLut(short)).toThrow(/4903/);
  });

  it('rejects a row that is not three numbers', () => {
    const rows = syntheticCube(DEVICE_LUT_SIZE).split('\n');
    rows[8] = '0.5 not-a-number 0.5';
    expect(() => parseCubeLut(rows.join('\n'))).toThrow(/Line 9/);
  });
});

// ---------------------------------------------------------------------------
// 02 §6 — the connection strip covers all nine states
// ---------------------------------------------------------------------------

/** The nine states 02 §6 names, in spec order, with what Studio must print. */
const NINE_STATES: [string, ConnectionPhase, ConnectionFault | null, string][] = [
  ['Connected', 'connected', null, 'KINO CONNECTED'],
  ['Connecting', 'connecting', null, 'CONNECTING…'],
  ['Reconnecting', 'reconnecting', null, 'RECONNECTING…'],
  ['Maintenance', 'maintenance', null, 'MAINTENANCE'],
  ['Updating', 'updating', null, 'UPDATING'],
  ['Recovery', 'recovery', null, 'RECOVERY NEEDED'],
  ['Disconnected', 'disconnected', null, 'DISCONNECTED'],
  ['Protocol mismatch', 'error', 'protocol-mismatch', 'PROTOCOL MISMATCH'],
  ['Hardware error', 'error', 'hardware', 'HARDWARE ERROR'],
];

describe('02 §6 — connection strip states', () => {
  it.each(NINE_STATES)('names the %s state', (_spec, phase, fault, label) => {
    expect(connectionStrip(phase, fault).label).toBe(label);
  });

  /**
   * `ConnectionStrip` is the lamp both strips render — the sidebar footer
   * (Sidebar.tsx) and the bottom status bar (StatusBar.tsx) — so covering it
   * covers both. It takes props: zustand hands `renderToStaticMarkup` its
   * *initial* state, so a store-driven component cannot be driven from here.
   */
  it.each(NINE_STATES)('renders the %s state as lamp + words', (_spec, phase, fault, label) => {
    const html = renderToStaticMarkup(createElement(ConnectionStrip, { phase, fault }));
    expect(html).toContain(label);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    // State is never colour alone: the lamp always ships with its words.
    expect(html).toContain('led-label');
    expect(html).toContain(`led--${connectionStrip(phase, fault).led}`);
  });

  it('gives a fault its own lamp rather than a bare ERROR', () => {
    expect(connectionStrip('error', 'protocol-mismatch').led).toBe('err');
    expect(connectionStrip('error', 'hardware').led).toBe('err');
    expect(connectionStrip('error', null).label).toBe(PHASE_LABEL.error);
    expect(connectionStrip('recovery', null).led).toBe('err');
  });

  /**
   * The toolbar's device cell is the third strip, and it had its own private
   * lamp mapping: on a protocol mismatch the status bar said PROTOCOL MISMATCH
   * while the toolbar 40 px above said ERROR, and in recovery its lamp was off
   * while the other two were red. It renders the shared component now, with
   * the label dropped in the connected state only — the serial sits beside it
   * there and would say the same thing twice.
   */
  it.each(NINE_STATES)('names the %s state in the toolbar cell too', (_spec, phase, fault, label) => {
    const html = renderToStaticMarkup(
      createElement(ConnectionStrip, { phase, fault, silentWhenConnected: true }),
    );
    expect(html).toContain(`led--${connectionStrip(phase, fault).led}`);
    if (phase === 'connected') {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain('<span class="kino-status-label led-label"></span>');
    } else {
      expect(html).toContain(label);
    }
  });

  it('drops the toolbar wording only where the serial repeats it', () => {
    // The one state where the serial beside the lamp already says it.
    expect(
      renderToStaticMarkup(
        createElement(ConnectionStrip, { phase: 'connected' as const, fault: null, silentWhenConnected: true }),
      ),
    ).toContain('aria-label="KINO CONNECTED"');
    // Maintenance was an unlabelled amber lamp in the toolbar before this.
    expect(
      renderToStaticMarkup(
        createElement(ConnectionStrip, { phase: 'maintenance' as const, fault: null, silentWhenConnected: true }),
      ),
    ).toContain('MAINTENANCE');
  });
});

// ---------------------------------------------------------------------------
// 02 §6 — the `recovery` phase, swept through its consumers
// ---------------------------------------------------------------------------

describe('02 §6 — recovery phase consumers', () => {
  /**
   * A failed reboot used to land in `error`, where a new connection was
   * offered. Adding a phase silently took that away — from the one state
   * where a user is most likely to want to reach for a simulated camera.
   * This also gates Twin discovery, so losing it hides Twin entirely.
   */
  it('still allows a new connection in recovery', () => {
    expect(canStartConnection('recovery')).toBe(true);
    expect(canStartConnection('disconnected')).toBe(true);
    expect(canStartConnection('error')).toBe(true);
    for (const phase of ['connected', 'maintenance', 'updating', 'reconnecting', 'handshaking', 'connecting', 'requesting-port'] as const) {
      expect(canStartConnection(phase), `${phase} has a live session`).toBe(false);
    }
  });

  it('marks bench results stale when the board never came back', () => {
    resetBenchResults();
    setConnection({ phase: 'connected', fault: null });
    putBenchResult('timing', { spreadUs: 1730 });
    expect(getBenchResult('timing')?.staleReason).toBeNull();

    setConnection({ phase: 'recovery', fault: null });
    expect(getBenchResult('timing')?.staleReason).toBe('the link dropped after this run');
    resetBenchResults();
  });

  it('still marks them stale on the states that already did', () => {
    for (const phase of ['disconnected', 'error'] as const) {
      resetBenchResults();
      setConnection({ phase: 'connected', fault: null });
      putBenchResult('timing', { spreadUs: 1730 });
      setConnection({ phase, fault: null });
      expect(getBenchResult('timing')?.staleReason).not.toBeNull();
    }
    resetBenchResults();
  });
});

// ---------------------------------------------------------------------------
// 07 §14 — capability acceptance
// ---------------------------------------------------------------------------

describe('07 §14 — capability acceptance', () => {
  /**
   * A future camera will advertise flags this build has never heard of. The
   * gate reads flags by name, so unknown ones must be inert — not a parse
   * failure, not a nav item, not a crash.
   */
  it('tolerates unknown capability fields from a newer camera', async () => {
    const { device } = await connectMock();
    const caps = await device.getCapabilities();
    const fromTheFuture = {
      ...caps.capabilities,
      depthSensor: true,
      lensCount: 6,
      colorScience: { profile: 'kino-2' },
      rawCapture: ['dng', 'raw12'],
    } as unknown as Capabilities;

    setDeviceState({ capabilities: fromTheFuture });
    const state = useDeviceStore.getState();

    // Known flags still read correctly next to the unknown ones.
    expect(supports(state, 'customSounds')).toBe(true);
    expect(supports(state, 'linkBench')).toBe(true);
    // An unknown flag is neither trusted nor fatal — it simply is not a gate.
    const flags = { developerMode: false, rollUpload: true, gallery: true, wiggle: true, quad: true };
    expect(() => navItems(flags)).not.toThrow();
    expect(navItems(flags).map((i) => i.id)).toContain('roll');
    // The unknown fields survive the round trip into the store rather than
    // being stripped or throwing, and the gate reads them by its ordinary
    // rule — boolean if the device sent one, "assume present" otherwise.
    expect((state.capabilities as unknown as Record<string, unknown>).lensCount).toBe(6);
    expect(supports(state, 'depthSensor' as never)).toBe(true);
    expect(supports(state, 'colorScience' as never)).toBe(true);
  });

  /**
   * Fail-closed gate (audit #58). Three ways to have no loaded set, three
   * different answers: legacy firmware NACKed the command — deliberate
   * everything-on fallback; the query timed out — a device that never
   * answered gets nothing; nothing connected — nothing granted.
   */
  it('grants nothing when the capability query never answered, everything on a legacy NACK', () => {
    setDeviceState({ capabilities: null, capabilitiesState: 'unknown' });
    let state = useDeviceStore.getState();
    expect(supports(state, 'flashControl')).toBe(false);
    expect(supports(state, 'customSounds')).toBe(false);

    setDeviceState({ capabilities: null, capabilitiesState: 'legacy' });
    state = useDeviceStore.getState();
    expect(supports(state, 'flashControl')).toBe(true);
    expect(supports(state, 'linkBench')).toBe(true);

    setDeviceState({ capabilities: null, capabilitiesState: null });
    state = useDeviceStore.getState();
    expect(supports(state, 'flashControl')).toBe(false);
  });

  /**
   * A loaded set that omits a KNOWN flag (audit #CN-3). This is not a
   * hypothetical: the shipped 0.2.0 profile reports no `roll` and no
   * `recipes`, and the gate used to read both omissions as permission, which
   * put a live Roll page in front of a body that NACKs the whole family.
   */
  it('reads a known flag the device omitted as no, and an unknown one as inert', () => {
    setDeviceState({
      capabilities: {
        cameraCount: 4,
        wiggle: true,
        quad: true,
        gallery: true,
        flashControl: false,
        vsyncTelemetry: false,
        phaseCalibration: false,
        xiaoProxyUpdate: false,
        linkBench: false,
        customSounds: false,
        // roll, rollUpload, network, recipes and benchDiagnostics: not sent.
      },
      capabilitiesState: 'loaded',
    });
    const state = useDeviceStore.getState();

    expect(supports(state, 'roll')).toBe(false);
    expect(supports(state, 'rollUpload')).toBe(false);
    expect(supports(state, 'network')).toBe(false);
    expect(supports(state, 'recipes')).toBe(false);
    expect(supports(state, 'benchDiagnostics')).toBe(false);
    // What the device did send is still respected, in both directions.
    expect(supports(state, 'wiggle')).toBe(true);
    expect(supports(state, 'flashControl')).toBe(false);
    // The one true-on-absent flag: firmware older than 0.4.9 never answered
    // the question, and greying the slider would invent a limit (D11/D19).
    expect(supports(state, 'brightnessControl')).toBe(true);
    // A name this build has never heard of is not a gate and does not close one.
    expect(supports(state, 'lidar' as never)).toBe(true);
  });

  it('renders a version-mismatch banner when the camera speaks another protocol', () => {
    const detail = 'Device selected protocol 4; this client speaks 1..1';
    const notice = connectionNotice('error', 'protocol-mismatch', detail);
    expect(notice).not.toBeNull();

    const html = renderToStaticMarkup(
      createElement(ConnectionNotice, { phase: 'error' as const, fault: 'protocol-mismatch' as const, error: detail }),
    );
    expect(html).toContain('PROTOCOL MISMATCH');
    expect(html).toContain(detail);
    // 02 §31: say what to do, not just that something broke.
    expect(html.toLowerCase()).toContain('update');
  });

  it('points a camera that never came back at the recovery procedure', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectionNotice, {
        phase: 'recovery' as const,
        fault: null,
        error: 'KINO did not come back after reboot. Check the cable and reconnect.',
      }),
    );
    expect(html).toContain('RECOVERY NEEDED');
    // The ROM-loader procedure lives in the notice itself — the old text
    // pointed at Updates › Advanced Recovery, which needs a session this
    // state never has (issue #86).
    expect(html).toContain('esptool.py');
    expect(html).toContain('hold BOOT');
  });

  it('says nothing at all in the states that are not faults', () => {
    expect(connectionNotice('connected', null, null)).toBeNull();
    expect(connectionNotice('disconnected', null, null)).toBeNull();
    expect(
      renderToStaticMarkup(
        createElement(ConnectionNotice, { phase: 'connected' as const, fault: null, error: null }),
      ),
    ).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 02 §5 / §32 — the live handshake (carried ledger item from Task 7)
// ---------------------------------------------------------------------------

/**
 * Studio's connect sequence used to run its own HELLO loop, which meant it
 * never compared the device's boot/session ID across a reconnect: a camera
 * that rebooted looked like the same one, and drafts edited against the old
 * run stayed live. The loop now runs in `@kino/kdp`, which owns the retry,
 * nonce and session machinery — this is the end-to-end proof of the last part.
 */
/**
 * Issue #110. Removing Studio's demo device made this load-bearing: the Roll
 * page lets a session create a Roll on the camera alone, with no Roll server,
 * only when it is talking to a simulator — the reference device mints its own
 * guest URL, so the whole QR flow can be shown. That gate used to ask "is
 * this the demo transport", which was false for KINO Twin, so a Twin session
 * silently could not start a Roll at all. It now asks "is this anything other
 * than a camera on a wire".
 */
describe('#110 — the device-only Roll gate covers Twin, not just the old demo', () => {
  afterEach(async () => {
    await disconnect();
  });

  it('reports a Twin session as simulated', async () => {
    await connectTransport(() => new MockTransport(new MockKinoDevice()), 'twin');
    expect(useConnectionStore.getState().transportKind).toBe('twin');
    expect(isSimulated()).toBe(true);
  }, 20000);

  it('does not call a serial session simulated', async () => {
    await connectTransport(() => new MockTransport(new MockKinoDevice()), 'serial');
    expect(isSimulated()).toBe(false);
  }, 20000);

  it('reports no session as not simulated', async () => {
    await disconnect();
    expect(isSimulated()).toBe(false);
  });
});

describe('02 §5/§32 — session-change detection on the live path', () => {
  afterEach(async () => {
    await disconnect();
    clearLogs();
  });

  it('notices the camera rebooted under it and drops what it had cached', async () => {
    clearLogs();
    await connectSessionSim();
    expect(useConnectionStore.getState().phase).toBe('connected');

    const demo = sessionSim;
    expect(demo).not.toBeNull();
    const before = demo!.currentSessionId();

    // The camera restarts on its own. Nothing asked it to, so the link drop
    // is a fault, not an expected reboot (02 §6 "Hardware error").
    demo!.setScenario('sessionRestart', true);
    await vi.waitFor(() => expect(useConnectionStore.getState().phase).toBe('error'), {
      timeout: 10000,
    });
    expect(useConnectionStore.getState().fault).toBe('hardware');

    // Reconnecting to the same camera: same port, same everything except the
    // boot ID, which is the only thing that says the state is stale.
    await connectSessionSim();
    expect(useConnectionStore.getState().phase).toBe('connected');
    const after = demo!.currentSessionId();
    expect(after).not.toBe(before);

    const said = useLogStore
      .getState()
      .entries.filter((e) => e.msg.includes('camera restarted'));
    expect(said).toHaveLength(1);
    expect(said[0].msg).toContain(before);
    expect(said[0].msg).toContain(after);
  }, 60000);

  it('notices a soft restart even when the transport remains open', async () => {
    clearLogs();
    await connectSessionSim();
    expect(useConnectionStore.getState().phase).toBe('connected');

    const demo = sessionSim!;
    const before = demo.currentSessionId();
    putDraftEntry('shoot', { draft: { jpegQuality: 72 }, base: { jpegQuality: 85 } });
    setDraftDirty('shoot', 'Shoot');

    demo.restartSessionInPlace();
    expect(useConnectionStore.getState().phase).toBe('connected');
    await recheckSession();

    expect(demo.currentSessionId()).not.toBe(before);
    expect(useLogStore.getState().entries.filter((e) => e.msg.includes('camera restarted'))).toHaveLength(1);
    expect(useDraftStore.getState().entries).toEqual({});
    expect(useDraftStore.getState().dirty).toEqual({});
  }, 60000);

  /**
   * The other half: a boot ID that changed while Studio was not attached is
   * not news. The user disconnected deliberately, which already dropped every
   * draft, sound and bench claim — and whatever is plugged in next may not
   * even be the same camera.
   */
  it('says nothing about a restart after a deliberate disconnect', async () => {
    await connectSessionSim();
    expect(useConnectionStore.getState().phase).toBe('connected');
    const before = sessionSim!.currentSessionId();

    await disconnect();
    expect(useConnectionStore.getState().phase).toBe('disconnected');
    clearLogs();

    // Whatever gets connected next boots fresh — a different unit, or the same
    // one power-cycled on the bench. Either way this is a first session.
    sessionSim!.setScenario('sessionRestart', true);
    await connectSessionSim();
    expect(useConnectionStore.getState().phase).toBe('connected');
    expect(sessionSim!.currentSessionId()).not.toBe(before);

    expect(useLogStore.getState().entries.filter((e) => e.msg.includes('camera restarted'))).toHaveLength(0);
  }, 60000);

  /**
   * And the identity guard itself. A true two-unit swap cannot be driven
   * through `connectSessionSim()` — one simulator instance — so the
   * predicate the handler consults is asserted directly.
   */
  it('does not call a different unit a restart', () => {
    const swap = { previous: 'boot-1', current: 'boot-3', deviceId: 'kino-000099' };
    expect(isSameCamera('kino-000012', swap)).toBe(false);
    expect(isSameCamera('kino-000012', { ...swap, deviceId: 'kino-000012' })).toBe(true);
    // Firmware that predates device IDs, and a first connection, both get the
    // benefit of the doubt rather than a silent drop.
    expect(isSameCamera('kino-000012', { previous: 'boot-1', current: 'boot-2' })).toBe(true);
    expect(isSameCamera(null, swap)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 07 §14 — the version-mismatch trigger, end to end
// ---------------------------------------------------------------------------

describe('07 §14 — protocol mismatch on the live path', () => {
  afterEach(async () => {
    sessionSim?.setScenario('protocolMismatch', false);
    await disconnect();
    clearLogs();
  });

  it('refuses the session and raises the mismatch fault, not a bare error', async () => {
    // Connect once to get hold of the simulator, then give it firmware that
    // speaks a protocol this build does not.
    await connectSessionSim();
    await disconnect();
    sessionSim!.setScenario('protocolMismatch', true);

    await connectSessionSim();

    const state = useConnectionStore.getState();
    expect(state.phase).toBe('error');
    expect(state.fault).toBe('protocol-mismatch');
    // The message carries both numbers, which is what the banner prints.
    expect(state.error).toContain('protocol 99');
    expect(state.error).toContain('1..1');

    // The strip names it, and the banner explains it.
    expect(connectionStrip(state.phase, state.fault).label).toBe('PROTOCOL MISMATCH');
    const html = renderToStaticMarkup(
      createElement(ConnectionNotice, { phase: state.phase, fault: state.fault, error: state.error }),
    );
    expect(html).toContain('PROTOCOL MISMATCH');
    expect(html).toContain('protocol 99');

    // And nothing was left connected behind the error.
    expect(getDevice()).toBeNull();
  }, 60000);

  it('connects normally again once the scenario is off', async () => {
    await connectSessionSim();
    await disconnect();
    sessionSim!.setScenario('protocolMismatch', true);
    await connectSessionSim();
    expect(useConnectionStore.getState().fault).toBe('protocol-mismatch');

    sessionSim!.setScenario('protocolMismatch', false);
    await connectSessionSim();
    expect(useConnectionStore.getState().phase).toBe('connected');
    expect(useConnectionStore.getState().fault).toBeNull();
  }, 60000);
});

// ---------------------------------------------------------------------------
// 07 §16 — gallery scale: 0 / 60 / 2,000 / 10,000 metadata rows
// ---------------------------------------------------------------------------

/**
 * `GalleryPage.load()`, verbatim: page the index through the cursor until the
 * card is covered or the listing cap is hit. The cap is the reason a 10,000
 * row card does not become 100 round trips before the first tile appears.
 */
async function readCard(device: KinoDevice): Promise<CaptureSummary[]> {
  const all: CaptureSummary[] = [];
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null) {
    const chunk = await device.mediaList({ cursor, limit: 100 });
    // No response is ever unbounded, whatever the caller asked for.
    expect(chunk.items.length).toBeLessThanOrEqual(100);
    all.push(...chunk.items);
    cursor = chunk.hasMore ? chunk.nextCursor : null;
    if (all.length >= GALLERY_LIST_CAP) break;
    if (++pages > 200) throw new Error('cursor pagination did not terminate');
  }
  return all;
}

describe('07 §16 — gallery scale', () => {
  it('expands a capped listing in bounded user-requested windows until every row is reachable', () => {
    expect(nextGalleryListLimit(5000, 10000)).toBe(10000);
    expect(nextGalleryListLimit(5000, 7412)).toBe(7412);
    expect(nextGalleryListLimit(7412, 7412)).toBe(7412);
  });

  for (const rows of [0, 60, 2000, 10000]) {
    it(`keeps the rendered page bounded at ${rows} metadata rows`, async () => {
      const mock = new MockKinoDevice();
      mock.setGallerySize(rows);
      const { device } = await connectMock(mock);

      // The card really holds this many rows, whatever gets listed below.
      expect((await device.mediaList({ cursor: 0, limit: 1 })).total).toBe(rows);

      const all = await readCard(device);
      // Under the cap the whole card is listed; over it, the listing stops.
      // Either way the demo camera keeps shooting while you page, so the walk
      // can legitimately come back with a row or two more than it started at.
      if (rows < GALLERY_LIST_CAP) expect(all.length).toBeGreaterThanOrEqual(rows);
      expect(all.length).toBeLessThan(GALLERY_LIST_CAP + 100);

      const visible = galleryView(all, 'all', 'newest');
      expect(visible).toHaveLength(all.length);

      const pageCount = Math.max(1, Math.ceil(visible.length / GALLERY_PAGE_SIZE));
      // First, middle and last page: the grid never maps over more than one
      // page of cards no matter how big the card is.
      for (const page of [0, Math.floor(pageCount / 2), pageCount - 1]) {
        expect(galleryPageSlice(visible, page).length).toBeLessThanOrEqual(GALLERY_PAGE_SIZE);
      }
      expect(galleryPageSlice(visible, 0)).toHaveLength(Math.min(all.length, GALLERY_PAGE_SIZE));
      // A page index past the end is clamped, not an empty grid with a
      // "SHOWING 24001–24024" line under it.
      expect(galleryPageSlice(visible, 9999).length).toBeLessThanOrEqual(GALLERY_PAGE_SIZE);
    }, 120000);
  }

  it('filters and sorts what was listed without widening the page', async () => {
    const mock = new MockKinoDevice();
    mock.setGallerySize(2000);
    const { device } = await connectMock(mock);
    const all = await readCard(device);

    const favorites = galleryView(all, 'favorites', 'oldest');
    expect(favorites.every((c) => c.favorite)).toBe(true);
    expect(galleryPageSlice(favorites, 0).length).toBeLessThanOrEqual(GALLERY_PAGE_SIZE);

    const wiggles = galleryView(all, 'wiggle', 'newest');
    expect(wiggles.every((c) => c.kind === 'wiggle')).toBe(true);
    if (wiggles.length > 1) expect(wiggles[0].ts).toBeGreaterThanOrEqual(wiggles[1].ts);
  }, 180000);
});
