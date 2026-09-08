// Which camera a capture frame came from.
//
// The file name is the only authority for the slot. A grouped capture stores
// only the cameras that answered (firmware-contract D23), so a card can hold
// C1/C3/C4 with no C2 at all — and everything that used the array position
// instead was then labelling, calibrating, naming and metering the wrong
// camera: with C2 missing, C3's frame took CAM2's offsets and printed under a
// CAM2 label. Nothing downstream may infer a slot from a position.

import { CAM_IDS, type CamId } from '@kino/kdp';

/**
 * The slot a capture file belongs to, read off its name: `C3.JPG` → `cam3`.
 *
 * Null for any name that does not state one — `THUMB.JPG`, or a loose JPEG in
 * an imported folder with no META.JSON. A null slot is reported as such; it is
 * never quietly filled in from the position.
 */
export function slotFromFileName(name: string): CamId | null {
  // Card paths never reach here, but an imported name might carry one.
  const base = name.split(/[\\/]/).pop() ?? name;
  const m = /^c(\d+)(?:[^0-9]|$)/i.exec(base);
  if (!m) return null;
  const id = `cam${Number(m[1])}` as CamId;
  return (CAM_IDS as readonly string[]).includes(id) ? id : null;
}

/** Position of a slot in CAM order, or -1. */
export function slotIndex(slot: CamId | null): number {
  return slot === null ? -1 : (CAM_IDS as readonly CamId[]).indexOf(slot);
}

/** `cam3` → 3. Null slots have no number. */
export function slotNumber(slot: CamId | null): number | null {
  const i = slotIndex(slot);
  return i < 0 ? null : i + 1;
}

/** `CAM 3`, or `FRAME 2` for a frame whose name names no slot. */
export function slotLabel(slot: CamId | null, index: number): string {
  const n = slotNumber(slot);
  return n === null ? `FRAME ${index + 1}` : `CAM ${n}`;
}

/** Short form for a file name or a button: `C3`, or `F2` when unknown. */
export function slotTag(slot: CamId | null, index: number): string {
  const n = slotNumber(slot);
  return n === null ? `F${index + 1}` : `C${n}`;
}
