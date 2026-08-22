// KINO Twin §5/§10 telemetry tap: a device-side observation surface for the
// Twin's 3D view. Studio never reads this — it only ever sees the raw KDP
// bytes MockKinoDevice writes to its sink, same as a real camera. This is a
// second, additive channel for the simulator's own rendering, not a way for
// Studio to bypass protocol behavior.
import type { CamId, FocusState, TargetId, LogEntry } from '@kino/kdp';
import type { ScenarioKey, CamFault } from './scenarios';

export type TwinTelemetry =
  | { t: 'capture'; phase: 'begin' | 'committed'; id: number;
      cams: Partial<Record<CamId, { jpegKB: number; durationMs: number }>> }
  | { t: 'fw'; target: TargetId; state: string; pct?: number }
  | { t: 'reboot'; sessionId: string; reason: string }
  | { t: 'scenario'; key: ScenarioKey; value: boolean }
  | { t: 'camFault'; cam: CamId; fault: CamFault | null }
  | { t: 'link'; connected: boolean }
  | { t: 'uploads'; pending: number; uploading: number; failed: number; uploaded: number }
  | { t: 'sd'; activity: 'write' | 'read' }
  | { t: 'af'; cam: CamId; state: FocusState }
  | { t: 'log'; entry: LogEntry }
  /** The device switched firmware profiles (issue #72) — set directly or by
   * an installed OTA artifact whose version maps to a profile. */
  | { t: 'profile'; id: string };

export interface TwinSnapshot {
  sessionId: string; maintenance: boolean;
  batteryV: number; sdPresent: boolean; sdFreeMB: number;
  uartBaud: number; frameIntervalUs: number; phaseAligned: boolean;
  p4Fw: string;
  /** Active firmware profile id (issue #72), e.g. 'd4-m1b' | 'd4-sim-full'. */
  firmwareProfile: string;
  /** True when the profile models capabilities the shipped firmware lacks. */
  simulatedFuture: boolean;
  /** config.wiggle.flash — whether the flash fires on capture. */
  flashEnabled: boolean;
  cams: Record<CamId, { fw: string; phaseUs: number; uartErrors: number; jpegKB: number;
                        durationMs: number; gpioSkewUs: number; fault: CamFault | null; updating: boolean;
                        /** SIMULATED per-cam exposure window (audit #56) — the flash-overlap
                         * model's honest input until real sensor timing is measured. */
                        exposureUs: number;
                        /** Present on AF sensor profiles only (audit #55). */
                        focus: { mode: string; state: FocusState; vcmPosition: number | null;
                                 estimatedDistanceM: number | null; locked: boolean } | null }>;
  roll: { joined: boolean; name: string | null };
  uploads: { pending: number; uploading: number; failed: number; uploaded: number };
  wifi: 'connected' | 'offline';
  scenarios: Record<ScenarioKey, boolean>;
}
