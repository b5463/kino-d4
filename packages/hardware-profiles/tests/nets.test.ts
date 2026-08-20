import { describe, it, expect } from 'vitest';
import { D4_V1 } from '../src/index';
import { netsFor, netsByClass } from '../src/nets';

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

  it('the flash pair and button pair exist with their documented classes', () => {
    expect(netsByClass(D4_V1, 'FLASH')).toHaveLength(2);
    expect(netsByClass(D4_V1, 'BUTTONS')).toHaveLength(2);
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
      'UART1_TX',
      'UART1_RX',
      'UART2_TX',
      'UART2_RX',
      'UART3_TX',
      'UART3_RX',
      'UART4_TX',
      'UART4_RX',
      'FLASH_EN',
      'BTN_SHUTTER',
      'BTN_FN',
      'SLIDE_MODE',
    ];
    for (const key of expectedKeys) {
      expect(Object.prototype.hasOwnProperty.call(D4_V1.gpio, key)).toBe(true);
    }
  });
});
