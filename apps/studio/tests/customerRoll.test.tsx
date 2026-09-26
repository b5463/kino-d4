// #230: Roll. The upload sentence for every real queue state, the code's
// shape as the server and the camera actually mint it, and the active page
// against a long code.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codeSizePx, joinCodeReady, normaliseJoinCode, uploadDetail } from '../src/customer/roll/rollCopy';
import { ActiveRoll } from '../src/customer/roll/ActiveRoll';
import type { NetworkStatus } from '../src/roll/rollTypes';

const wifi: NetworkStatus = { state: 'connected', ssid: 'venue', ip: null, rssi: -55, since: null, internet: true };
const noWifi: NetworkStatus = { ...wifi, state: 'disconnected', internet: false };
const noInternet: NetworkStatus = { ...wifi, internet: false };
const q = (patch: Partial<{ pending: number; uploading: number; failed: number; uploaded: number }>) => ({ pending: 0, uploading: 0, failed: 0, uploaded: 118, draining: false, ...patch });

describe('the upload sentence', () => {
  it('says one thing at a time, the most useful one', () => {
    expect(uploadDetail(q({}), wifi).text).toBe('All uploaded.');
    expect(uploadDetail(q({ pending: 6 }), wifi).text).toBe('6 waiting to upload.');
    expect(uploadDetail(q({ uploading: 1, pending: 2 }), wifi).text).toBe('Uploading now.');
    expect(uploadDetail(q({ failed: 2 }), wifi)).toEqual({ text: "2 didn't upload.", action: 'retry' });
    expect(uploadDetail(null, wifi).text).toBe('Waiting for KINO to report.');
  });

  it('treats no Wi-Fi as a fact, not an error, and names the unreachable server', () => {
    expect(uploadDetail(q({ pending: 14 }), noWifi)).toEqual({ text: "No Wi-Fi. KINO still shoots. 14 photos will upload when it's back.", action: 'wifi' });
    expect(uploadDetail(q({ pending: 3 }), noInternet).text).toBe("KINO Roll is unreachable right now. Photos wait on the card and go when it's back.");
  });
});

describe('the code', () => {
  it('accepts the server’s six characters and the camera’s own slug', () => {
    expect(normaliseJoinCode(' ab c2 3d ')).toBe('ABC23D');
    expect(normaliseJoinCode('amber-001')).toBe('amber-001');
    expect(normaliseJoinCode('Summer Party!! 2026')).toBe('summerparty2026');
    expect(joinCodeReady('ABC23D')).toBe(true);
    expect(joinCodeReady('amber-001')).toBe(true);
    expect(joinCodeReady('ab')).toBe(false);
  });

  it('drops the size for a long code instead of truncating it', () => {
    expect(codeSizePx('NXVJHK')).toBe(96);
    expect(codeSizePx('amber-001')).toBe(64);
    expect(codeSizePx('summer-party-2026')).toBe(44);
    expect(codeSizePx('summer-party-at-the-lake-house-2026')).toBe(32);
  });
});

describe('the active page', () => {
  const roll = { rollId: 'r1', slug: 'summer-party-at-the-lake-house-2026', guestUrl: 'https://kino.roll/x', name: 'Saturday', role: 'host' as const, joinedAt: Date.UTC(2026, 8, 26, 18, 14) };
  const render = (props: Partial<Parameters<typeof ActiveRoll>[0]>) =>
    renderToStaticMarkup(
      createElement(ActiveRoll, {
        roll,
        queue: q({ pending: 6 }),
        network: wifi,
        guestUrl: roll.guestUrl,
        hostUrl: null,
        downloadsOn: null,
        pin: null,
        busy: false,
        onRetry: () => undefined,
        onSetupWifi: () => undefined,
        onEnd: async () => undefined,
        ...props,
      }),
    );

  it('shows the whole long code, the count and no PIN it does not know', () => {
    const html = render({});
    expect(html).toContain('summer-party-at-the-lake-house-2026');
    expect(html).toContain('--code-size:32px');
    expect(html).toContain('118');
    expect(html).toContain('6 waiting to upload.');
    expect(html).not.toContain('Guest PIN');
    expect(html).not.toContain('Change');
    expect(html).toContain('End Roll');
  });

  it('shows the PIN and downloads only when this session set them', () => {
    const html = render({ pin: '4471', downloadsOn: true });
    expect(html).toContain('Guest PIN 4471');
    expect(html).toContain('Downloads on');
  });
});
