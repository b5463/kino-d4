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

/**
 * "GPIO1 (JP1 pin 7)" for an assigned signal, read from the profile so the
 * bench text cannot drift from the pin map it describes.
 */
function jp1Pin(fn: string, profile: HardwareProfile = D4_V1): string {
  const slot = profile.jp1?.pins[fn];
  const gpio = profile.gpio[fn];
  if (!slot) return gpio ?? `${fn} (unassigned)`;
  return `${slot.gpio} (JP1 pin ${slot.pin})`;
}

/** firmware/BENCH_M1B.md stages A–E, one row per numbered step. */
export const BENCH_STAGES: BenchStage[] = [
  {
    title: 'A — P4 ONLY',
    items: [
      // The field body is USB-C powered (ECN-0004): there is no SW6106 in the
      // camera, so the first minutes are spent on the module's own regulators.
      { id: 'a1', text: 'Power the bare P4 over its USB-C; watch the module’s regulators and the P4 by touch for the first minutes' },
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
      { id: 'b6', text: 'STORAGE_BENCH 16 MB @ 64 KB: record write MB/s and worstBlockMs — a 4-frame burst stalls on the worst block, not the average' },
    ],
  },
  {
    title: 'C — CAM1 SAFE BRING-UP',
    items: [
      { id: 'c1', text: 'XIAO flashed over its own USB-C; node console shows the sensor detect line' },
      { id: 'c2', text: `Wire GND↔GND first (JP1 pin 5 or 6), then P4 ${jp1Pin('CAM1_TX')}→XIAO GPIO44, P4 ${jp1Pin('CAM1_RX')}←XIAO GPIO43; no 5 V from the P4 header yet` },
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
  { id: 'power-records', text: 'USB-C bus power, UART, and timing results measured and recorded', issue: 4 },
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

  // The body is OFFICIAL_CAD from hardware/cad/KINO_FIELD_BODY: the six shells
  // are generated, gated and released, so the envelope is not owed a caliper
  // the way a provisional box was. It is owed one again only if the data
  // drops back to a provisional figure.
  if (profile.body.confidence !== 'MEASURED' && profile.body.confidence !== 'OFFICIAL_CAD') {
    tasks.push({
      id: 'body',
      task: 'Body envelope as printed (overall size across the chassis halves, face shell on)',
      current: `${profile.body.confidence} ${fmt(profile.body.sizeMm)} mm envelope`,
      recordIn: 'd4-v1.json body + the field-* shell components (re-enables shell clearance checks)',
    });
  }

  // Only parts that are actually placed in this build owe a measurement.
  // `components` keeps the BOM history — battery, BMS, SW6106 module, fuse,
  // speaker, caps, slide switch — but the field body fits none of them, and a
  // part that is not in the camera cannot be put on the bench.
  const fitted = new Set(profile.instances.map((instance) => instance.component));
  for (const component of profile.components) {
    if (!fitted.has(component.id)) continue;
    const source = component.sources[0];
    if (!source) continue;
    const unmeasured = source.kind !== 'MEASURED' && source.kind !== 'OFFICIAL_CAD';
    const incomplete = source.sizeMm.some((axis) => axis === null);
    if (unmeasured || incomplete) {
      tasks.push({
        id: `dims-${component.id}`,
        task: `Measure ${component.name} (${component.id}) dimensions`,
        current: `${source.kind} ${fmt(source.sizeMm)} mm${source.note ? ` — ${source.note}` : ''}`,
        // The Twin's PARTS tree opens MEASURE ACTUAL PART on a component;
        // SAVE MEASUREMENT stores the measured override.
        recordIn: 'Twin PARTS → MEASURE ACTUAL PART (measured override), then d4-v1.json',
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

  {
    // Keyed on provenance, not on the numbers: the CAD places every lens
    // 6.95 mm off its board centre, which is a design figure and not a bench
    // one, so a non-zero offset must not read as "measured".
    const cams = profile.instances.filter((i) => i.group === 'camera-bar');
    if (!cams.every((i) => (i.opticalCenterConfidence ?? 'PROVISIONAL') === 'MEASURED')) {
      const kinds = [...new Set(cams.map((i) => i.opticalCenterConfidence ?? 'PROVISIONAL'))].join(', ');
      tasks.push({
        id: 'optical-centers',
        task: 'Measure per-camera optical-center offsets on the assembled bar',
        current: `${kinds} (from the body CAD, not the bench)`,
        recordIn: 'd4-v1.json instance opticalCenterOffsetMm + opticalCenterConfidence',
      });
    }
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
