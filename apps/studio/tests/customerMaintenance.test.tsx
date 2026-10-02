// #230: the update as one bar and three sentences over the real store,
// which release counts as ready, what matching says when it fails, what
// Check KINO says, and the controls that must not exist without the
// capability behind them.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceInfo } from '@kino/kdp';
import type { TargetProgress } from '../src/state/updateStore';
import { setDeviceState, clearDeviceState, supports, useDeviceStore } from '../src/state/deviceStore';
import { noteLines, updateView } from '../src/customer/kino/updatePhase';
import { newerRelease } from '../src/customer/kino/useUpdateCheck';
import type { CatalogRelease } from '../src/firmware/catalog';
import { checkSentences, matchFailure } from '../src/customer/kino/matchCopy';
import { signalWord } from '../src/customer/kino/WifiSettings';
import { CameraSettingsList, SLEEP_OPTIONS } from '../src/customer/kino/CameraSettings';
import { BottomNav } from '../src/customer/BottomNav';
import { ConfirmSheet } from '../src/customer/Dialog';

const t = (id: TargetProgress['id'], status: TargetProgress['status'], progress = 0): TargetProgress => ({ id, label: id, status, progress, error: null });

describe('the update, aggregated truthfully', () => {
  it('is Preparing before any bytes move, Updating while they do, Restarting at the end', () => {
    const waiting = [t('cam1', 'waiting'), t('cam2', 'waiting'), t('p4', 'waiting')];
    expect(updateView({ targets: waiting, phase: 'updating', halted: false, finished: false, downloading: false }).sentence).toBe('Preparing KINO.');
    expect(updateView({ targets: [], phase: 'connected', halted: false, finished: false, downloading: true }).sentence).toBe('Preparing KINO.');
    const sending = [t('cam1', 'updated', 1), t('cam2', 'sending', 0.5), t('p4', 'waiting')];
    const v = updateView({ targets: sending, phase: 'updating', halted: false, finished: false, downloading: false });
    expect(v.sentence).toBe('Updating KINO. Keep it plugged in.');
    expect(v.progress).toBeCloseTo(0.5, 2);
    expect(updateView({ targets: [t('p4', 'rebooting', 1)], phase: 'reconnecting', halted: false, finished: false, downloading: false }).sentence).toBe('Restarting KINO.');
  });

  it('stops partway without a raw error and finishes as ready', () => {
    const halted = [t('cam1', 'updated', 1), t('cam2', 'failed', 0.3), t('p4', 'not-started')];
    expect(updateView({ targets: halted, phase: 'maintenance', halted: true, finished: false, downloading: false })).toMatchObject({ stage: 'stopped', sentence: 'The update stopped partway.' });
    expect(updateView({ targets: halted, phase: 'connected', halted: false, finished: true, downloading: false })).toMatchObject({ stage: 'done', progress: 1 });
  });

  it('picks the newest compatible release that is newer than the camera', () => {
    const info = { p4Firmware: '0.4.58' } as DeviceInfo;
    const rel = (release: string, compatible = true): CatalogRelease => ({ release, compatible, channel: 'stable', publishedAt: '', reasons: [], notes: null, manifest: {} as CatalogRelease['manifest'] });
    expect(newerRelease([rel('0.4.58'), rel('0.5.0'), rel('0.6.0', false), rel('0.4.60')], info)?.release).toBe('0.5.0');
    expect(newerRelease([rel('0.4.58')], info)).toBeNull();
    expect(noteLines('- Wigglegrams play smoother.\n* Roll uploads resume.\n')).toEqual(['Wigglegrams play smoother.', 'Roll uploads resume.']);
  });
});

describe('matching and checking', () => {
  it('names a lens that is not answering by position and blames the light otherwise', () => {
    expect(matchFailure('CAM2 is not answering — all four cameras are required')).toEqual({ kind: 'lens', sentence: "The centre-left lens isn't answering, so the lenses can't be matched yet." });
    expect(matchFailure('CAM4 is offline')).toMatchObject({ sentence: "The right lens isn't answering, so the lenses can't be matched yet." });
    expect(matchFailure('flat scene')).toEqual({ kind: 'light', sentence: "The light wasn't even. Try a different wall." });
  });

  it('turns check rows into sentences and says Nothing to fix when they pass', () => {
    expect(checkSentences([{ name: 'P4 heap', status: 'pass', detail: '' }, { name: 'SD card', status: 'skip', detail: '' }])).toEqual([]);
    expect(checkSentences([{ name: 'CAM1 link', status: 'fail', detail: 'timeout' }])).toEqual(["The left lens didn't pass its check. KINO may shoot with three."]);
    expect(checkSentences([{ name: 'SD write', status: 'fail', detail: '' }])).toEqual(["The card didn't pass its check. Try another card."]);
  });

  it('says the signal in one word', () => {
    expect(signalWord({ state: 'connected', ssid: 'x', ip: null, rssi: -50, since: null, internet: true })).toBe('Strong');
    expect(signalWord({ state: 'connected', ssid: 'x', ip: null, rssi: -65, since: null, internet: true })).toBe('Fair');
    expect(signalWord({ state: 'connected', ssid: 'x', ip: null, rssi: -80, since: null, internet: true })).toBe('Weak');
    expect(signalWord({ state: 'disconnected', ssid: null, ip: null, rssi: null, since: null, internet: false })).toBe('Not in range');
  });
});

describe('capability gating', () => {
  const body = { name: 'Alex', brightness: 5, autoDimS: 20, sleepS: 120, camIdleTimeoutS: 0, sounds: { startup: true, ui: true, save: true, warning: true }, buttons: { fn: 'flash' as const, slide: 'mode' as const } };
  const caps = { cameraCount: 4, wiggle: true, quad: true, gallery: true, flashControl: true, vsyncTelemetry: false, phaseCalibration: false, xiaoProxyUpdate: false, linkBench: false, customSounds: false };
  const list = (canDim: boolean) =>
    renderToStaticMarkup(createElement(CameraSettingsList, { body, placeholder: 'KD4-0412', canDim, readOnly: false, write: () => undefined, mark: () => null, retry: () => undefined }));

  it('renders no Brightness on a body that cannot dim, and no time zone at all', () => {
    const html = list(false);
    expect(html).toContain('Screen sleeps after');
    expect(html).toContain('Button sounds');
    expect(html).not.toContain('Brightness');
    expect(html).not.toContain('Time zone');
    expect(SLEEP_OPTIONS.map((o) => o.value)).toEqual([60, 120, 300, 0]);
    expect(list(true)).toContain('Brightness');
  });

  it('reads brightnessControl as the one flag that is only false when the camera says so', () => {
    clearDeviceState();
    setDeviceState({ capabilitiesState: 'loaded', capabilities: { ...caps, brightnessControl: false } });
    expect(supports(useDeviceStore.getState(), 'brightnessControl')).toBe(false);
    setDeviceState({ capabilities: { ...caps } });
    expect(supports(useDeviceStore.getState(), 'brightnessControl')).toBe(true);
    // The other flags are a no when absent: a quad control on a body that never advertised quad is invented.
    expect(supports(useDeviceStore.getState(), 'network')).toBe(false);
    clearDeviceState();
  });
});

describe('accessibility markup', () => {
  it('marks the current section and locks the nav while updating', () => {
    const html = renderToStaticMarkup(createElement(BottomNav, { page: 'photos', locked: false, onNavigate: () => undefined }));
    expect(html).toContain('aria-current="page">Photos');
    expect(html).toContain('aria-label="Sections"');
    const locked = renderToStaticMarkup(createElement(BottomNav, { page: 'shoot', locked: true, onNavigate: () => undefined }));
    expect(locked.match(/disabled=""/g)?.length).toBe(4);
  });

  it('puts Cancel last in the dialog, in outline, with the warning only on the destructive word', () => {
    const html = renderToStaticMarkup(createElement(ConfirmSheet, { open: true, confirmLabel: 'Delete', warning: true, onConfirm: () => undefined, onCancel: () => undefined, children: createElement('p', null, 'Delete this photo?') }));
    expect(html).toContain('c-button c-button--warning">Delete');
    expect(html).toContain('c-button c-button--outline">Cancel');
    expect(html.indexOf('Delete<')).toBeLessThan(html.indexOf('Cancel<'));
  });
});
