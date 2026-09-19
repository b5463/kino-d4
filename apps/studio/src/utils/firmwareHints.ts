// Settings the camera stores but the shipped firmware never reads.
//
// The config schema is ahead of the body and the firmware in a few places.
// Each such field keeps its control — the value is real, it round-trips
// through SET_CONFIG/GET_CONFIG and a backup — but the hint says plainly that
// nothing on this camera acts on it yet, so an operator does not spend an
// evening wondering why a toggle does nothing. The text lives here once.

/** The firmware this note was verified against (firmware/VERSION). */
export const HINT_FIRMWARE_VERSION = '0.4.56';

/**
 * A stored setting no firmware reads yet. Pass the connected firmware label
 * when it is known; an older build did not read it either, so the sentence
 * stays true.
 */
export function notReadByFirmwareHint(firmware?: string | null): string {
  return `Not read by firmware ${firmware ?? HINT_FIRMWARE_VERSION} — stored on the camera for a later build.`;
}

/** Join a control's own hint with the not-read note, when it has one. */
export function withNotReadHint(hint: string | undefined, firmware?: string | null): string {
  const note = notReadByFirmwareHint(firmware);
  return hint ? `${hint} ${note}` : note;
}

/**
 * ECN-0003: the D4-V1 body routes no GPIO to a function button or a slide
 * switch, and the firmware reads neither key. The selects stay so the choice
 * survives for a body that has them, disabled so nobody waits for it to work.
 */
export const NOT_WIRED_D4V1_HINT =
  'Not wired on D4-V1 — no function button or slide switch GPIO (ECN-0003). Stored for a later body.';
