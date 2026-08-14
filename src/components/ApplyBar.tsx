import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { ConfirmDialog } from './ConfirmDialog';
import { onUi } from '../state/uiBus';

/**
 * Sticky unsaved-changes bar. Nothing is shown as saved until the device
 * acknowledged SET_CONFIG + SAVE_CONFIG — the caller refreshes device state
 * after apply, which clears the dirty flag naturally.
 *
 * A failed apply gets its own alert row: concatenating the error into the
 * amber label made a failed write look almost identical to an unsaved one,
 * and announced it to nobody.
 */
export function ApplyBar({
  dirty,
  onApply,
  onDiscard,
  applyLabel = 'APPLY TO KINO',
  /** Shown in the discard confirmation so the cost is explicit. */
  changeCount,
}: {
  dirty: boolean;
  onApply: () => Promise<void>;
  onDiscard: () => void;
  applyLabel?: string;
  changeCount?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const apply = () => {
    setBusy(true);
    setError(null);
    onApply()
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

  if (!dirty) return null;

  return (
    <>
      <div className="applybar">
        <span className="applybar-label">
          {changeCount && changeCount > 0
            ? `${changeCount} UNSAVED CHANGE${changeCount === 1 ? '' : 'S'}`
            : 'UNSAVED CHANGES'}
        </span>
        <span style={{ display: 'flex', gap: 10 }}>
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
      </ConfirmDialog>
    </>
  );
}
