/** How many cameras the D4 has; a state reads `3 OF 4` against this. */
export const CAMERA_SLOTS = 4;

export interface StatusChipProps {
  /** `capture.status` on the wire, or the caller's own reading of it. */
  status: string;
  /** Frames that actually arrived — the `original-frame` assets. */
  present: number;
}

/**
 * Every capture status, and the word the guest reads for it.
 *
 * Eight statuses exist (`packages/schemas/src/media.ts#CAPTURE_STATUSES`) and
 * this used to answer for three. The other five — `created`, `preview-ready`,
 * `originals-uploading`, `complete` and `ready` — all fell through to "no
 * label", which for `ready` is correct and for the four before it is the app
 * telling a guest that a photograph still crossing the wire is finished.
 *
 * The lifecycle (05§8) is: created, preview-ready, originals-uploading,
 * complete, processing, ready. So everything before `processing` is the CAMERA
 * still sending, and `processing`/`complete` is the SERVER still working. Two
 * different waits, and the second one is the only one a guest can do nothing
 * about either way — but "uploading" is the honest word for the first, because
 * the photograph is not on the server yet.
 *
 *  - `ready`   — finished. No label: a finished photograph does not need one.
 *  - `failed`  — nothing more is coming for this one.
 *  - `partial` — fewer cameras answered than the capture expected (`3 OF 4`).
 *
 * Anything this build has not heard of gets no label rather than a raw enum
 * name: an unknown status is not something to print at a guest, and the tile
 * beside this already shows whether there is a picture.
 */
const STATUS_WORD: Record<string, string> = {
  created: 'UPLOADING',
  'preview-ready': 'UPLOADING',
  'originals-uploading': 'UPLOADING',
  complete: 'PROCESSING',
  processing: 'PROCESSING',
};

/** The second line the no-picture window prints under the word. */
const STATUS_NOTE: Record<string, string> = {
  UPLOADING: 'The camera is still sending this one.',
  PROCESSING: 'The server is still working on this one.',
  FAILED: 'Nothing more is coming for this one.',
};

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
 * `processing` is also what a tile says while no baked animation exists yet.
 * The full status table is `STATUS_WORD` above.
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
  const word = STATUS_WORD[status];
  if (word === undefined) return null;
  return (
    <span className="k-state" data-state={word === 'UPLOADING' ? 'uploading' : 'processing'} role="status">
      {word}
    </span>
  );
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
export function NoPicture({ status }: { status: string }) {
  const failed = status === 'failed';
  const word = failed ? 'FAILED' : (STATUS_WORD[status] ?? 'PROCESSING');
  return (
    <p className="k-nopic" data-state={failed ? 'failed' : word.toLowerCase()} role="status">
      <b>{word}</b>
      <span>{STATUS_NOTE[word] ?? 'The server is still working on this one.'}</span>
    </p>
  );
}
