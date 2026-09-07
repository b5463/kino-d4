/** How many cameras the D4 has; a state reads `3 OF 4` against this. */
export const CAMERA_SLOTS = 4;

export interface StatusChipProps {
  /** `capture.status` on the wire, or the caller's own reading of it. */
  status: string;
  /** Frames that actually arrived — the `original-frame` assets. */
  present: number;
}

/**
 * The word a photograph that is not finished wears.
 *
 * It used to be `.k-chip`: a plate positioned at the top-right CORNER of the
 * tile, floating over the half-loaded picture behind it. That reads as a
 * sticker somebody put on a photograph, not as a state the photograph is in —
 * and on a dark indoor frame the pale plate was the brightest thing on screen.
 *
 * So it is inline text now, and both callers place it on a line that already
 * describes the picture: the feed tile's overlay row, beside the frame bars
 * and the capture number; the capture page's row of facts, beside `shot` and
 * `frames`. Same three states, same three words, one typographic treatment.
 *
 *  - `failed`     — nothing more is coming for this one.
 *  - `partial`    — fewer cameras answered than the capture expected.
 *  - `processing` — also what a tile says while no baked animation exists yet.
 *
 * Anything else gets nothing: a finished photograph does not need a label
 * saying it is finished.
 */
export function StatusChip({ status, present }: StatusChipProps) {
  if (status === 'failed') {
    return <span className="k-state" data-state="failed" role="status">FAILED</span>;
  }
  if (status === 'partial') {
    return (
      <span className="k-state" data-state="partial" role="status">
        {String(present)} OF {String(CAMERA_SLOTS)}
      </span>
    );
  }
  if (status === 'processing') {
    return <span className="k-state" data-state="processing" role="status">PROCESSING</span>;
  }
  return null;
}

/**
 * The tile or hero when there is no picture to show at all — the same window
 * the counter sits in on the header plate, with the state written in it.
 *
 * One component for both surfaces. The feed used to draw a bare centred
 * `Processing…` and the capture page a `<p className="photo-processing">` for
 * which no rule was ever written, so a processing capture opened on unstyled
 * body text floating in a black hero. The second line is there because
 * "PROCESSING" alone does not tell a guest whether to wait or leave.
 */
export function NoPicture({ status }: { status: 'processing' | 'failed' }) {
  const failed = status === 'failed';
  return (
    <p className="k-nopic" data-state={status} role="status">
      <b>{failed ? 'FAILED' : 'PROCESSING'}</b>
      <span>{failed ? 'Nothing more is coming for this one.' : 'The camera is still sending this one.'}</span>
    </p>
  );
}
