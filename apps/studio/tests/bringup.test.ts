import { describe, expect, it } from 'vitest';
import { D4_V1 } from '@kino/hardware-profiles';
import { CHECKLIST, totalChecks, importRecord, exportRecord, useBringUp } from '../src/developer/bringup';

const allItems = () => CHECKLIST.flatMap((s) => s.items);
const allIds = () => allItems().map((i) => i.id);

describe('bring-up record', () => {
  it('covers the spec checklist sections', () => {
    // Module incoming check, two electrical sections, USB-C power, then the
    // four the usable-V1 build added: printed body, closed-body numbers, the
    // effect, field reliability.
    expect(CHECKLIST).toHaveLength(8);
    expect(totalChecks()).toBe(70);
    const ids = allIds();
    expect(new Set(ids).size).toBe(ids.length); // unique ids
  });

  it('runs past the electrical build to the parts a printed body added', () => {
    const titles = CHECKLIST.map((s) => s.title);
    // The modules arrive before the harness, so their check comes first.
    expect(titles[0]).toContain('CAMERA MODULE INCOMING CHECK');
    expect(titles).toContain('USB-C POWER');
    expect(titles).toContain('PRINTED BODY — V1 STRUCTURE');
    expect(titles).toContain('CLOSED-BODY POWER AND THERMAL — V2 INPUTS');
    expect(titles).toContain('THE EFFECT ITSELF');
    expect(titles.some((t) => /BATTERY/.test(t))).toBe(false);
  });

  it('describes the field body, not the battery build', () => {
    // KINO_FIELD_BODY 0.1.4: USB-C powered, no pack bay (ECN-0004), no
    // built-in flash (ECN-0003), no Hall switch, audio on the Guition carrier.
    // None of the deleted parts may be asked for on the sheet.
    const text = [
      ...CHECKLIST.map((s) => `${s.title} ${s.note ?? ''}`),
      ...allItems().map((i) => i.text),
    ].join('\n');
    // "battery bank" is allowed: the bank in a pocket IS the supply. A
    // battery in the camera is not.
    for (const gone of [/LiPo/i, /batter(y|ies)(?! bank)/i, /\bBMS\b/, /SW6106/, /\bfuse\b/i, /\bflash\b/i, /speaker/i, /pouch/i, /\bHall\b/]) {
      expect(text, `checklist still mentions ${String(gone)}`).not.toMatch(gone);
    }
    // ...but the sounds still get verified, from the carrier's own audio.
    const sounds = allItems().find((i) => i.id === 'b11');
    expect(sounds?.text).toMatch(/ES8311/);
    expect(sounds?.test).toBe('selftest');
  });

  it('retires the battery-path ids and keeps the survivors', () => {
    const ids = new Set(allIds());
    // Removed with the battery build; old records may still carry ticks on
    // them, and the source lists them so those ticks can be read.
    const removed = [
      'a1', 'a2', 'a3', 'a4', 'a5', 'a15', 'a16',
      'b9', 'b10',
      'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10',
      'd7', 'd8',
      'e1', 'e6', 'e7',
      'g5',
    ];
    for (const id of removed) expect(ids.has(id), `${id} should be retired`).toBe(false);
    // Survivors keep their ids: a record from the earlier build keeps its ticks.
    for (const id of ['m1', 'a6', 'a14', 'b6', 'b8', 'b11', 'b12', 'd2', 'd10', 'e2', 'e9', 'f1', 'g1', 'g7']) {
      expect(ids.has(id), `${id} should survive`).toBe(true);
    }
    // New with the field body.
    for (const id of ['a17', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'd11', 'd12', 'd13', 'e10', 'e11', 'e12', 'g8']) {
      expect(ids.has(id), `${id} should exist`).toBe(true);
    }
  });

  it('measures the USB-C bus where the spec says the numbers matter', () => {
    const usb = CHECKLIST.find((s) => s.title === 'USB-C POWER')!;
    const text = usb.items.map((i) => i.text).join('\n');
    expect(text).toMatch(/USB-Serial-JTAG/);
    expect(text).toMatch(/four-camera capture/);
    expect(text).toMatch(/[Bb]rownout margin/);
    expect(text).toMatch(/laptop/);
    expect(text).toMatch(/PD brick/);
    // The bus numbers are V2 inputs: each voltage/current check has a box.
    for (const id of ['p2', 'p3', 'p4', 'p5']) {
      expect(usb.items.find((i) => i.id === id)?.record).toBeTruthy();
    }
  });

  it('gives every measurement check somewhere to put the measurement', () => {
    // A tick that records no number wastes the run it came from: the V2
    // input sections are worthless as bare checkboxes.
    const v2 = CHECKLIST.find((s) => s.title.includes('V2 INPUTS'));
    expect(v2).toBeDefined();
    expect(v2!.items.every((i) => typeof i.record === 'string' && i.record.length > 0)).toBe(true);
  });

  it('only wires RUN buttons to tests the page implements', () => {
    const known = new Set(['uart-echo', 'trigger', 'captures', 'selftest', 'snapshot']);
    for (const item of allItems()) {
      if (item.test !== undefined) expect(known.has(item.test)).toBe(true);
    }
  });

  it('seeds the wiring record from the profile pin map, JP1 pin included', () => {
    const wiring = useBringUp.getState().wiring;
    const cam1 = wiring.find((r) => r.func.startsWith('CAM1 TX'));
    expect(cam1?.provisional).toBe(`${D4_V1.gpio.CAM1_TX} (JP1 pin ${D4_V1.jp1!.pins.CAM1_TX!.pin})`);
    const cam3 = wiring.find((r) => r.func.startsWith('CAM3 TX'));
    expect(cam3?.provisional).toBe(`${D4_V1.gpio.CAM3_TX} (JP1 pin ${D4_V1.jp1!.pins.CAM3_TX!.pin})`);
    // GPIO34 is a strapping pin and JP1 routes it anyway, so CAM3_TX takes it:
    // we drive it, and a node's UART RX is high-Z and cannot hold it through
    // our reset. GPIO35, the serial-bootloader strap, must never appear -- a
    // signal there means a board that boots into the ROM downloader.
    for (const r of wiring) expect(r.provisional, `${r.func} is on the bootloader strap`).not.toMatch(/GPIO35\b/);
    for (const r of wiring) {
      if (/GPIO34\b/.test(r.provisional ?? '')) expect(r.func).toMatch(/^CAM3 TX/);
    }
    expect(wiring.find((r) => r.func === 'CAM_PWR_EN')?.provisional).toBe(
      `${D4_V1.gpio.CAM_PWR_EN} (JP1 pin ${D4_V1.jp1!.pins.CAM_PWR_EN!.pin})`,
    );
    // ECN-0003: JP1 21 / GPIO28 is the shutter switch, and FLASH_EN has no P4
    // pin at all -- the built-in flash gave way to a separate external module.
    // The FLASH_EN row stays on the sheet reading "unassigned".
    expect(wiring.find((r) => r.func === 'Shutter button')?.provisional).toBe(
      `${D4_V1.gpio.BTN_SHUTTER} (JP1 pin ${D4_V1.jp1!.pins.BTN_SHUTTER!.pin})`,
    );
    expect(wiring.find((r) => r.func === 'FLASH_EN')?.provisional).toBe('unassigned');
    // The field body has no function button or mode slide, and no JP1 pin
    // is left for one: no row.
    expect(wiring.find((r) => r.func === 'Function button')).toBeUndefined();
    expect(wiring.every((r) => r.status === 'unverified')).toBe(true);
  });

  it('rejects foreign or wrong-schema records', () => {
    expect(importRecord({ kind: 'something-else' })).toMatch(/not a kino/i);
    expect(importRecord({ kind: 'kino-wiring-record', schema: 99 })).toMatch(/schema/i);
    expect(importRecord('nope')).toMatch(/object/i);
  });

  it('round trips an exported record, measurements included', () => {
    useBringUp.setState({
      checks: { a6: true },
      values: { d2: '22.02, 21.98, 22.01' },
      notes: 'pin 1 marked',
    });
    const record = exportRecord();
    useBringUp.setState({ checks: {}, values: {}, notes: '' });
    expect(importRecord(record)).toBeNull();
    expect(useBringUp.getState().checks.a6).toBe(true);
    expect(useBringUp.getState().values.d2).toBe('22.02, 21.98, 22.01');
    expect(useBringUp.getState().notes).toBe('pin 1 marked');
  });

  it('still imports a record written before measurements existed', () => {
    // Values were added after the first builds were recorded. An older
    // export simply has none, which is a fact about that build rather than
    // a broken file — so the schema stays 1 and the field is optional.
    useBringUp.setState({ values: { d2: 'stale' } });
    expect(importRecord({ kind: 'kino-wiring-record', schema: 1, checks: { a6: true } })).toBeNull();
    expect(useBringUp.getState().values).toEqual({});
    expect(useBringUp.getState().checks.a6).toBe(true);
  });

  it('keeps a battery-build record readable: retired ticks import, they just have no row', () => {
    // A record from the LiPo build carries ticks on c1..c10. Import must not
    // reject or drop them -- they are what that build did -- and the sheet
    // simply has no item to show them against.
    expect(importRecord({ kind: 'kino-wiring-record', schema: 1, checks: { c4: true, b6: true } })).toBeNull();
    const checks = useBringUp.getState().checks;
    expect(checks.c4).toBe(true);
    expect(checks.b6).toBe(true);
    expect(allIds()).not.toContain('c4');
    expect(allIds()).toContain('b6');
  });
});
