import type { CamId } from '@kino/kdp';
import { CAM_IDS } from '@kino/kdp';
import type { BootStage, CaptureStage } from '@kino/simulator-engine';
import type { TwinSnapshot } from '@kino/test-fixtures';

/** Native panel resolution of the Guition 4.3in display, landscape. */
export const DISPLAY_W = 800;
export const DISPLAY_H = 480;

/**
 * The subset of CanvasRenderingContext2D the drawer uses. Tests pass a
 * recording fake; the app passes a real 2D context.
 */
export interface Ctx2d {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

export interface DeviceUiState {
  running: boolean;
  bootStage: BootStage;
  camStage: Record<CamId, CaptureStage>;
  fw: Partial<Record<string, { state: string; pct?: number }>>;
  snapshot: TwinSnapshot | null;
  studioConnected: boolean;
}

const BG = '#0b0d0e';
const FG = '#d7dde2';
const DIM = '#5c666e';
const OK = '#3fae55';
const WARN = '#e8c93f';
const BAD = '#ff3b30';
const MONO = 'px "Cascadia Mono", "Consolas", monospace';

function text(ctx: Ctx2d, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left'): void {
  ctx.font = `${size}${MONO}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(s, x, y);
}

function statusBar(ctx: Ctx2d, snap: TwinSnapshot, studioConnected: boolean): void {
  ctx.fillStyle = '#111417';
  ctx.fillRect(0, 0, DISPLAY_W, 44);
  text(ctx, `KINO D4  FW ${snap.p4Fw}`, 16, 12, 22, FG);
  text(ctx, `${snap.batteryV.toFixed(2)} V`, DISPLAY_W - 16, 12, 22, snap.batteryV < 3.5 ? BAD : FG, 'right');
  const sd = snap.sdPresent ? `SD ${Math.round(snap.sdFreeMB)} MB` : 'NO SD';
  text(ctx, sd, DISPLAY_W - 140, 12, 22, snap.sdPresent ? FG : BAD, 'right');
  text(ctx, snap.wifi === 'connected' ? 'WIFI' : 'NO WIFI', DISPLAY_W - 300, 12, 22, snap.wifi === 'connected' ? OK : DIM, 'right');
  if (studioConnected) text(ctx, 'STUDIO', DISPLAY_W - 430, 12, 22, OK, 'right');
}

/** Stages a capture passes through; STORED/READY are settled, not in-flight. */
const IN_FLIGHT: readonly CaptureStage[] = ['ARMING', 'WAIT_SYNC', 'EXPOSING', 'JPEG_READY', 'TRANSFERRING'];

function camRow(ctx: Ctx2d, state: DeviceUiState): void {
  const snap = state.snapshot;
  const y = DISPLAY_H - 56;
  ctx.fillStyle = '#111417';
  ctx.fillRect(0, y - 8, DISPLAY_W, 64);
  CAM_IDS.forEach((cam, i) => {
    const fault = snap?.cams[cam].fault ?? null;
    const stage = state.camStage[cam];
    const label = fault ? `${cam.toUpperCase()} ${fault.toUpperCase()}` : `${cam.toUpperCase()} ${stage}`;
    const color = fault ? BAD : IN_FLIGHT.includes(stage) ? WARN : stage === 'IDLE' ? DIM : OK;
    text(ctx, label, 16 + i * 196, y, 20, color);
    // AF line (audit #55): present only on autofocus sensor profiles.
    const focus = snap?.cams[cam].focus ?? null;
    if (focus) {
      const afColor = focus.state === 'locked' ? OK : focus.state === 'failed' ? BAD : focus.state === 'searching' ? WARN : DIM;
      text(ctx, `AF ${focus.state.toUpperCase()}`, 16 + i * 196, y + 24, 16, afColor);
    }
  });
}

function viewfinder(ctx: Ctx2d, state: DeviceUiState): void {
  const top = 44;
  const bottom = DISPLAY_H - 64;
  const h = bottom - top;

  // Synthetic preview field: framing marks + crosshair. Deliberately not an
  // image — there is no real sensor behind this, and the label says so.
  ctx.fillStyle = '#14181b';
  ctx.fillRect(0, top, DISPLAY_W, h);
  ctx.strokeStyle = '#2a3238';
  ctx.lineWidth = 2;
  ctx.strokeRect(40, top + 24, DISPLAY_W - 80, h - 48);
  ctx.beginPath();
  ctx.moveTo(DISPLAY_W / 2 - 24, top + h / 2);
  ctx.lineTo(DISPLAY_W / 2 + 24, top + h / 2);
  ctx.moveTo(DISPLAY_W / 2, top + h / 2 - 24);
  ctx.lineTo(DISPLAY_W / 2, top + h / 2 + 24);
  ctx.stroke();

  const cam2Fault = state.snapshot?.cams.cam2.fault ?? null;
  if (cam2Fault) {
    text(ctx, `CAM2 ${cam2Fault.toUpperCase()} — NO PREVIEW`, DISPLAY_W / 2, top + h / 2 + 40, 24, BAD, 'center');
  } else {
    text(ctx, 'CAM2 PREVIEW · SIMULATED', DISPLAY_W / 2, top + h / 2 + 40, 24, DIM, 'center');
  }

  const roll = state.snapshot?.roll;
  if (roll?.joined) text(ctx, `ROLL ${roll.name ?? ''}`.trim(), 52, top + 36, 20, FG);
  const uploads = state.snapshot?.uploads;
  if (uploads && uploads.pending + uploads.uploading + uploads.failed > 0) {
    const line = `UPLOADS ${uploads.uploading} UP · ${uploads.pending} QUEUED${uploads.failed ? ` · ${uploads.failed} FAILED` : ''}`;
    text(ctx, line, 52, top + 64, 20, uploads.failed ? BAD : FG);
  }
}

function captureOverlay(ctx: Ctx2d, state: DeviceUiState): void {
  const active = CAM_IDS.filter((cam) => IN_FLIGHT.includes(state.camStage[cam]));
  if (active.length === 0) return;
  const exposing = active.some((cam) => state.camStage[cam] === 'EXPOSING');
  ctx.fillStyle = 'rgba(11,13,14,0.75)';
  ctx.fillRect(0, DISPLAY_H / 2 - 52, DISPLAY_W, 104);
  text(ctx, exposing ? 'CAPTURING' : 'TRANSFERRING', DISPLAY_W / 2, DISPLAY_H / 2 - 34, 36, WARN, 'center');
  text(ctx, active.map((cam) => `${cam.toUpperCase()} ${state.camStage[cam]}`).join('   '), DISPLAY_W / 2, DISPLAY_H / 2 + 14, 20, FG, 'center');
}

/** Update states that own the whole screen. Terminal states ('idle',
 * 'ready') return to the normal UI; 'error' shows as a line there instead of
 * a permanent takeover. */
const ACTIVE_FW_STATES = ['receiving', 'verifying', 'applying', 'rebooting'];

function fwErrorLine(ctx: Ctx2d, state: DeviceUiState): void {
  const failed = Object.entries(state.fw).filter(([, v]) => v?.state === 'error');
  if (failed.length === 0) return;
  text(ctx, `FW UPDATE FAILED: ${failed.map(([target]) => target.toUpperCase()).join(' ')}`, DISPLAY_W / 2, 56, 22, BAD, 'center');
}

function fwOverlay(ctx: Ctx2d, state: DeviceUiState): boolean {
  const updating = Object.entries(state.fw).filter(([, v]) => v && ACTIVE_FW_STATES.includes(v.state));
  if (updating.length === 0) return false;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);
  text(ctx, 'FIRMWARE UPDATE', DISPLAY_W / 2, 120, 32, FG, 'center');
  text(ctx, 'DO NOT POWER OFF', DISPLAY_W / 2, 168, 22, WARN, 'center');
  updating.forEach(([target, v], i) => {
    const pct = v?.pct === undefined ? '' : ` ${Math.round(v.pct)}%`;
    text(ctx, `${target.toUpperCase()}  ${v?.state.toUpperCase()}${pct}`, DISPLAY_W / 2, 232 + i * 36, 24, FG, 'center');
  });
  return true;
}

/** Draws the full on-device UI for the current simulated state. Pure: no DOM,
 * no store access — everything it shows arrives through `state`. */
export function drawDeviceUi(ctx: Ctx2d, state: DeviceUiState): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

  if (!state.running || state.bootStage === 'POWER_OFF') {
    text(ctx, 'POWER OFF', DISPLAY_W / 2, DISPLAY_H / 2 - 14, 28, DIM, 'center');
    return;
  }

  if (state.bootStage !== 'READY') {
    text(ctx, 'KINO D4', DISPLAY_W / 2, 140, 40, FG, 'center');
    text(ctx, state.bootStage.replaceAll('_', ' '), DISPLAY_W / 2, 220, 26, WARN, 'center');
    if (state.snapshot) text(ctx, `FW ${state.snapshot.p4Fw}`, DISPLAY_W / 2, 268, 20, DIM, 'center');
    return;
  }

  if (fwOverlay(ctx, state)) return;

  if (state.snapshot) statusBar(ctx, state.snapshot, state.studioConnected);
  viewfinder(ctx, state);
  fwErrorLine(ctx, state);
  camRow(ctx, state);
  captureOverlay(ctx, state);
}
