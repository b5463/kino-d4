/** How many cameras the D4 has; a chip reads `3 OF 4` against this. */
export const CAMERA_SLOTS = 4;

export interface StatusChipProps {
  /** `capture.status` on the wire, or the caller's own reading of it. */
  status: string;
  /** Frames that actually arrived — the `original-frame` assets. */
  present: number;
}

/**
 * The one small word a degraded capture wears. `failed` and `partial` come
 * from the API's capture status; `processing` is also what a tile says while
 * no baked animation exists yet. Anything else gets no chip.
 */
export function StatusChip({ status, present }: StatusChipProps) {
  if (status === 'failed') {
    return <span className="k-chip" data-state="failed" role="status">FAILED</span>;
  }
  if (status === 'partial') {
    return (
      <span className="k-chip" data-state="partial" role="status">
        {String(present)} OF {String(CAMERA_SLOTS)}
      </span>
    );
  }
  if (status === 'processing') {
    return <span className="k-chip" data-state="processing" role="status">Processing…</span>;
  }
  return null;
}
