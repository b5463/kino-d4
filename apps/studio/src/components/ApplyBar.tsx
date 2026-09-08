import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { ConfirmDialog } from './ConfirmDialog';
import { Led } from './Led';
import { onUi } from '../state/uiBus';
import { useDeviceStore } from '../state/deviceStore';
import { configLabel } from '../utils/configLabels';
import type { ConfigDiff } from '../utils/diffConfig';

/**
 * Sticky unsaved-changes bar. Nothing is shown as saved until the device
 * acknowledged SET_CONFIG + SAVE_CONFIG — the caller refreshes device state
 * after apply, which clears the dirty flag naturally.
 *
 * A failed apply gets its own alert row: concatenating the error into the
 * amber label made a failed write look almost identical to an unsaved one,
 * and announced it to nobody.
 *
 * A *successful* apply used to be announced by nothing at all: the bar
 * unmounted the instant `dirty` cleared, which took the confirmation and the
 * keyboard focus with it. It now holds a saved row for a few seconds, quotes
 * the config revision the camera itself reported, and takes focus so a
 * keyboard user is not dropped at the top of the document.
 */
const SAVED_HOLD_MS = 6000;

/**
 * What an APPLY handler may report back.
 *
 * `refused` is the fields the camera stored differently from what was sent —
 * SET_CONFIG is allowed to clamp and still ACK, so a successful save is not
 * proof the values on screen are the ones asked for. A handler that returns
 * nothing is treated as a clean write, which is what every non-config apply
 * (a look upload, a recipe) is.
 */
export interface ApplyOutcome {
  refused: ConfigDiff[];
}

export function ApplyBar({
  dirty,
  onApply,
  onDiscard,
  applyLabel = 'APPLY TO KINO',
  /** Shown in the discard confirmation so the cost is explicit. */
  changeCount,
  /** Flattened paths of the changed fields, newest diff. */
  changedFields,
}: {
  dirty: boolean;
  onApply: () => Promise<ApplyOutcome | void>;
  onDiscard: () => void;
  applyLabel?: string;
  changeCount?: number;
  changedFields?: string[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saved, setSaved] = useState<{
    at: string;
    revision: number | null;
    refused: ConfigDiff[];
  } | null>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = () => {
    setBusy(true);
    setError(null);
    onApply()
      .then((outcome) => {
        // Read the revision after the caller refreshed, so it is the camera's
        // number and not Studio's optimism.
        const revision = useDeviceStore.getState().configRevision;
        const refused = outcome?.refused ?? [];
        setSaved({
          at: new Date().toLocaleTimeString([], { hour12: false }),
          revision: typeof revision === 'number' ? revision : null,
          refused,
        });
        if (holdTimer.current) clearTimeout(holdTimer.current);
        // A refusal is the operator's evidence that a value is not what they
        // typed. It stays until they navigate or edit, not for six seconds.
        if (refused.length === 0) {
          holdTimer.current = setTimeout(() => setSaved(null), SAVED_HOLD_MS);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  // Ctrl+S from anywhere in the section. Refs so the subscription is made
  // once and still calls the current closure.
  const state = useRef({ dirty, busy, apply });
  state.current = { dirty, busy, apply };
  useEffect(
    () =>
      onUi('apply', () => {
        const s = state.current;
        if (s.dirty && !s.busy) s.apply();
      }),
    [],
  );

  // Keyboard focus followed the unmounting bar to <body>. Move it onto the
  // saved row instead, which is also what gets announced.
  useEffect(() => {
    if (saved) savedRef.current?.focus();
  }, [saved]);

  useEffect(() => {
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  // A new edit supersedes the previous confirmation.
  useEffect(() => {
    if (dirty && saved) setSaved(null);
  }, [dirty, saved]);

  // A clamped write is reported whether or not anything is still dirty: the
  // page rebases onto what the camera kept, so `dirty` is false and the row
  // would otherwise vanish with the news in it.
  const savedRow = saved ? (
    <div className={`applybar ${saved.refused.length > 0 ? 'applybar--warn' : 'applybar--saved'}`}>
      <p className="applybar-saved" role="status" tabIndex={-1} ref={savedRef}>
        <Led state={saved.refused.length > 0 ? 'warn' : 'ok'} label="" />
        <span>
          <strong>SAVED TO KINO</strong> · {saved.at}
          {saved.revision !== null ? ` · CONFIG REV ${saved.revision}` : ''}
          {saved.refused.length > 0 ? (
            <>
              <br />
              <strong>
                KINO KEPT {saved.refused.length === 1 ? 'A DIFFERENT VALUE' : 'DIFFERENT VALUES'} FOR{' '}
                {saved.refused.length} {saved.refused.length === 1 ? 'FIELD' : 'FIELDS'}
              </strong>{' '}
              — the fields below now show what the camera has, not what was sent.
              <br />
              {saved.refused.map((d) => (
                <span key={d.path} className="mono" style={{ display: 'block' }}>
                  {configLabel(d.path)}: sent {d.from}, kept {d.to}
                </span>
              ))}
            </>
          ) : null}
        </span>
      </p>
    </div>
  ) : null;

  if (!dirty) return savedRow;

  const names = (changedFields ?? []).map(configLabel);
  const summary =
    names.length === 0 ? null
    : names.length <= 3 ? names.join(', ')
    : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;

  return (
    <>
      <div className="applybar">
        <span className="applybar-label">
          {changeCount && changeCount > 0
            ? `${changeCount} UNSAVED CHANGE${changeCount === 1 ? '' : 'S'}`
            : 'UNSAVED CHANGES'}
        </span>
        {summary ? <span className="applybar-fields">{summary}</span> : null}
        <span style={{ display: 'flex', gap: 10, marginLeft: 'auto' }}>
          <Button disabled={busy} onClick={() => setConfirmDiscard(true)}>
            DISCARD
          </Button>
          <Button variant="primary" busy={busy} onClick={apply} title="Ctrl+S">
            {applyLabel}
          </Button>
        </span>
        {error ? (
          <p className="applybar-error" role="alert">
            <Icon name="warning" />
            <span>
              <strong>Not saved to KINO.</strong> {error} Your changes are still here — fix the
              cause and press {applyLabel} again.
            </span>
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        danger
        title="DISCARD CHANGES"
        confirmLabel="DISCARD"
        cancelLabel="KEEP EDITING"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          setError(null);
          onDiscard();
        }}
      >
        <p>
          Throw away {changeCount && changeCount > 0 ? `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}` : 'the unsaved changes'} on
          this page? The camera keeps its current settings. This cannot be undone.
        </p>
        {summary ? <p className="dim">{summary}</p> : null}
      </ConfirmDialog>
    </>
  );
}
