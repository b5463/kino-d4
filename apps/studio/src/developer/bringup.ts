// Hardware bring-up state: the spec's first-power checklists plus the
// wiring record, persisted locally and exportable. One record per build.
//
// V1 is a usable camera in a printed body, not a rig on a desk, and V2 is the
// custom board in a moulded case. So the worksheet runs past the electrical
// build: the printed body is structure that holds the lens baseline, the
// closed body is the only place the thermal and power numbers V2 needs can be
// measured, and a camera someone carries has to be reliable, not merely
// functional. Items that produce a measurement capture it — a tick that
// records no number wastes the run it came from.

import { create } from 'zustand';
import { D4_V1 } from '@kino/hardware-profiles';

export interface ChecklistItem {
  id: string;
  text: string;
  /** Inline Studio test available when a camera is connected. */
  test?: 'uart-echo' | 'trigger' | 'captures' | 'selftest' | 'snapshot';
  /**
   * Unit hint for a value worth keeping. Present when the check produces a
   * number that outlives the tick — a measured pitch, a peak current, a die
   * temperature. These are V2's inputs and most of them cannot be taken
   * again once the build is apart or the card is reformatted.
   */
  record?: string;
}

export interface ChecklistSection {
  title: string;
  /** Why this section exists, when that is not obvious from the items. */
  note?: string;
  items: ChecklistItem[];
}

export const CHECKLIST: ChecklistSection[] = [
  {
    title: 'CAMERA MODULE INCOMING CHECK — ONE BOARD AT A TIME',
    note:
      'Runs per module, before any harness exists, with the board on its own USB-C cable and ' +
      'firmware/uvc-preview flashed — it makes the board a plain USB webcam, so any camera app ' +
      'is the viewer. Four modules that each work are not four modules that match: field of view ' +
      'and colour have to agree across the set, or the wiggle inherits the difference. Label each ' +
      'physical module now; which one becomes CAM1..CAM4 is the harness’s decision, but which ' +
      'module is which has to survive the trip.',
    items: [
      { id: 'm1', text: 'Module count received, and each one labelled physically', record: 'count' },
      { id: 'm2', text: 'Sensor PID reported per module — all OV3660 (0x3660), no substitutions', record: 'pid ×n' },
      { id: 'm3', text: 'Live picture from every module in a host camera app' },
      { id: 'm4', text: 'Colour cast noted per module — a whole-frame pink or green is a register set, not a dead sensor', record: 'per module' },
      { id: 'm5', text: 'Focus judged at ~1 m and close up; a module soft everywhere stays soft in the camera', record: 'per module' },
      { id: 'm6', text: 'Field of view agrees across all four — one tighter or wider is a different lens', record: 'agree / differs' },
      { id: 'm7', text: 'Lens capped: frame is black, not speckled. White wall: no blotches' },
      { id: 'm8', text: 'Stream rate and empty-frame count per module from the close-of-stream log', record: 'fps / empty' },
      { id: 'm9', text: 'Spare or rejected modules set aside and marked, not left in the pile' },
    ],
  },
  {
    title: 'BEFORE ANY POWER',
    items: [
      { id: 'a1', text: 'LiPo inspected — no dents, swelling, puncture, damaged seams' },
      { id: 'a2', text: 'Battery connector +, − and NTC measured; wire colors not trusted' },
      { id: 'a3', text: 'Cell confirmed as standard 1S, 4.20 V full' },
      { id: 'a4', text: 'BMS pad labels and topology verified' },
      { id: 'a5', text: 'SW6106 cell-voltage selector confirmed at 4.20 V' },
      { id: 'a6', text: 'Perfboard pre-connected strips mapped' },
      { id: 'a7', text: 'All four 1N5819 directions verified — band toward XIAO' },
      { id: 'a8', text: 'All four AO4407 source/drain/gate connections verified' },
      { id: 'a9', text: 'All four 2N3904 E/B/C verified for the delivered package' },
      { id: 'a10', text: 'Electrolytic capacitor polarity checked' },
      { id: 'a11', text: '+5 V to GND not shorted' },
      { id: 'a12', text: 'Camera switched outputs off with CAM_PWR_EN floating' },
      { id: 'a13', text: 'Guition 26-pin header mapped; IDC orientation confirmed' },
      { id: 'a14', text: 'Pin 1 marked permanently on PCB, cable, carrier, enclosure' },
      { id: 'a15', text: 'No conductor or screw can touch the pouch cell' },
      { id: 'a16', text: 'Flash chamber thermally and optically isolated from battery/cameras' },
    ],
  },
  {
    title: 'BENCH BRING-UP — LIPO DISCONNECTED',
    items: [
      { id: 'b1', text: 'Unpopulated 5 V/GND carrier bus tested' },
      { id: 'b2', text: 'One MOSFET/NPN channel tested with a dummy load' },
      { id: 'b3', text: 'One XIAO powered through AO4407 + 1N5819; leakage and startup current checked' },
      { id: 'b4', text: 'All four power channels tested separately' },
      { id: 'b5', text: 'Guition board tested alone at verified 5 V pins' },
      { id: 'b6', text: 'One UART at low speed, then all four at 921600', test: 'uart-echo' },
      { id: 'b7', text: 'Shared trigger edges checked before connecting camera GPIOs', test: 'trigger' },
      { id: 'b8', text: 'One-camera capture, then four armed captures without flash', test: 'captures' },
      { id: 'b9', text: 'LED driver + LED tested separately at 350 mA; temperatures monitored' },
      { id: 'b10', text: 'Flash control off-at-reset behavior proven before integration' },
      { id: 'b11', text: 'SD writes and speaker verified at low volume', test: 'selftest' },
      { id: 'b12', text: 'All-camera capture while recording 5 V, current and skew', test: 'trigger' },
    ],
  },
  {
    title: 'BATTERY-PATH BRING-UP',
    items: [
      { id: 'c1', text: '3 A fast fuse installed near battery/BMS output' },
      { id: 'c2', text: 'Battery open-circuit voltage plausible for 1S LiPo' },
      { id: 'c3', text: 'Voltage and polarity at BMS P+/P− confirmed before SW6106' },
      { id: 'c4', text: 'SW6106 powered from protected cell with load disconnected' },
      { id: 'c5', text: '5 V output confirmed before connecting the carrier' },
      { id: 'c6', text: 'P4/display only — battery current and sag observed' },
      { id: 'c7', text: 'One camera added, then all four' },
      { id: 'c8', text: 'Flash added last' },
      { id: 'c9', text: 'Connector/wire/battery/driver/LED temperatures measured during repeated shots' },
      { id: 'c10', text: 'First charge: camera off, 5 V ~1 A, attended' },
    ],
  },
  {
    title: 'PRINTED BODY — V1 STRUCTURE',
    note:
      'The printed body is not packaging: it holds the lens baseline, and baseline accuracy is ' +
      'wiggle quality. PLA and PETG creep, so pitch is a measured property of the part in front ' +
      'of you, never a number copied from CAD.',
    items: [
      { id: 'd1', text: 'Front plate material and print orientation recorded', record: 'material / orientation' },
      { id: 'd2', text: 'Lens pitch measured as printed — all three gaps, not one doubled', record: 'mm, mm, mm' },
      { id: 'd3', text: 'Measured pitch entered in Twin and the hardware manifest (#11, #1)' },
      { id: 'd4', text: 'Plate checked for bow across the four-lens span', record: 'mm deviation' },
      { id: 'd5', text: 'All four lens axes parallel within measurement' },
      { id: 'd6', text: 'Camera modules seat without pre-load — no body flex reaches a sensor board' },
      { id: 'd7', text: 'Flash chamber optically isolated inside the body — no light path into a lens' },
      { id: 'd8', text: 'No screw, standoff or conductor can reach the pouch cell when the body is squeezed' },
      { id: 'd9', text: 'Pitch re-measured after one full disassembly and reassembly', record: 'mm, mm, mm' },
      { id: 'd10', text: 'Pitch re-measured after the camera has lived in a bag for a month — creep is the number V2’s frame has to beat', record: 'mm, mm, mm' },
    ],
  },
  {
    title: 'CLOSED-BODY POWER AND THERMAL — V2 INPUTS',
    note:
      'An open bench is the best cooling this camera will ever see and a sealed resin case is ' +
      'the worst, so passing thermals in the open proves nothing about V2. Run every item with ' +
      'the body closed, and record the number even when the check passes — these size the ' +
      'custom board’s regulators, bulk capacitance and any venting the mould needs.',
    items: [
      { id: 'e1', text: 'Peak per-rail current during a four-flash burst', record: 'A peak / ms' },
      { id: 'e2', text: '5 V rail sag at the worst burst; brownout margin stated', record: 'V min' },
      { id: 'e3', text: 'P4 die temperature after 20 back-to-back captures, body closed', record: '°C' },
      { id: 'e4', text: 'Camera die temperatures on the same run', record: '°C ×4' },
      { id: 'e5', text: 'Same run with the body open — the delta is what the enclosure costs', record: '°C delta' },
      { id: 'e6', text: 'Battery runtime to first brownout, captures counted', record: 'captures / min' },
      { id: 'e7', text: 'Case surface temperature during an attended full charge, body closed', record: '°C' },
      { id: 'e8', text: 'Real JPEG size range across a mixed roll — sizes PSRAM and transfer budgets', record: 'KB min–max' },
      { id: 'e9', text: 'Worst-case node-link latency after a full session', test: 'snapshot', record: 'ms' },
    ],
  },
  {
    title: 'THE EFFECT ITSELF',
    note:
      'The one test no simulator can stand in for, and the only one that can invalidate the ' +
      'product rather than the build. Run it before committing to a mould.',
    items: [
      { id: 'f1', text: 'Inter-frame skew measured on a moving subject, not a static scene', test: 'trigger', record: 'ms spread' },
      { id: 'f2', text: 'Wiggle reviewed on a phone at the size guests see it, not on a monitor' },
      { id: 'f3', text: 'Verdict recorded: is the parallax the effect, or is the skew the effect?', record: 'verdict' },
      { id: 'f4', text: 'Skew re-checked at the shortest usable subject distance, where parallax is largest', record: 'ms spread' },
      { id: 'f5', text: 'A roll shot at a real event, reviewed by someone who did not build it' },
    ],
  },
  {
    title: 'FIELD RELIABILITY — “USABLE” IS A RELIABILITY CLAIM',
    note:
      'A hang on the bench costs a reset. A hang at capture #40 during an event loses the roll ' +
      'and the evening, and nobody reruns the party.',
    items: [
      { id: 'g1', text: '200 captures without a reset; failures counted, not just noticed', record: 'fails / 200' },
      { id: 'g2', text: 'Card survives power loss mid-write and still mounts', test: 'selftest' },
      { id: 'g3', text: 'A node that stops answering recovers without a full power cycle' },
      { id: 'g4', text: 'A full card mid-roll produces a message, not a hang' },
      { id: 'g5', text: 'Low battery during a flash burst behaves as defined, and the definition is written down' },
      { id: 'g6', text: 'Device numbers captured after every failure, before power-cycling', test: 'snapshot' },
      { id: 'g7', text: 'Shutter reachable and the camera pointable without looking at it' },
    ],
  },
];

export interface WiringRow {
  func: string;
  provisional: string;
  measured: string;
  status: 'unverified' | 'confirmed' | 'moved';
}

/**
 * "GPIO52 (JP1 pin 7)" from the hardware profile, or "unassigned" when the
 * gpio map holds null. The wiring record starts from the data the firmware
 * is cross-checked against, not from a hand-typed copy of it.
 */
function provisionalPin(fn: string): string {
  const slot = D4_V1.jp1?.pins[fn];
  if (slot) return `${slot.gpio} (JP1 pin ${slot.pin})`;
  return D4_V1.gpio[fn] ?? 'unassigned';
}

const row = (func: string, fn: string): WiringRow => ({
  func,
  provisional: provisionalPin(fn),
  measured: '',
  status: 'unverified',
});

const DEFAULT_WIRING: WiringRow[] = [
  row('CAM1 TX → XIAO1 RX', 'CAM1_TX'),
  row('CAM1 RX ← XIAO1 TX', 'CAM1_RX'),
  row('CAM2 TX → XIAO2 RX', 'CAM2_TX'),
  row('CAM2 RX ← XIAO2 TX', 'CAM2_RX'),
  row('CAM3 TX → XIAO3 RX', 'CAM3_TX'),
  row('CAM3 RX ← XIAO3 TX', 'CAM3_RX'),
  row('CAM4 TX → XIAO4 RX', 'CAM4_TX'),
  row('CAM4 RX ← XIAO4 TX', 'CAM4_RX'),
  row('SYNC_TRIGGER', 'SYNC_OUT'),
  row('CAM_PWR_EN', 'CAM_PWR_EN'),
  row('FLASH_EN', 'FLASH_EN'),
  row('Shutter button', 'BTN_SHUTTER'),
  row('Function button', 'BTN_FN'),
];

export interface BringUpState {
  checks: Record<string, boolean>;
  /** Measured values by item id, for checks that carry a `record` hint. */
  values: Record<string, string>;
  wiring: WiringRow[];
  notes: string;
}

const KEY = 'kino-studio.bringup';

function load(): BringUpState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BringUpState>;
      return {
        checks: parsed.checks ?? {},
        values: parsed.values ?? {},
        wiring: Array.isArray(parsed.wiring) && parsed.wiring.length > 0 ? parsed.wiring : DEFAULT_WIRING,
        notes: parsed.notes ?? '',
      };
    }
  } catch {
    // Fresh build.
  }
  return { checks: {}, values: {}, wiring: structuredClone(DEFAULT_WIRING), notes: '' };
}

export const useBringUp = create<BringUpState>(() => load());

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(useBringUp.getState()));
  } catch {
    // Storage blocked.
  }
}

export function setCheck(id: string, done: boolean) {
  useBringUp.setState((s) => ({ checks: { ...s.checks, [id]: done } }));
  persist();
}

export function setValue(id: string, value: string) {
  useBringUp.setState((s) => ({ values: { ...s.values, [id]: value } }));
  persist();
}

export function setWiringRow(index: number, patch: Partial<WiringRow>) {
  useBringUp.setState((s) => ({
    wiring: s.wiring.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  }));
  persist();
}

export function setNotes(notes: string) {
  useBringUp.setState({ notes });
  persist();
}

export function exportRecord() {
  return {
    schema: 1,
    kind: 'kino-wiring-record',
    exportedAt: new Date().toISOString(),
    ...useBringUp.getState(),
  };
}

export function importRecord(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return 'Not a JSON object';
  const r = json as Partial<BringUpState> & { kind?: string; schema?: number };
  if (r.kind !== 'kino-wiring-record') return 'Not a KINO wiring record';
  if (r.schema !== 1) return `Unsupported schema ${String(r.schema)}`;
  useBringUp.setState({
    checks: r.checks ?? {},
    // Added after the first records were written; an older export simply has
    // no measurements, which is a fact about that build, not a bad file.
    values: r.values ?? {},
    wiring: Array.isArray(r.wiring) && r.wiring.length > 0 ? (r.wiring as WiringRow[]) : structuredClone(DEFAULT_WIRING),
    notes: r.notes ?? '',
  });
  persist();
  return null;
}

export function totalChecks(): number {
  return CHECKLIST.reduce((a, s) => a + s.items.length, 0);
}
