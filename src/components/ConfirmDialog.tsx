import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { useModal } from '../hooks/useModal';

/**
 * Confirmation gate for destructive/irreversible actions: firmware update,
 * factory reset, calibration reset, recipe deletion, recovery mode.
 * Ordinary setting changes never pass through here.
 *
 * A danger dialog focuses CANCEL, never the destructive button. The dialog
 * exists to introduce a deliberate pause; pre-arming the trigger means one
 * reflexive Space wipes the device.
 *
 * `danger` and `focusCancel` are separate on purpose. A firmware update or a
 * reboot is routine enough that red chrome would cry wolf, but it still writes
 * flash and still must not be armed by a stray Space — so it passes
 * `focusCancel` without `danger`.
 */
export function ConfirmDialog({
  open,
  title,
  danger,
  focusCancel,
  confirmLabel,
  cancelLabel = 'CANCEL',
  onConfirm,
  onCancel,
  busy,
  children,
}: {
  open: boolean;
  title: string;
  danger?: boolean;
  /** Focus CANCEL without the red treatment. Implied by `danger`. */
  focusCancel?: boolean;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const headId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModal({
    open,
    onClose: onCancel,
    initialFocus: danger || focusCancel ? cancelRef : confirmRef,
  });

  if (!open) return null;

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headId}
        aria-describedby={bodyId}
      >
        <div id={headId} className={`dialog-head${danger ? ' dialog-head--danger' : ''}`}>
          {title}
        </div>
        <div id={bodyId} className="dialog-body">
          {children}
        </div>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <Button
            ref={confirmRef as never}
            variant={danger ? 'danger-solid' : 'primary'}
            busy={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
