// Every sentence the customer shell says about the camera's state, derived
// from the real connection and device stores. Pure functions so the copy can
// be asserted without a DOM.

import { PROTOCOL_VERSION } from '@kino/kdp';
import type { ConnectionFault, ConnectionPhase } from '../state/connectionStore';
import type { DeviceInfo, KinoConfig, StorageStatus } from '@kino/kdp';
import type { KnownCamera } from '../state/knownCameras';

/** "KINO 0412": the customer's name if one is set, else the serial's last four digits. */
export function cameraName(info: DeviceInfo | null, config: KinoConfig | null): string {
  const given = config?.body?.name?.trim();
  if (given) return given;
  return cameraNameFromSerial(info?.serial ?? null);
}

export function cameraNameFromSerial(serial: string | null): string {
  if (!serial) return 'KINO';
  const digits = serial.replace(/\D/g, '');
  return digits.length >= 4 ? `KINO ${digits.slice(-4)}` : `KINO ${serial}`;
}

/** The camera's own rule: photographs left at 6 MB each (docs/DEVICE_COPY.md). */
export const MB_PER_PHOTO = 6;

export function shotsLeft(storage: StorageStatus | null): number | null {
  if (!storage || !storage.present) return null;
  return Math.max(0, Math.floor(storage.freeMB / MB_PER_PHOTO));
}

export function withThousands(n: number): string {
  return n.toLocaleString('en-GB');
}

/** "18:01" — times are always 24-hour, no seconds. */
export function clock(ts: number): string {
  const ms = ts < 1e11 ? ts * 1000 : ts;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "21 September" — dates in the product's own style. */
export function dayName(date = new Date()): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

/** "yesterday", "today", "3 days ago", "on 21 September". */
export function lastSeenPhrase(lastSeen: number, now = Date.now()): string {
  const days = Math.floor((now - lastSeen) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${dayName(new Date(lastSeen))}`;
}

/** "18:01 · 4,571 more" under the last photo; the count is the camera's own. */
export function resultCaption(ts: number | null, storage: StorageStatus | null): string {
  const left = shotsLeft(storage);
  const parts: string[] = [];
  if (ts !== null) parts.push(clock(ts));
  if (left !== null) parts.push(left <= 5 ? `Room for ${left} more` : `${withThousands(left)} more`);
  return parts.join(' · ');
}

/**
 * The one line above the page that is empty when there is nothing to say.
 * Ready is the default and is never announced. Returns null for silence.
 */
export function statusSentence(phase: ConnectionPhase, busyLabel: string | null): string | null {
  if (phase === 'reconnecting') return 'KINO is restarting.';
  if (phase === 'updating' || phase === 'maintenance') return 'KINO is updating. Keep it plugged in.';
  if (busyLabel) return 'KINO is busy.';
  return null;
}

export interface ConnectCopy {
  sentence: string;
  body: string | null;
  /** Which button, if any. */
  button: 'connect' | 'retry' | null;
  /** The drawing is faint while Studio is looking. */
  faint: boolean;
  /** A help link belongs under the sentence. */
  help: boolean;
}

/**
 * The version on the other end, when the handshake message names it. The
 * protocol client reports "device selected protocol N" style text; anything
 * that does not parse leaves the question open.
 */
export function deviceProtocolFrom(error: string | null): number | null {
  if (!error) return null;
  const m = /protocol\D{0,20}(\d+)/i.exec(error);
  return m ? Number(m[1]) : null;
}

/** The No KINO screen's sentence and body for every real connection state. */
export function connectCopy(
  phase: ConnectionPhase,
  fault: ConnectionFault | null,
  error: string | null,
  serialSupported: boolean,
  remembered: KnownCamera | null,
): ConnectCopy {
  const plain = { faint: false, help: false };
  if (!serialSupported) {
    return { sentence: 'Plug in KINO.', body: "This browser can't talk to KINO. Use Chrome or Edge.", button: null, ...plain };
  }
  if (phase === 'requesting-port') {
    return { sentence: 'Choose KINO in the list your browser just opened.', body: null, button: null, ...plain };
  }
  if (phase === 'connecting' || phase === 'handshaking') {
    return { sentence: 'Looking for KINO…', body: null, button: null, faint: true, help: false };
  }
  if (phase === 'recovery') {
    return {
      sentence: "KINO didn't come back after restarting.",
      body: 'Unplug it, wait ten seconds, plug it back in. Studio is watching for it.',
      button: 'connect',
      ...plain,
    };
  }
  if (phase === 'error') {
    if (fault === 'protocol-mismatch') {
      const theirs = deviceProtocolFrom(error);
      const studioOlder = theirs !== null && theirs > PROTOCOL_VERSION;
      return {
        sentence: studioOlder
          ? 'Studio needs updating before it can work with this KINO.'
          : 'KINO needs an update before Studio can work with it.',
        body: studioOlder
          ? 'Open the newest Studio, then connect again.'
          : 'This KINO is older than Studio can talk to. Get help to bring it up to date.',
        button: 'retry',
        faint: false,
        help: true,
      };
    }
    if (error && /not a KINO/i.test(error)) {
      return {
        sentence: "That wasn't a KINO.",
        body: 'Pick the one that says KINO D4. If nothing does, try another USB-C port.',
        button: 'retry',
        ...plain,
      };
    }
    if (error && /did not come back|link went silent|stopped answering/i.test(error)) {
      return { sentence: 'KINO stopped answering.', body: 'Unplug it, wait five seconds, plug it back in.', button: 'connect', ...plain };
    }
    // A live link that closed without being asked is the cable, whatever the
    // transport called it; a link that never opened is answered below.
    if (fault === 'hardware' && !(error && /could not open|handshake failed/i.test(error))) {
      return { sentence: 'KINO was unplugged.', body: 'Plug it back in and it will carry on.', button: 'connect', ...plain };
    }
    return {
      sentence: "KINO isn't answering.",
      body: "Check both ends of the cable. If KINO's screen is dark, hold the power slide to switch it on.",
      button: 'retry',
      ...plain,
    };
  }
  if (remembered) {
    return {
      sentence: `Plug in ${cameraNameFromSerial(remembered.serial)}.`,
      body: `Last connected ${lastSeenPhrase(remembered.lastSeen)}.`,
      button: 'connect',
      ...plain,
    };
  }
  return { sentence: 'Plug in KINO.', body: 'Use the USB-C cable. KINO can be on or off.', button: 'connect', ...plain };
}

/** The issue link the camera's own SCAN FOR HELP opens, with the unit filled in. */
export function helpUrl(info: DeviceInfo | null, studioVersion: string): string {
  const title = encodeURIComponent(`KINO ${info?.serial ?? ''} — help`.trim());
  const body = encodeURIComponent(
    [`Studio ${studioVersion}`, info ? `KINO ${info.p4Firmware} · ${info.serial}` : 'KINO not connected', '', 'What happened:'].join('\n'),
  );
  return `https://github.com/b5463/kino-d4/issues/new?title=${title}&body=${body}`;
}
