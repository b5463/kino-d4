// KINO Twin §5/§10 telemetry tap: a device-side observation surface for the
// Twin's 3D view. Studio never reads this — it only ever sees the raw KDP
// bytes MockKinoDevice writes to its sink, same as a real camera. This is a
// second, additive channel for the simulator's own rendering, not a way for
// Studio to bypass protocol behavior.
import type { CamId, TargetId, LogEntry } from '@kino/kdp';
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
  | { t: 'log'; entry: LogEntry };

export interface TwinSnapshot {
  sessionId: string; maintenance: boolean;
  batteryV: number; sdPresent: boolean; sdFreeMB: number;
  uartBaud: number; frameIntervalUs: number; phaseAligned: boolean;
  p4Fw: string;
  cams: Record<CamId, { fw: string; phaseUs: number; uartErrors: number; jpegKB: number;
                        durationMs: number; gpioSkewUs: number; fault: CamFault | null; updating: boolean }>;
  roll: { joined: boolean; name: string | null };
  uploads: { pending: number; uploading: number; failed: number; uploaded: number };
  wifi: 'connected' | 'offline';
  scenarios: Record<ScenarioKey, boolean>;
}
