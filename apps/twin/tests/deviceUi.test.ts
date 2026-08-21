import { describe, expect, it } from 'vitest';
import type { CamId } from '@kino/kdp';
import type { TwinSnapshot } from '@kino/test-fixtures';
import { drawDeviceUi } from '../src/display/deviceUi';
import type { Ctx2d, DeviceUiState } from '../src/display/deviceUi';

function fakeCtx(): { ctx: Ctx2d; texts: () => string[] } {
  const drawn: string[] = [];
  const ctx: Ctx2d = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', textBaseline: 'top', lineWidth: 1,
    fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText(text: string) { drawn.push(text); },
  };
  return { ctx, texts: () => drawn };
}

function snapshot(overrides: Partial<TwinSnapshot> = {}): TwinSnapshot {
  const cam = { fw: '1.2.0', phaseUs: 0, uartErrors: 0, jpegKB: 400, durationMs: 0, gpioSkewUs: 3, fault: null, updating: false };
  return {
    sessionId: 's1', maintenance: false,
    batteryV: 3.98, sdPresent: true, sdFreeMB: 28_000,
    uartBaud: 921600, frameIntervalUs: 33_333, phaseAligned: true,
    p4Fw: '1.2.0',
    cams: { cam1: { ...cam }, cam2: { ...cam }, cam3: { ...cam }, cam4: { ...cam } },
    roll: { joined: false, name: null },
    uploads: { pending: 0, uploading: 0, failed: 0, uploaded: 0 },
    wifi: 'connected',
    scenarios: {} as TwinSnapshot['scenarios'],
    ...overrides,
  };
}

function state(overrides: Partial<DeviceUiState> = {}): DeviceUiState {
  const idle: Record<CamId, DeviceUiState['camStage'][CamId]> = { cam1: 'IDLE', cam2: 'IDLE', cam3: 'IDLE', cam4: 'IDLE' };
  return {
    running: true, bootStage: 'READY', camStage: idle, fw: {}, snapshot: snapshot(), studioConnected: false,
    ...overrides,
  };
}

describe('drawDeviceUi', () => {
  it('powered off shows only POWER OFF', () => {
    const { ctx, texts } = fakeCtx();
    drawDeviceUi(ctx, state({ running: false, bootStage: 'POWER_OFF', snapshot: null }));
    expect(texts()).toEqual(['POWER OFF']);
  });

  it('booting shows the stage name and firmware version', () => {
    const { ctx, texts } = fakeCtx();
    drawDeviceUi(ctx, state({ bootStage: 'CAMERA_NODES_BOOT' }));
    expect(texts()).toContain('CAMERA NODES BOOT');
    expect(texts()).toContain('FW 1.2.0');
  });

  it('ready shows firmware, battery voltage and the labelled simulated preview', () => {
    const { ctx, texts } = fakeCtx();
    drawDeviceUi(ctx, state());
    expect(texts()).toContain('KINO D4  FW 1.2.0');
    expect(texts()).toContain('3.98 V');
    expect(texts()).toContain('CAM2 PREVIEW · SIMULATED');
    expect(texts()).toContain('CAM1 IDLE');
  });

  it('an in-flight capture raises the CAPTURING overlay; settled stages do not', () => {
    const { ctx, texts } = fakeCtx();
    drawDeviceUi(ctx, state({ camStage: { cam1: 'EXPOSING', cam2: 'EXPOSING', cam3: 'WAIT_SYNC', cam4: 'STORED' } }));
    expect(texts()).toContain('CAPTURING');

    const settled = fakeCtx();
    drawDeviceUi(settled.ctx, state({ camStage: { cam1: 'STORED', cam2: 'READY', cam3: 'STORED', cam4: 'STORED' } }));
    expect(settled.texts()).not.toContain('CAPTURING');
    expect(settled.texts()).not.toContain('TRANSFERRING');
  });

  it('a cam2 fault replaces the preview label and the cam row shows the fault', () => {
    const { ctx, texts } = fakeCtx();
    const snap = snapshot();
    snap.cams.cam2 = { ...snap.cams.cam2, fault: 'offline' };
    drawDeviceUi(ctx, state({ snapshot: snap }));
    expect(texts()).toContain('CAM2 OFFLINE — NO PREVIEW');
    expect(texts()).toContain('CAM2 OFFLINE');
  });

  it('a firmware update takes over the screen with progress and a power warning', () => {
    const { ctx, texts } = fakeCtx();
    drawDeviceUi(ctx, state({ fw: { cam3: { state: 'writing', pct: 62 } } }));
    expect(texts()).toContain('FIRMWARE UPDATE');
    expect(texts()).toContain('DO NOT POWER OFF');
    expect(texts()).toContain('CAM3  WRITING 62%');
    expect(texts()).not.toContain('CAM2 PREVIEW · SIMULATED');
  });

  it('failed uploads surface on the ready screen', () => {
    const { ctx, texts } = fakeCtx();
    drawDeviceUi(ctx, state({ snapshot: snapshot({ uploads: { pending: 3, uploading: 1, failed: 2, uploaded: 9 } }) }));
    expect(texts()).toContain('UPLOADS 1 UP · 3 QUEUED · 2 FAILED');
  });
});
