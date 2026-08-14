// Hardware bring-up state: the spec's first-power checklists plus the
// wiring record, persisted locally and exportable. One record per build.

import { create } from 'zustand';

export interface ChecklistItem {
  id: string;
  text: string;
  /** Inline Studio test available when a camera is connected. */
  test?: 'uart-echo' | 'trigger' | 'captures' | 'selftest';
}

export interface ChecklistSection {
  title: string;
  items: ChecklistItem[];
}

export const CHECKLIST: ChecklistSection[] = [
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
];

export interface WiringRow {
  func: string;
  provisional: string;
  measured: string;
  status: 'unverified' | 'confirmed' | 'moved';
}

const DEFAULT_WIRING: WiringRow[] = [
  { func: 'CAM1 TX → XIAO1 RX', provisional: 'GPIO52', measured: '', status: 'unverified' },
  { func: 'CAM1 RX ← XIAO1 TX', provisional: 'GPIO51', measured: '', status: 'unverified' },
  { func: 'CAM2 TX → XIAO2 RX', provisional: 'GPIO50', measured: '', status: 'unverified' },
  { func: 'CAM2 RX ← XIAO2 TX', provisional: 'GPIO49', measured: '', status: 'unverified' },
  { func: 'CAM3 TX → XIAO3 RX', provisional: 'GPIO34 (strapping!)', measured: '', status: 'unverified' },
  { func: 'CAM3 RX ← XIAO3 TX', provisional: 'GPIO33', measured: '', status: 'unverified' },
  { func: 'CAM4 TX → XIAO4 RX', provisional: 'GPIO30', measured: '', status: 'unverified' },
  { func: 'CAM4 RX ← XIAO4 TX', provisional: 'GPIO29', measured: '', status: 'unverified' },
  { func: 'SYNC_TRIGGER', provisional: 'GPIO32', measured: '', status: 'unverified' },
  { func: 'CAM_PWR_EN', provisional: 'GPIO31', measured: '', status: 'unverified' },
  { func: 'FLASH_EN', provisional: 'GPIO28', measured: '', status: 'unverified' },
  { func: 'Shutter button', provisional: 'unassigned', measured: '', status: 'unverified' },
  { func: 'Function button', provisional: 'unassigned', measured: '', status: 'unverified' },
];

export interface BringUpState {
  checks: Record<string, boolean>;
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
        wiring: Array.isArray(parsed.wiring) && parsed.wiring.length > 0 ? parsed.wiring : DEFAULT_WIRING,
        notes: parsed.notes ?? '',
      };
    }
  } catch {
    // Fresh build.
  }
  return { checks: {}, wiring: structuredClone(DEFAULT_WIRING), notes: '' };
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
    wiring: Array.isArray(r.wiring) && r.wiring.length > 0 ? (r.wiring as WiringRow[]) : structuredClone(DEFAULT_WIRING),
    notes: r.notes ?? '',
  });
  persist();
  return null;
}

export function totalChecks(): number {
  return CHECKLIST.reduce((a, s) => a + s.items.length, 0);
}
