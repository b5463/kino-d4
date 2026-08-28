import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { D4_V1 } from '../src/index';

/**
 * The JP1 pin map has been wrong once already: GPIO52/51/50/49/35/34/31/30/
 * 29/28 were claimed as camera wiring and none of them is on the header.
 * These tests pin the profile to the manufacturer table and to the firmware
 * header so neither can drift alone.
 */

const CAM_SIGNALS = ['CAM1_TX', 'CAM1_RX', 'CAM2_TX', 'CAM2_RX', 'CAM3_TX', 'CAM3_RX', 'CAM4_TX', 'CAM4_RX'] as const;
const ASSIGNED = [...CAM_SIGNALS, 'SYNC_OUT'] as const;

/** ESP32-P4 GPIOs a KINO signal must never take on this carrier. */
const RESERVED_GPIO: Record<number, string> = {
  3: 'TOUCH_RESET (GT911)',
  5: 'LCD_RESET (ST7701S)',
  7: 'I2C SDA',
  8: 'I2C SCL',
  9: 'I2S',
  10: 'I2S',
  11: 'I2S',
  12: 'I2S',
  13: 'I2S',
  14: 'C6 SDIO slot 1',
  15: 'C6 SDIO slot 1',
  16: 'C6 SDIO slot 1',
  17: 'C6 SDIO slot 1',
  18: 'C6 SDIO slot 1',
  19: 'C6 SDIO slot 1',
  23: 'LCD backlight',
  24: 'USB',
  25: 'USB',
  26: 'USB',
  27: 'USB',
  34: 'strapping',
  35: 'strapping',
  36: 'strapping',
  37: 'strapping',
  38: 'strapping',
  39: 'SD slot 0',
  40: 'SD slot 0',
  41: 'SD slot 0',
  42: 'SD slot 0',
  43: 'SD slot 0',
  44: 'SD slot 0',
  48: 'I2S',
  54: 'C6_EN',
};

const P4_GPIO_MAX = 54;

const jp1 = D4_V1.jp1!;
const display = D4_V1.components.find((c) => c.id === 'main-display')!;
const header = display.specs!.header2x13 as { left: string[]; right: string[] };

function gpioNumber(name: string | null | undefined, signal: string): number {
  const m = /^GPIO(\d+)$/.exec(name ?? '');
  if (!m) throw new Error(`${signal}: "${String(name)}" is not a GPIO name`);
  return Number(m[1]);
}

/** Header net at a printed JP1 pin: odd → left[(pin-1)/2], even → right[(pin-2)/2]. */
function headerNetAt(pin: number): string | undefined {
  return pin % 2 === 1 ? header.left[(pin - 1) / 2] : header.right[(pin - 2) / 2];
}

describe('d4-v1 JP1 pin map', () => {
  it('carries the manufacturer JP1 table verbatim', () => {
    expect(header.left).toEqual([
      '3V3', '3V3', 'GND', 'GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO20', 'GPIO32', 'GPIO33', 'ESI2C_SDA', 'ESI2C_SCL',
    ]);
    expect(header.right).toEqual([
      '5V', '5V', 'GND', 'NC', 'GPIO47', 'GPIO46', 'GPIO45', 'GND', '3V3', 'C6_U0RXD', 'C6_U0TXD', 'C6_IO9', 'C6_CHIP_PU',
    ]);
    expect(jp1.header).toBe('JP1');
    expect(jp1.rows).toBe(13);
    expect(header.left).toHaveLength(jp1.rows);
    expect(header.right).toHaveLength(jp1.rows);
  });

  it('assigns eight unique GPIOs to CAM1-4 TX/RX and a ninth to SYNC_OUT', () => {
    const cams = CAM_SIGNALS.map((s) => gpioNumber(D4_V1.gpio[s], s));
    expect(new Set(cams).size, `CAM TX/RX GPIOs collide: ${cams.join(',')}`).toBe(8);
    const sync = gpioNumber(D4_V1.gpio.SYNC_OUT, 'SYNC_OUT');
    expect(cams, `SYNC_OUT GPIO${sync} is also a CAM UART pin`).not.toContain(sync);
  });

  it('never lands on a reserved or out-of-range ESP32-P4 GPIO', () => {
    for (const signal of ASSIGNED) {
      const n = gpioNumber(D4_V1.gpio[signal], signal);
      expect(n, `${signal}: GPIO${n} is outside 0..${P4_GPIO_MAX}`).toBeGreaterThanOrEqual(0);
      expect(n, `${signal}: GPIO${n} is outside 0..${P4_GPIO_MAX}`).toBeLessThanOrEqual(P4_GPIO_MAX);
      expect(RESERVED_GPIO[n], `${signal}: GPIO${n} is reserved (${RESERVED_GPIO[n]})`).toBeUndefined();
    }
  });

  it('gives every assigned signal a JP1 pin whose header net is that GPIO', () => {
    for (const signal of ASSIGNED) {
      const slot = jp1.pins[signal];
      expect(slot, `${signal} has no jp1 entry`).toBeDefined();
      expect(slot!.gpio, `${signal}: jp1.gpio ${slot!.gpio} != gpio map ${D4_V1.gpio[signal]}`).toBe(D4_V1.gpio[signal]);
      expect(slot!.pin).toBeGreaterThanOrEqual(1);
      expect(slot!.pin).toBeLessThanOrEqual(2 * jp1.rows);
      expect(headerNetAt(slot!.pin), `${signal}: JP1 pin ${slot!.pin} carries ${headerNetAt(slot!.pin)}, not ${slot!.gpio}`).toBe(slot!.gpio);
    }
    // No jp1 entry without a gpio-map twin, and no gpio-map GPIO without a jp1 entry.
    for (const key of Object.keys(jp1.pins)) expect(D4_V1.gpio[key], `jp1.pins.${key} has no gpio-map key`).toMatch(/^GPIO\d+$/);
    for (const [key, value] of Object.entries(D4_V1.gpio)) {
      if (value !== null) expect(jp1.pins[key], `gpio.${key}=${value} has no JP1 pin`).toBeDefined();
    }
  });

  it('uses each JP1 pin at most once, assignments and reservations together', () => {
    const pins = [...Object.values(jp1.pins).map((p) => p.pin), ...jp1.reserved.map((r) => r.pin)];
    const dupes = pins.filter((p, i) => pins.indexOf(p) !== i);
    expect(dupes, `JP1 pins claimed twice: ${dupes.join(',')}`).toEqual([]);
  });

  it('reserves GPIO3, GPIO5, ESI2C and the C6 pins at their real header positions', () => {
    const byNet = new Map(jp1.reserved.map((r) => [r.net, r]));
    for (const net of ['GPIO3', 'GPIO5', 'ESI2C_SDA', 'ESI2C_SCL', 'C6_U0RXD', 'C6_U0TXD', 'C6_IO9', 'C6_CHIP_PU']) {
      const r = byNet.get(net);
      expect(r, `${net} is not in jp1.reserved`).toBeDefined();
      expect(headerNetAt(r!.pin), `${net}: reserved at JP1 pin ${r!.pin}, header has ${headerNetAt(r!.pin)}`).toBe(net);
    }
    for (const r of jp1.reserved) {
      if (r.gpio) {
        const n = gpioNumber(r.gpio, r.net);
        for (const signal of ASSIGNED) {
          expect(D4_V1.gpio[signal], `${signal} sits on reserved GPIO${n} (${r.use})`).not.toBe(r.gpio);
        }
      }
    }
  });

  it('leaves FLASH_EN and CAM_PWR_EN unassigned and drops the phantom pins', () => {
    expect(D4_V1.gpio.FLASH_EN).toBeNull();
    expect(D4_V1.gpio.CAM_PWR_EN).toBeNull();
    expect(D4_V1.gpio).not.toHaveProperty('SPARE_GPIO35');
    const claimed = new Set(Object.values(D4_V1.gpio).filter((v): v is string => v !== null));
    for (const ghost of ['GPIO52', 'GPIO51', 'GPIO50', 'GPIO49', 'GPIO35', 'GPIO34', 'GPIO31', 'GPIO30', 'GPIO29', 'GPIO28']) {
      expect(claimed.has(ghost), `${ghost} is not on JP1 but is still assigned`).toBe(false);
      expect(header.left.concat(header.right), `${ghost} is not on JP1 but appears in header2x13`).not.toContain(ghost);
    }
  });
});

describe('firmware board_d4v1.h agrees with the profile', () => {
  const headerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../firmware/p4/main/board_d4v1.h');
  const src = readFileSync(headerPath, 'utf8');

  function define(name: string): string {
    const m = new RegExp(`^[ \\t]*#define[ \\t]+${name}[ \\t]+(\\S+)`, 'm').exec(src);
    if (!m) throw new Error(`board_d4v1.h: no "#define ${name}" — firmware and profile have diverged on ${name}`);
    return m[1]!;
  }

  it('defines BOARD_GPIO_NONE and parks FLASH_EN and CAM_PWR_EN on it', () => {
    expect(src).toMatch(/^[ \t]*#define[ \t]+BOARD_GPIO_NONE[ \t]+\(-1\)/m);
    expect(define('BOARD_FLASH_EN'), 'FLASH_EN: firmware names a pin, profile says null').toBe('BOARD_GPIO_NONE');
    expect(define('BOARD_CAM_PWR_EN'), 'CAM_PWR_EN: firmware names a pin, profile says null').toBe('BOARD_GPIO_NONE');
  });

  it('CAM1-4 TX/RX and SYNC_OUT GPIO numbers match the gpio map', () => {
    for (const signal of ASSIGNED) {
      const fw = Number(define(`BOARD_${signal}`));
      const json = gpioNumber(D4_V1.gpio[signal], signal);
      expect(fw, `${signal}: firmware BOARD_${signal}=${fw}, profile ${D4_V1.gpio[signal]}`).toBe(json);
    }
  });

  it('BOARD_*_JP1 physical pins match jp1.pins', () => {
    for (const signal of ASSIGNED) {
      const fw = Number(define(`BOARD_${signal}_JP1`));
      const json = jp1.pins[signal]!.pin;
      expect(fw, `${signal}: firmware BOARD_${signal}_JP1=${fw}, profile JP1 pin ${json}`).toBe(json);
    }
  });

  it('every CAMn_(TX|RX) macro in the header is one the profile knows', () => {
    const re = /^[ \t]*#define[ \t]+BOARD_CAM([1-4])_(TX|RX)[ \t]+(\d+)/gm;
    const seen: string[] = [];
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const signal = `CAM${m[1]}_${m[2]}`;
      seen.push(signal);
      expect(gpioNumber(D4_V1.gpio[signal], signal), `${signal}: firmware ${m[3]} vs profile ${D4_V1.gpio[signal]}`).toBe(Number(m[3]));
    }
    expect(seen.sort()).toEqual([...CAM_SIGNALS].sort());
  });
});
