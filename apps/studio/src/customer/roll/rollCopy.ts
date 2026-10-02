// The Roll page's sentences and the code's shape. Pure.

import type { NetworkStatus, UploadQueueReport } from '../../roll/rollTypes';

/** The detail line under the count: one sentence, the most useful one. */
export function uploadDetail(queue: UploadQueueReport | null, network: NetworkStatus | null): { text: string; action: 'retry' | 'wifi' | null } {
  if (!queue) return { text: 'Waiting for KINO to report.', action: null };
  if (network && network.state !== 'connected') {
    const waiting = queue.pending + queue.failed;
    return {
      text: `No Wi-Fi. KINO still shoots. ${waiting} ${waiting === 1 ? 'photo' : 'photos'} will upload when it's back.`,
      action: 'wifi',
    };
  }
  if (queue.failed > 0) return { text: `${queue.failed} didn't upload.`, action: 'retry' };
  if (network && network.state === 'connected' && !network.internet && queue.pending > 0) {
    return { text: "KINO Roll is unreachable right now. Photos wait on the card and go when it's back.", action: null };
  }
  if (queue.uploading > 0) return { text: 'Uploading now.', action: null };
  if (queue.pending > 0) return { text: `${queue.pending} waiting to upload.`, action: null };
  return { text: 'All uploaded.', action: null };
}

/**
 * A join code as the host's screen shows it. The Roll server mints six
 * characters from an alphabet with the look-alikes taken out (apps/roll-web
 * LandingPage); a camera on its own mints a slug like "amber-001". Both are
 * accepted as typed: letters, digits and dashes, up to the camera's 48.
 */
export function normaliseJoinCode(raw: string): string {
  const kept = raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 48);
  return /^[A-Za-z0-9]{1,6}$/.test(kept) ? kept.toUpperCase() : kept.toLowerCase();
}

export function joinCodeReady(code: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,47}$/i.test(code);
}

/** The code's size on the active page: six characters read from across a table; a long slug drops. */
export function codeSizePx(code: string): number {
  if (code.length <= 6) return 96;
  if (code.length <= 10) return 64;
  if (code.length <= 20) return 44;
  return 32;
}
