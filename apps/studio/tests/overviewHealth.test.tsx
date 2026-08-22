// Issue #61: the WIFI and ROLL health rows, the ARMED camera lamp, and the
// STORAGE BENCH readout.
//
// All three assert the same rule, which is the whole point of the sub-item:
// a capability the firmware does not have, a command it did not answer, and a
// real value are THREE states, and the page must never collapse them into
// two.
//
// `supplyRows` / `camLed` are pure and take the resolved gate, so the rule is
// asserted without a store or a DOM; the one component here is prop-driven
// and rendered through react-dom/server, the same way skewBench.test.tsx
// renders SkewMetricCard.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CameraInfo, Capabilities, PowerStatus, StorageBenchResult, StorageStatus } from '@kino/kdp';
import { camLed, supplyRows } from '../src/pages/Overview/healthRows';
import type { HealthRow, SupplyInput } from '../src/pages/Overview/healthRows';
import { StorageBenchReadout } from '../src/pages/Developer/BenchDiagnosticsPanel';
import type { BenchEntry } from '../src/state/benchResults';
import type { NetworkStatus, RollView } from '../src/roll/rollTypes';

const CAPS: Capabilities = {
  cameraCount: 4,
  wiggle: true,
  quad: true,
  gallery: true,
  flashControl: true,
  vsyncTelemetry: true,
  phaseCalibration: true,
  xiaoProxyUpdate: true,
  linkBench: true,
  customSounds: true,
};

const STORAGE: StorageStatus = { present: true, totalMB: 30432, freeMB: 27431 };
const POWER: PowerStatus = { batteryV: 4.02, batteryPct: 80, state: 'battery', charging: false };

const QUEUE = { pending: 0, uploading: 0, failed: 0, uploaded: 0, draining: false };

function rows(patch: Partial<SupplyInput>): HealthRow[] {
  return supplyRows({
    storage: STORAGE,
    power: POWER,
    capabilities: CAPS,
    network: null,
    roll: null,
    hasNetwork: false,
    hasRoll: false,
    ...patch,
  });
}

const row = (list: HealthRow[], name: string): HealthRow => {
  const found = list.find((r) => r.name === name);
  expect(found, `no ${name} row`).toBeDefined();
  return found!;
};

function cam(id: CameraInfo['id'], state: CameraInfo['state']): CameraInfo {
  return {
    id,
    online: state !== 'offline' && state !== 'rebooting',
    sensor: 'OV3660',
    sensorDetected: true,
    firmware: '0.1.0',
    state,
    latencyMs: 4.2,
    uartErrors: 0,
    lastCapture: null,
  };
}

describe('WIFI row', () => {
  it('says NOT AVAILABLE when the firmware does not advertise the radio', () => {
    // A loaded capability set that omits `network` is an answer — not
    // supported — never "we have not asked yet".
    expect(row(rows({ hasNetwork: false }), 'WIFI')).toEqual({
      name: 'WIFI',
      state: 'off',
      label: 'NOT AVAILABLE',
    });
  });

  it('says NOT REPORTED when the radio exists but the command went unanswered', () => {
    expect(row(rows({ hasNetwork: true, network: null }), 'WIFI').label).toBe('NOT REPORTED');
  });

  it('prints the SSID and the state when the device answered', () => {
    const network: NetworkStatus = {
      state: 'connected',
      ssid: 'kino-bench',
      ip: '192.168.1.44',
      rssi: -52,
      since: 1,
      internet: true,
    };
    const printed = row(rows({ hasNetwork: true, network }), 'WIFI');
    expect(printed.label).toBe('kino-bench · CONNECTED');
    expect(printed.state).toBe('ok');
  });

  it('does not claim internet the device did not report', () => {
    const network: NetworkStatus = {
      state: 'connected',
      ssid: 'loft-guest',
      ip: '10.0.0.9',
      rssi: -71,
      since: 1,
      internet: false,
    };
    expect(row(rows({ hasNetwork: true, network }), 'WIFI').label).toBe('loft-guest · CONNECTED · NO INTERNET');
  });

  it('disconnected is an answer, not silence', () => {
    const network: NetworkStatus = {
      state: 'disconnected',
      ssid: null,
      ip: null,
      rssi: null,
      since: null,
      internet: false,
    };
    expect(row(rows({ hasNetwork: true, network }), 'WIFI').label).toBe('DISCONNECTED');
  });

  it('connecting is its own lamp', () => {
    const network: NetworkStatus = {
      state: 'connecting',
      ssid: 'kino-bench',
      ip: null,
      rssi: null,
      since: null,
      internet: false,
    };
    const printed = row(rows({ hasNetwork: true, network }), 'WIFI');
    expect(printed.label).toBe('kino-bench · CONNECTING');
    expect(printed.state).toBe('busy');
  });
});

describe('ROLL row', () => {
  it('says NOT AVAILABLE when the firmware has no Roll service', () => {
    expect(row(rows({ hasRoll: false }), 'ROLL').label).toBe('NOT AVAILABLE');
  });

  it('says NOT REPORTED when the service exists but ROLL_STATUS went unanswered', () => {
    expect(row(rows({ hasRoll: true, roll: null }), 'ROLL').label).toBe('NOT REPORTED');
  });

  it('NO ROLL is an answer — the camera is on no Roll', () => {
    const roll: RollView = { active: false, roll: null, queue: QUEUE };
    expect(row(rows({ hasRoll: true, roll }), 'ROLL').label).toBe('NO ROLL');
  });

  it('prints the title and the slug when the camera is on one', () => {
    const roll: RollView = {
      active: true,
      roll: {
        rollId: 'r_88',
        slug: 'loft-party',
        guestUrl: 'https://roll.kino/loft-party',
        name: 'Loft party',
        role: 'host',
        joinedAt: 1,
      },
      queue: QUEUE,
    };
    const printed = row(rows({ hasRoll: true, roll }), 'ROLL');
    expect(printed.label).toBe('LOFT PARTY · loft-party');
    expect(printed.state).toBe('ok');
  });

  it('the three states never share a label', () => {
    const active: RollView = { active: false, roll: null, queue: QUEUE };
    const labels = [
      row(rows({ hasRoll: false }), 'ROLL').label,
      row(rows({ hasRoll: true, roll: null }), 'ROLL').label,
      row(rows({ hasRoll: true, roll: active }), 'ROLL').label,
    ];
    expect(new Set(labels).size).toBe(3);
  });
});

describe('the rows the 5 V precedent set are unchanged', () => {
  it('still reports the rail as NOT REPORTED when busV is absent', () => {
    expect(row(rows({}), '5V RAIL').label).toBe('NOT REPORTED');
  });

  it('and prints it when the firmware has the ADC', () => {
    expect(row(rows({ power: { ...POWER, busV: 4.97 } }), '5V RAIL').label).toBe('4.97 V');
  });
});

describe('ARMED camera lamp', () => {
  it('is its own state, not a shade of READY or BUSY', () => {
    expect(camLed(cam('cam1', 'armed'))).toEqual({ state: 'busy', label: 'ARMED' });
    expect(camLed(cam('cam1', 'ready'))).toEqual({ state: 'ok', label: 'READY' });
    expect(camLed(cam('cam1', 'busy')).label).toBe('BUSY');
  });

  it('an offline camera is never armed, whatever it last said', () => {
    expect(camLed({ ...cam('cam1', 'armed'), online: false }).label).toBe('OFFLINE');
  });
});

describe('STORAGE BENCH readout', () => {
  const result: StorageBenchResult = {
    writeMBs: 9.4,
    readMBs: 18.1,
    worstBlockMs: 214,
    p95BlockMs: 13.6,
    bytes: 16777216,
  };
  const entry: BenchEntry<StorageBenchResult> = {
    result,
    ranAt: new Date(2026, 0, 1, 14, 3, 9).getTime(),
    staleReason: null,
  };

  it('renders a result with the worst block first', () => {
    const html = renderToStaticMarkup(<StorageBenchReadout entry={entry} />);
    expect(html).toContain('WORST BLOCK 214 ms');
    expect(html).toContain('9.4 MB/s');
    expect(html).toContain('18.1 MB/s');
    expect(html).toContain('16777216 B written');
    // A four-frame burst stalls on the worst block, so the average must not
    // be the figure a reader hits first.
    expect(html.indexOf('214')).toBeLessThan(html.indexOf('13.6'));
  });

  it('carries the ran-at stamp', () => {
    expect(renderToStaticMarkup(<StorageBenchReadout entry={entry} />)).toContain('RAN 14:03:09');
  });

  it('says so when the run went stale rather than dropping the numbers', () => {
    const stale = { ...entry, staleReason: 'KINO rebooted after this run' };
    const html = renderToStaticMarkup(<StorageBenchReadout entry={stale} />);
    expect(html).toContain('STALE: KINO rebooted after this run');
    expect(html).toContain('WORST BLOCK 214 ms');
  });

  it('renders nothing until a run has produced numbers', () => {
    expect(renderToStaticMarkup(<StorageBenchReadout entry={null} />)).toBe('');
  });
});
