import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { D4_V1 } from '../src/index';

/**
 * The JP1 pin map has been wrong twice, both times from copying a table: once
 * from an assumed third-party list, once from the JC-ESP32P4-M3-DEV pinout,
 * which is a different carrier that shares only the P4 module. It was settled
 * electrically instead -- the P4 pulsed every GPIO in turn while a node
 * watched one wire -- and JP1 13 answered as GPIO49, JP1 7 as GPIO52.
 *
 * These tests pin the profile to that measured table and to the firmware
 * header so neither can drift alone. ECN-0002.
 */

const CAM_SIGNALS = ['CAM1_TX', 'CAM1_RX', 'CAM2_TX', 'CAM2_RX', 'CAM3_TX', 'CAM3_RX', 'CAM4_TX', 'CAM4_RX'] as const;
const ASSIGNED = [...CAM_SIGNALS, 'SYNC_OUT', 'FLASH_EN', 'CAM_PWR_EN'] as const;

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
  36: 'strapping',
  37: 'strapping (console UART0 TX)',
  38: 'strapping (console UART0 RX)',
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

/**
 * GPIO34 and GPIO35 are ESP32-P4 strapping pins that this carrier routes to
 * JP1 anyway, so a twelve-pin header carrying eleven signals cannot avoid
 * them. They are allowed only on these terms:
 *
 *   GPIO34  CAM3_TX. Ours to drive, and the far end is a node's UART RX,
 *           which is high impedance and cannot hold it during our reset.
 *   GPIO35  spare, and it must stay spare: it is the serial-bootloader strap,
 *           so JP1 15 tied low is a board that comes up in the ROM downloader
 *           instead of the app.
 *
 * A camera's TX is an INPUT to us and must never land on either.
 */
const STRAPPING_OUTPUT_ONLY: Record<number, string> = {
  34: 'CAM3_TX drives it; node RX is high-Z',
};
const MUST_STAY_SPARE = 35;

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
      '3V3', '3V3', 'GND', 'GPIO52', 'GPIO51', 'GPIO50', 'GPIO49', 'GPIO35', 'GPIO34', 'GPIO32', 'GPIO28', 'I2C_SDA', 'I2C_SCL',
    ]);
    expect(header.right).toEqual([
      '5V', '5V', 'GND', 'GPIO33', 'GPIO31', 'GPIO30', 'GPIO29', 'GND', 'ESP_3V3', 'C6_U0RXD', 'C6_U0TXD', 'C6_IO9', 'C6_CHIP_PU',
    ]);
    // The two pins the bench actually measured.
    expect(headerNetAt(13), 'MEASURED: JP1 13 is GPIO49').toBe('GPIO49');
    expect(headerNetAt(7), 'MEASURED: JP1 7 is GPIO52').toBe('GPIO52');
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
      expect(n, `${signal}: GPIO${MUST_STAY_SPARE} is the bootloader strap and must stay spare`).not.toBe(MUST_STAY_SPARE);
      if (STRAPPING_OUTPUT_ONLY[n]) {
        expect(signal, `GPIO${n} is a strapping pin: only an output may take it (${STRAPPING_OUTPUT_ONLY[n]})`).toMatch(/_TX$|^SYNC_OUT$|_EN$/);
      }
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

  it('reserves the spare, the audio I2C and the C6 pins at their real header positions', () => {
    const byNet = new Map(jp1.reserved.map((r) => [r.net, r]));
    for (const net of ['GPIO35', 'I2C_SDA', 'I2C_SCL', 'ESP_3V3', 'C6_U0RXD', 'C6_U0TXD', 'C6_IO9', 'C6_CHIP_PU']) {
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

  it('routes FLASH_EN and CAM_PWR_EN and drops the M3-DEV phantom pins', () => {
    // Both have a header pin here. They were null only while the map was the
    // M3-DEV one, which appeared to leave no pin for them.
    expect(D4_V1.gpio.FLASH_EN).toBe('GPIO28');
    expect(D4_V1.gpio.CAM_PWR_EN).toBe('GPIO31');
    const claimed = new Set(Object.values(D4_V1.gpio).filter((v): v is string => v !== null));
    // GPIO1/2/4/20/45/46/47 belong to the JC-ESP32P4-M3-DEV carrier; GPIO3 and
    // GPIO5 are the touch and panel resets and reach no connector here.
    for (const ghost of ['GPIO1', 'GPIO2', 'GPIO3', 'GPIO4', 'GPIO5', 'GPIO20', 'GPIO45', 'GPIO46', 'GPIO47']) {
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

  it('keeps BOARD_GPIO_NONE available and routes both control lines', () => {
    // The sentinel stays: capture.c and power.c still branch on it, and a
    // future carrier may genuinely lack the pin.
    expect(src).toMatch(/^[ \t]*#define[ \t]+BOARD_GPIO_NONE[ \t]+\(-1\)/m);
    expect(define('BOARD_FLASH_EN'), 'FLASH_EN is routed on JP1 21').toBe('28');
    expect(define('BOARD_CAM_PWR_EN'), 'CAM_PWR_EN is routed on JP1 10').toBe('31');
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
