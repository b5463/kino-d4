import { describe, it, expect } from 'vitest';
import { D4_V1 } from '../src/index';
import { netDef, netsFor, netsByClass } from '../src/nets';

const CAM_IDS = ['cam1', 'cam2', 'cam3', 'cam4'];
const VALID_INSTANCE_IDS = new Set(D4_V1.instances.map((i) => i.id));

describe('nets + gpio (§8)', () => {
  it('every cam has exactly four POWER|UART harness nets + one SYNC net', () => {
    for (const camId of CAM_IDS) {
      const nets = netsFor(D4_V1, camId);
      expect(nets).toHaveLength(5);

      const harness = nets.filter((n) => n.cls === 'POWER' || n.cls === 'UART');
      expect(harness).toHaveLength(4);

      const sync = nets.filter((n) => n.cls === 'SYNC');
      expect(sync).toHaveLength(1);
      expect(sync[0]?.color).toBe('yellow');
      expect(sync[0]?.gauge).toBe('28AWG');

      const power5v = harness.find((n) => n.cls === 'POWER' && n.color === 'red');
      expect(power5v?.gauge).toBe('24AWG');

      const gnd = harness.find((n) => n.cls === 'POWER' && n.color === 'black');
      expect(gnd?.gauge).toBe('24AWG');

      const tx = harness.find((n) => n.cls === 'UART' && n.color === 'blue');
      expect(tx?.gauge).toBe('28AWG');

      const rx = harness.find((n) => n.cls === 'UART' && n.color === 'green');
      expect(rx?.gauge).toBe('28AWG');
    }
  });

  it('netsFor(D4_V1, "cam2") returns exactly cam2\'s nets', () => {
    const nets = netsFor(D4_V1, 'cam2');
    expect(nets).toHaveLength(5);
    expect(nets.every((n) => n.from.instance === 'cam2' || n.to.instance === 'cam2')).toBe(true);
  });

  it('the battery -> fuse -> bms -> power-module chain is 20AWG POWER', () => {
    const powerNets = netsByClass(D4_V1, 'POWER');
    const chainPairs: Array<[string, string]> = [
      ['battery', 'fuse'],
      ['fuse', 'bms'],
      ['bms', 'power-module'],
      ['power-module', 'carrier'],
      ['carrier', 'display'],
    ];
    for (const [from, to] of chainPairs) {
      const net = powerNets.find(
        (n) =>
          (n.from.instance === from && n.to.instance === to) ||
          (n.from.instance === to && n.to.instance === from),
      );
      expect(net).toBeDefined();
      expect(net?.gauge).toBe('20AWG');
    }
  });

  it('carries no FLASH net, and the button pair with its documented class', () => {
    // Zero, not one. ECN-0003 dropped the built-in flash assembly from D4-V1
    // entirely: GPIO28 / JP1 21 went to the shutter, and the flash became a
    // separate external module with no P4 pin and no wire from this body. The
    // profile kept a 5 V feed to a `flash` instance that no longer exists,
    // which is a harness the builder would have wired to nothing. FLASH stays
    // in NET_CLASSES — the vocabulary is for the day an external module gets
    // a defined connector, not a claim that one is fitted.
    expect(netsByClass(D4_V1, 'FLASH')).toHaveLength(0);
    expect(netsByClass(D4_V1, 'BUTTONS')).toHaveLength(2);
    expect(D4_V1.instances.some((i) => i.id === 'flash')).toBe(false);
    expect(D4_V1.components.some((c) => c.id.startsWith('flash-'))).toBe(false);
  });

  it('accepts a ribbon harness without weakening endpoint or waypoint validation', () => {
    const ribbon = netDef.parse({
      id: 'fixture-ribbon',
      cls: 'UART',
      from: { instance: 'display', pin: 'IDC' },
      to: { instance: 'carrier', pin: 'IDC' },
      gauge: 'ribbon',
      color: 'grey',
      waypointsMm: [[0, 0, -15], [0, -2, -12], [0, -5, -8]],
    });
    expect(ribbon.gauge).toBe('ribbon');
  });

  it('every net endpoint references a real instance', () => {
    expect(D4_V1.nets.length).toBeGreaterThan(0);
    for (const net of D4_V1.nets) {
      expect(VALID_INSTANCE_IDS.has(net.from.instance)).toBe(true);
      expect(VALID_INSTANCE_IDS.has(net.to.instance)).toBe(true);
    }
  });

  it('waypoints number 3-5 and stay inside the body envelope', () => {
    const [bx, by, bz] = D4_V1.body.sizeMm;
    for (const net of D4_V1.nets) {
      expect(net.waypointsMm.length).toBeGreaterThanOrEqual(3);
      expect(net.waypointsMm.length).toBeLessThanOrEqual(5);
      for (const [x, y, z] of net.waypointsMm) {
        expect(Math.abs(x)).toBeLessThanOrEqual(bx / 2);
        expect(Math.abs(y)).toBeLessThanOrEqual(by / 2);
        expect(Math.abs(z)).toBeLessThanOrEqual(bz / 2);
      }
    }
  });

  it('the gpio map covers every documented pin key', () => {
    const expectedKeys = [
      'CAM_PWR_1',
      'CAM_PWR_2',
      'CAM_PWR_3',
      'CAM_PWR_4',
      'SYNC_OUT',
      'CAM1_TX',
      'CAM1_RX',
      'CAM2_TX',
      'CAM2_RX',
      'CAM3_TX',
      'CAM3_RX',
      'CAM4_TX',
      'CAM4_RX',
      'FLASH_EN',
      'CAM_PWR_EN',
      'BTN_SHUTTER',
      'BTN_FN',
      'SLIDE_MODE',
    ];
    for (const key of expectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(D4_V1.gpio, key)).toBe(true);
    }
    // The old UARTn_* names and the phantom spare are gone for good.
    for (const key of Object.keys(D4_V1.gpio)) {
      expect(key).not.toMatch(/^UART[1-4]_/);
      expect(key).not.toBe('SPARE_GPIO35');
    }
  });

  it('every UART net ends on the display at a gpio-map key with a JP1 pin', () => {
    for (const net of netsByClass(D4_V1, 'UART')) {
      const end = net.from.instance === 'display' ? net.from : net.to;
      expect(end.instance).toBe('display');
      expect(D4_V1.gpio[end.pin], `net ${net.id}: display pin ${end.pin} is not an assigned gpio key`).toMatch(/^GPIO\d+$/);
      expect(D4_V1.jp1?.pins[end.pin], `net ${net.id}: ${end.pin} has no JP1 pin`).toBeDefined();
    }
  });
});
