// #230: the customer shell's sentences, derived from real states, and the
// words that must never reach a customer's screen.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attentionLine, attentionRows } from '../src/customer/attention';
import type { AttentionInput } from '../src/customer/attention';
import { cameraName, cameraNameFromSerial, connectCopy, deviceProtocolFrom, resultCaption, shotsLeft, statusSentence } from '../src/customer/copy';

const NONE: AttentionInput = { storage: { present: true, totalMB: 30000, freeMB: 27000 }, cameras: [], calibration: null, stats: null, network: null, roll: null, updateVersion: null };

describe('identity', () => {
  it('defaults to the serial’s last four digits and prefers a given name', () => {
    expect(cameraNameFromSerial('KD4-SIM-0001')).toBe('KINO 0001');
    expect(cameraNameFromSerial(null)).toBe('KINO');
    const info = { serial: 'KD4-0412' } as Parameters<typeof cameraName>[0];
    expect(cameraName(info, null)).toBe('KINO 0412');
    expect(cameraName(info, { body: { name: "Alex's KINO" } } as Parameters<typeof cameraName>[1])).toBe("Alex's KINO");
  });

  it('counts photos the way the camera does and never announces ready', () => {
    expect(shotsLeft({ present: true, totalMB: 100, freeMB: 61 })).toBe(10);
    expect(shotsLeft({ present: false, totalMB: 0, freeMB: 0 })).toBeNull();
    expect(resultCaption(null, { present: true, totalMB: 100, freeMB: 30 })).toBe('Room for 5 more');
    expect(statusSentence('connected', null)).toBeNull();
    expect(statusSentence('reconnecting', null)).toBe('KINO is restarting.');
    expect(statusSentence('updating', null)).toBe('KINO is updating. Keep it plugged in.');
    expect(statusSentence('connected', 'MATCHING THE LENSES')).toBe('KINO is busy.');
  });
});

describe('No KINO copy for every connection state', () => {
  it('speaks the customer’s words for each phase and fault', () => {
    expect(connectCopy('disconnected', null, null, true, null).sentence).toBe('Plug in KINO.');
    expect(connectCopy('requesting-port', null, null, true, null).sentence).toBe('Choose KINO in the list your browser just opened.');
    expect(connectCopy('handshaking', null, null, true, null)).toMatchObject({ sentence: 'Looking for KINO…', faint: true });
    expect(connectCopy('error', 'hardware', 'Device answered as "X" — not a KINO', true, null).sentence).toBe("That wasn't a KINO.");
    expect(connectCopy('error', 'hardware', 'KINO disconnected unexpectedly', true, null).sentence).toBe('KINO was unplugged.');
    expect(connectCopy('error', null, 'Handshake failed: timed out', true, null).sentence).toBe("KINO isn't answering.");
    expect(connectCopy('recovery', null, null, true, null).sentence).toBe("KINO didn't come back after restarting.");
    expect(connectCopy('disconnected', null, null, false, null).body).toContain('Chrome or Edge');
  });

  it('says which side needs updating on a compatibility fault', () => {
    expect(deviceProtocolFrom('device selected protocol 9')).toBe(9);
    expect(deviceProtocolFrom('nothing here')).toBeNull();
    const older = connectCopy('error', 'protocol-mismatch', 'device protocol 0', true, null);
    expect(older.sentence).toBe('KINO needs an update before Studio can work with it.');
    const newer = connectCopy('error', 'protocol-mismatch', 'device protocol 99', true, null);
    expect(newer.sentence).toBe('Studio needs updating before it can work with this KINO.');
    expect(newer.help).toBe(true);
  });
});

describe('attention', () => {
  it('is silent when nothing matters', () => {
    expect(attentionRows(NONE)).toEqual([]);
    expect(attentionLine([])).toBeNull();
  });

  it('names the lens by position and says KINO still shoots', () => {
    const cams = [1, 2, 3, 4].map((n) => ({ id: `cam${n}`, online: n !== 2, state: 'ready' })) as AttentionInput['cameras'];
    const rows = attentionRows({ ...NONE, cameras: cams });
    expect(rows.map((r) => r.sentence)).toContain("The centre-left lens isn't answering. KINO shoots with three.");
  });

  it('puts one row on the line itself and several behind See what', () => {
    const one = attentionRows({ ...NONE, storage: { present: true, totalMB: 100, freeMB: 0 } });
    expect(attentionLine(one)).toMatchObject({ sentence: "The card is full. KINO can't save photos until you make room.", action: 'Photos' });
    const two = attentionRows({ ...NONE, storage: { present: false, totalMB: 0, freeMB: 0 }, updateVersion: '0.5.0' });
    expect(two.map((r) => r.id)).toEqual(['no-card', 'update']);
    expect(attentionLine(two)).toMatchObject({ sentence: 'KINO needs attention.', action: 'See what' });
  });

  it('knows Roll uploads waiting for Wi-Fi and a warm body', () => {
    const rows = attentionRows({
      ...NONE,
      stats: { tempC: { p4: 78, cams: [null, null, null, null] } } as AttentionInput['stats'],
      network: { state: 'disconnected', ssid: null, ip: null, rssi: null, since: null, internet: false },
      roll: { active: true, roll: { rollId: 'r', slug: 'amber-001', guestUrl: '', name: 'x', role: 'host', joinedAt: 0 }, queue: { pending: 14, uploading: 0, failed: 0, uploaded: 0, draining: false } },
    });
    expect(rows.map((r) => r.sentence)).toEqual(expect.arrayContaining(['Roll uploads are waiting for Wi-Fi. 14 photos.', 'KINO is warm inside. The finder slows until it cools. Shooting still works.']));
  });
});

/**
 * The rendered-copy rule (#230 §73): none of these may appear in a string a
 * customer can read. The scan covers every string literal and every run of
 * JSX text under customer/, comments stripped, so an identifier such as
 * `p4Firmware` does not trip it while a sentence would.
 */
const FORBIDDEN = ['CAM1', 'CAM2', 'CAM3', 'CAM4', 'P4', 'C6', 'XIAO', 'ESP32', 'protocol', 'handshake', 'transport', 'config rev', 'manifest', 'SHA', 'esptool', 'mired', 'RSSI', 'dBm', 'filesystem', 'mount', 'component target', 'firmware image', 'package folder', 'ECN', 'not read by firmware', 'not wired', 'Twin'];

function customerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return customerFiles(p);
    return /\.(tsx?|css)$/.test(name) ? [p] : [];
  });
}

function readableStrings(source: string): string[] {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of noComments.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of noComments.matchAll(/>([^<>{}]+)</g)) out.push(m[1]!);
  return out.map((s) => s.trim()).filter((s) => /\s/.test(s) || /[A-Z]{2}/.test(s));
}

describe('forbidden words never reach a rendered customer string', () => {
  it('scans every customer source file', () => {
    const files = customerFiles(join(__dirname, '..', 'src', 'customer'));
    expect(files.length).toBeGreaterThan(5);
    const hits: string[] = [];
    for (const file of files) {
      for (const text of readableStrings(readFileSync(file, 'utf8'))) {
        for (const word of FORBIDDEN) {
          const re = new RegExp(`(^|[^A-Za-z0-9_-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`, word === word.toLowerCase() ? 'i' : '');
          if (re.test(text)) hits.push(`${file.split(/[\\/]/).slice(-2).join('/')}: "${text}" (${word})`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
