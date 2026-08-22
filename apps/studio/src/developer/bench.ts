// The hardware worksheet (issue #93): every task that needs physical
// hardware, in one place, so the software backlog can close. Stage
// checklists mirror firmware/BENCH_M1B.md; measurement tasks derive from
// the hardware-profile DATA (a recorded measurement removes its own row);
// acceptance items carry the issue that tracks them. Checks persist
// locally, one record per build, exportable like the bring-up record.

import { create } from 'zustand';
import { D4_V1 } from '@kino/hardware-profiles';
import type { HardwareProfile } from '@kino/hardware-profiles';

export interface BenchItem {
  id: string;
  text: string;
}

export interface BenchStage {
  title: string;
  items: BenchItem[];
}

/** firmware/BENCH_M1B.md stages A–E, one row per numbered step. */
export const BENCH_STAGES: BenchStage[] = [
  {
    title: 'A — P4 ONLY',
    items: [
      { id: 'a1', text: 'Power the bare P4; watch SW6106 and P4 temperature by touch for the first minutes' },
      { id: 'a2', text: 'USB enumerates; note WHICH physical USB-C port is USB-Serial-JTAG' },
      { id: 'a3', text: 'Console (UART0, GPIO37/38, 115200) shows P4_BOOT, USB_TRANSPORT_READY, SD_MOUNT, KDP_READY' },
      { id: 'a4', text: 'Studio connects: HELLO inside the 3×500 ms budget with the nonce echoed' },
      { id: 'a5', text: 'GET_CAPABILITIES honest (benchDiagnostics only); GET_HW_VALIDATION shows USB_SERIAL_JTAG validated' },
      { id: 'a6', text: 'REBOOT from Studio; reconnect; session id changes (boot-N+1)' },
      { id: 'a7', text: 'Reboot/reconnect ×10 with no hang, no missed session change' },
    ],
  },
  {
    title: 'B — SD',
    items: [
      { id: 'b1', text: 'Known-good card inserted; boot' },
      { id: 'b2', text: 'GET_STORAGE_STATUS: present, mounted, real capacity, mountAttempts 1, lastError null' },
      { id: 'b3', text: 'STORAGE_SELF_TEST passes, 64 KB verified (Developer → Bench Diagnostics)' },
      { id: 'b4', text: 'Reboot and remount ×10, every mount succeeds' },
      { id: 'b5', text: 'Pre-existing card data untouched (directory listing on a PC)' },
    ],
  },
  {
    title: 'C — CAM1 SAFE BRING-UP',
    items: [
      { id: 'c1', text: 'XIAO flashed over its own USB-C; node console shows the sensor detect line' },
      { id: 'c2', text: 'Wire GND↔GND first, then P4 GPIO52→XIAO GPIO44, P4 GPIO51←XIAO GPIO43; no 5 V from the P4 header yet' },
      { id: 'c3', text: 'Meter: common ground, idle UART lines at 3.3 V' },
      { id: 'c4', text: 'CAM1 probes online ≤ ~2 s; GET_CAMERA_INFO shows real sensor PID, node firmware, power-on reset reason' },
      { id: 'c5', text: 'CAMERA_LINK_STATS: zero crcErrors/timeouts after a minute of idle probing' },
      { id: 'c6', text: 'Nothing abnormal — no hot module, wrong PID, or resets — before any capture' },
    ],
  },
  {
    title: 'D — CAM1 CAPTURE',
    items: [
      { id: 'd1', text: 'CAMERA_TEST on cam1: three checksums agree, four timing buckets reported' },
      { id: 'd2', text: 'Transfer ≈ 2–4 s for a 200–400 KB JPEG at 921600; capture ≤ ~300 ms' },
      { id: 'd3', text: 'Card pulled: /KINO/CAPTURES/<uuid>/C1.JPG opens and LOOKS like the scene; META.JSON parses with the same checksums' },
      { id: 'd4', text: 'Repeat ×10 watching link stats and CAM1_CAPTURE / CAM1_JPEG_TRANSFER / CAM1_SD_WRITE flipping validated' },
    ],
  },
  {
    title: 'E — SOAK',
    items: [
      { id: 'e1', text: 'CAMERA_SOAK_TEST 100 captures @1000 ms, keepAll false: 100/100, zero crc/timeout/sd errors, zero node resets' },
      { id: 'e2', text: 'heapDeltaKB / psramDeltaKB around zero — a steady downward trend fails the milestone' },
      { id: 'e3', text: 'If clean: 500 captures at the same cadence' },
      { id: 'e4', text: 'Summary JSON exported from the panel and attached to issue #66' },
    ],
  },
];

export interface AcceptanceItem extends BenchItem {
  /** Repository issue that tracks the task. */
  issue: number;
}

/** Hardware-gated acceptance work beyond the M1B bench run. */
export const ACCEPTANCE_ITEMS: AcceptanceItem[] = [
  { id: 'hw-validation', text: 'HARDWARE_VALIDATION.md updated from GET_HW_VALIDATION after every stage', issue: 66 },
  { id: 'walk-46', text: 'Studio+Twin §46 acceptance walk performed by a human', issue: 72 },
  { id: 'gpio-lock', text: 'GPIO map validated on the delivered board and locked (Bring-Up wiring record → board_d4v1.h + profile gpio)', issue: 2 },
  { id: 'power-records', text: 'Power, flash, UART, and timing results measured and recorded', issue: 4 },
  { id: 'geometry', text: 'Provisional geometry replaced with measured components (Twin PARTS measured overrides → d4-v1.json)', issue: 1 },
  { id: 'twin-measured', text: 'Twin rebuilt from measured D4-V1 geometry, shells re-enter clearance checking', issue: 11 },
  { id: 'recovery-proof', text: 'Recovery paths (ROM loader, reboot, factory reset) proven on real hardware', issue: 6 },
  { id: 'kdp-decisions', text: 'KDP decisions that need physical firmware resolved and recorded in the contract', issue: 5 },
  { id: 'full-bringup', text: 'Complete four-node D4-V1 bring-up sequence (Milestone 2)', issue: 3 },
];

export interface MeasurementTask {
  id: string;
  /** What to measure, in bench terms. */
  task: string;
  /** What the data currently claims. */
  current: string;
  /** Where the measured value gets recorded. */
  recordIn: string;
}

const fmt = (dims: (number | null)[]) => dims.map((d) => (d === null ? '?' : String(d))).join('×');

/**
 * Derived from the profile data, not a hand-kept list: a component whose
 * dimensions become MEASURED, a GPIO that gets assigned, or an optic that
 * gets a measured FOV drops off this list by editing the data it came from.
 */
export function measurementTasks(profile: HardwareProfile = D4_V1): MeasurementTask[] {
  const tasks: MeasurementTask[] = [];

  if (profile.body.confidence !== 'MEASURED') {
    tasks.push({
      id: 'body',
      task: 'Body envelope and shell geometry (panel thickness, skeleton ribs)',
      current: `${profile.body.confidence} ${fmt(profile.body.sizeMm)} mm envelope`,
      recordIn: 'd4-v1.json body + enclosure-shell/enclosure-chassis components (re-enables shell clearance checks)',
    });
  }

  for (const component of profile.components) {
    const source = component.sources[0];
    if (!source) continue;
    const unmeasured = source.kind !== 'MEASURED' && source.kind !== 'OFFICIAL_CAD';
    const incomplete = source.sizeMm.some((axis) => axis === null);
    // Both enclosure components share the body envelope; covered by the body row.
    if (component.id === 'enclosure-shell' || component.id === 'enclosure-chassis') continue;
    if (unmeasured || incomplete) {
      tasks.push({
        id: `dims-${component.id}`,
        task: `Measure ${component.name} (${component.id}) dimensions`,
        current: `${source.kind} ${fmt(source.sizeMm)} mm${source.note ? ` — ${source.note}` : ''}`,
        recordIn: 'Twin PARTS measured override, then d4-v1.json',
      });
    }
  }

  const camera = profile.components.find((c) => c.id === 'camera-node');
  const specs = camera?.specs as { horizontalFovDeg?: number | null; fovConfidence?: string } | undefined;
  if (specs && (specs.horizontalFovDeg == null || specs.fovConfidence === 'MEASURE_REQUIRED')) {
    tasks.push({
      id: 'fov',
      task: 'Measure real lens FOV (horizontal and vertical) on the delivered OV3660 modules',
      current: `fovConfidence ${specs.fovConfidence ?? 'unknown'}, horizontalFovDeg ${String(specs.horizontalFovDeg ?? null)}`,
      recordIn: 'd4-v1.json camera-node specs (optics overlays consume it)',
    });
  }

  if (profile.instances.filter((i) => i.group === 'camera-bar').every((i) => (i.opticalCenterOffsetMm ?? [0, 0, 0]).every((v) => v === 0))) {
    tasks.push({
      id: 'optical-centers',
      task: 'Measure per-camera optical-center offsets on the assembled bar',
      current: 'all zero (unmeasured)',
      recordIn: 'd4-v1.json instance opticalCenterOffsetMm',
    });
  }

  const unassigned = Object.entries(profile.gpio).filter(([, pin]) => pin === null);
  if (unassigned.length > 0) {
    tasks.push({
      id: 'gpio',
      task: `Assign and verify ${unassigned.length} open GPIO functions: ${unassigned.map(([fn]) => fn).join(', ')}`,
      current: 'null in the profile pin map',
      recordIn: 'd4-v1.json gpio + firmware board_d4v1.h, after the Bring-Up wiring record confirms them',
    });
  }

  return tasks;
}

// ---- persisted checks ----

const STORAGE_KEY = 'kino-studio.bench';

interface BenchState {
  checks: Record<string, boolean>;
  notes: string;
}

function load(): BenchState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as BenchState;
  } catch {
    // Fresh profile or blocked storage.
  }
  return { checks: {}, notes: '' };
}

export const useBench = create<BenchState>(() => load());

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useBench.getState()));
  } catch {
    // Storage full/blocked — the page still works for the session.
  }
}

export function setBenchCheck(id: string, value: boolean) {
  useBench.setState((s) => ({ checks: { ...s.checks, [id]: value } }));
  persist();
}

export function setBenchNotes(notes: string) {
  useBench.setState({ notes });
  persist();
}

export function totalBenchChecks(): number {
  return BENCH_STAGES.reduce((n, s) => n + s.items.length, 0) + ACCEPTANCE_ITEMS.length;
}

export function exportBenchRecord(): object {
  return { schema: 'kino.bench-record', version: 1, ...useBench.getState(), exportedAt: new Date().toISOString() };
}

export function importBenchRecord(raw: unknown): string | null {
  const record = raw as { schema?: unknown; checks?: unknown; notes?: unknown };
  if (record?.schema !== 'kino.bench-record') return 'not a kino.bench-record file';
  useBench.setState({
    checks: (record.checks as Record<string, boolean>) ?? {},
    notes: typeof record.notes === 'string' ? record.notes : '',
  });
  persist();
  return null;
}
