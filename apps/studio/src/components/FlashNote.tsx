// The one sentence every flash control carries on a body with no emitter.
//
// D4-V1 has no flash LED (ECN-0003: GPIO28 went to the shutter and the flash
// became an external module). The firmware still keeps a flash *window* —
// `flashControl` is true — so the policy, the per-mode toggle and the per-slot
// FIRE/SKIP are real settings that reach the camera; they just light nothing
// on this body. The controls stay; this note says what they do.

export const FLASH_NOT_FITTED_NOTE =
  'No flash emitter is fitted on this KINO. These set the firmware’s flash window only; the external top light is not controlled by the camera.';

export function FlashNotFittedNote() {
  return (
    <p className="notice notice--warn" data-note="flash-not-fitted" style={{ marginTop: 8, marginBottom: 8 }}>
      {FLASH_NOT_FITTED_NOTE}
    </p>
  );
}
