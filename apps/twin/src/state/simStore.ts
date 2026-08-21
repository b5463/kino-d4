import { create } from 'zustand';
import { CAM_IDS, Cmd, KinoProtocolClient, MockTransport } from '@kino/kdp';
import type { CamId, TargetId, Transport } from '@kino/kdp';
import {
  SimRecorder,
  TwinDeviceServer,
  TwinSimulator,
  thermalStep,
} from '@kino/simulator-engine';
import type {
  ActivityState,
  BootStage,
  CaptureStage,
  PowerSample,
  SimEvent,
  SimSessionDoc,
  ThermalState,
  ThermalZone,
} from '@kino/simulator-engine';
import type { TwinSnapshot } from '@kino/test-fixtures';

const IDLE_CAM_STAGES: Record<CamId, CaptureStage> = {
  cam1: 'IDLE',
  cam2: 'IDLE',
  cam3: 'IDLE',
  cam4: 'IDLE',
};

const INACTIVE_CAMS: Record<CamId, boolean> = { cam1: false, cam2: false, cam3: false, cam4: false };
const ZERO_UART: Record<CamId, number> = { cam1: 0, cam2: 0, cam3: 0, cam4: 0 };
const COOL_THERMALS: Record<ThermalZone, ThermalState> = {
  battery: 'COOL',
  sw6106: 'COOL',
  led: 'COOL',
  heatsink: 'COOL',
  batteryConnector: 'COOL',
};

export interface SimState {
  running: boolean;
  bootStage: BootStage;
  studioConnected: boolean;
  camStage: Record<CamId, CaptureStage>;
  uartActive: Record<CamId, boolean>;
  uartBytesPerSec: Record<CamId, number>;
  sdActive: boolean;
  sdActiveAt: number;
  syncPulseAt: number;
  fw: Partial<Record<TargetId, { state: string; pct?: number }>>;
  power: PowerSample | null;
  thermal: Record<ThermalZone, ThermalState>;
  snapshot: TwinSnapshot | null;
  recording: boolean;
  powerOn(): void;
  powerOff(): void;
  testCapture(): Promise<void>;
  startRecording(): void;
  stopRecording(): SimSessionDoc | null;
}

export function initialSimState(): SimState {
  return {
    running: false,
    bootStage: 'POWER_OFF',
    studioConnected: false,
    camStage: { ...IDLE_CAM_STAGES },
    uartActive: { ...INACTIVE_CAMS },
    uartBytesPerSec: { ...ZERO_UART },
    sdActive: false,
    sdActiveAt: 0,
    syncPulseAt: 0,
    fw: {},
    power: null,
    thermal: { ...COOL_THERMALS },
    snapshot: null,
    recording: false,
    powerOn: powerOnRuntime,
    powerOff: powerOffRuntime,
    testCapture,
    startRecording,
    stopRecording,
  };
}

function activityFromState(state: Pick<SimState, 'running' | 'camStage' | 'uartActive' | 'snapshot'>): ActivityState {
  const camsOn = state.running
    ? CAM_IDS.filter((cam) => {
        const fault = state.snapshot?.cams[cam].fault;
        return fault !== 'offline' && fault !== 'power-open';
      })
    : [];
  return {
    p4On: state.running,
    camsOn,
    camsCapturing: camsOn.filter((cam) => state.camStage[cam] === 'EXPOSING'),
    uartActive: camsOn.filter((cam) => state.uartActive[cam]),
    flashA: 0,
    wifiUploading: (state.snapshot?.uploads.uploading ?? 0) > 0,
    chargingA: 0,
  };
}

/** Pure event reducer; callers pass `nowMs` so pulse/activity timestamps remain testable. */
export function applySimEvent(prev: SimState, event: SimEvent, nowMs = Date.now()): Partial<SimState> {
  switch (event.t) {
    case 'boot':
      return {
        bootStage: event.stage,
        running: event.stage !== 'POWER_OFF',
        ...(event.stage === 'BOOTING_P4'
          ? { camStage: { ...IDLE_CAM_STAGES }, uartActive: { ...INACTIVE_CAMS }, uartBytesPerSec: { ...ZERO_UART } }
          : {}),
      };
    case 'cam-stage':
      return { camStage: { ...prev.camStage, [event.cam]: event.stage } };
    case 'sync-pulse':
      return { syncPulseAt: nowMs };
    case 'uart':
      return {
        uartActive: { ...prev.uartActive, [event.cam]: event.active },
        uartBytesPerSec: { ...prev.uartBytesPerSec, [event.cam]: event.active ? event.bytesPerSec : 0 },
      };
    case 'power':
      return {
        power: event.sample,
        thermal: thermalStep(prev.thermal, event.sample, activityFromState(prev), 500).zones,
      };
    case 'device': {
      const telemetry = event.telemetry;
      if (telemetry.t === 'reboot') {
        return {
          camStage: { ...IDLE_CAM_STAGES },
          uartActive: { ...INACTIVE_CAMS },
          uartBytesPerSec: { ...ZERO_UART },
          fw: {},
        };
      }
      if (telemetry.t === 'fw') {
        return { fw: { ...prev.fw, [telemetry.target]: { state: telemetry.state, ...(telemetry.pct === undefined ? {} : { pct: telemetry.pct }) } } };
      }
      if (telemetry.t === 'sd') return { sdActive: true, sdActiveAt: nowMs };
      return {};
    }
  }
}

interface TwinRuntime {
  sim: TwinSimulator;
  server: TwinDeviceServer;
  recorder: SimRecorder;
  unsubscribeEvent: () => void;
  unsubscribeClient: () => void;
}

let runtime: TwinRuntime | null = null;
let snapshotTimer: ReturnType<typeof setInterval> | null = null;
let sdDecayTimer: ReturnType<typeof setTimeout> | null = null;

function refreshSnapshot(): void {
  if (runtime) useSimStore.setState({ snapshot: runtime.sim.snapshot() });
}

function handleEvent(event: SimEvent): void {
  const current = useSimStore.getState();
  useSimStore.setState(applySimEvent(current, event, Date.now()));
  if (event.t === 'device' || event.t === 'boot') refreshSnapshot();
  if (event.t === 'device' && event.telemetry.t === 'sd') {
    if (sdDecayTimer) clearTimeout(sdDecayTimer);
    sdDecayTimer = setTimeout(() => useSimStore.setState({ sdActive: false }), 350);
  }
}

export function getTwinRuntime(): TwinRuntime {
  if (runtime) return runtime;
  const sim = new TwinSimulator({ seed: 18 });
  const recorder = new SimRecorder(sim);
  const server = new TwinDeviceServer(sim, { recorder });
  runtime = {
    sim,
    server,
    recorder,
    unsubscribeEvent: sim.onEvent(handleEvent),
    unsubscribeClient: server.onClientChange((studioConnected) => useSimStore.setState({ studioConnected })),
  };
  return runtime;
}

function startSnapshotRefresh(): void {
  if (snapshotTimer) return;
  refreshSnapshot();
  snapshotTimer = setInterval(refreshSnapshot, 1_000);
}

function stopSnapshotRefresh(): void {
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = null;
  if (sdDecayTimer) clearTimeout(sdDecayTimer);
  sdDecayTimer = null;
}

function powerOnRuntime(): void {
  const active = getTwinRuntime();
  active.server.start();
  active.sim.powerOn();
  startSnapshotRefresh();
}

function powerOffRuntime(): void {
  stopSnapshotRefresh();
  if (runtime) {
    runtime.server.stop();
    runtime.sim.powerOff();
    runtime.unsubscribeClient();
    runtime.unsubscribeEvent();
    runtime.sim.dispose();
    runtime = null;
  }
  useSimStore.setState(initialSimState());
}

class RecorderTransport implements Transport {
  readonly kind = 'mock' as const;
  constructor(private readonly inner: Transport, private readonly recorder: SimRecorder) {}
  open(): Promise<void> { return this.inner.open(); }
  close(): Promise<void> { return this.inner.close(); }
  write(data: Uint8Array): Promise<void> { this.recorder.noteIn(data); return this.inner.write(data); }
  onData(cb: (data: Uint8Array) => void): void { this.inner.onData((data) => { this.recorder.noteOut(data); cb(data); }); }
  onClose(cb: (reason?: string) => void): void { this.inner.onClose(cb); }
}

/** Issues the UI test shot through raw framed KDP against the Twin's own device. */
export async function testCapture(): Promise<void> {
  const active = getTwinRuntime();
  const state = useSimStore.getState();
  if (state.bootStage !== 'READY') throw new Error('Twin must be SIM READY before a test capture');
  if (state.studioConnected) throw new Error('Disconnect Studio before using the private test client');

  const transport = new RecorderTransport(new MockTransport(active.sim.device), active.recorder);
  const client = new KinoProtocolClient(transport);
  await transport.open();
  try {
    await client.hello({ attempts: 1 });
    await client.request(Cmd.CAMERA_CAPTURE, {});
  } finally {
    client.dispose();
    await transport.close();
  }
}

export function startRecording(): void {
  const active = getTwinRuntime();
  if (!useSimStore.getState().running) throw new Error('Power on Twin before recording');
  active.recorder.start();
  useSimStore.setState({ recording: true });
}

export function stopRecording(): SimSessionDoc | null {
  if (!runtime?.recorder.recording()) return null;
  const doc = runtime.recorder.stop();
  useSimStore.setState({ recording: false });
  return doc;
}

export const useSimStore = create<SimState>(() => initialSimState());
