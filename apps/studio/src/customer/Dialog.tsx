import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * One question, two buttons. Paper on a dimmed page, no title bar. Cancel is
 * focused; the confirming button is warning red only when the action cannot
 * be undone for someone else (End Roll).
 */
export function ConfirmSheet({
  open,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  warning = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  warning?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      cancelRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  return (
    <dialog className="c-dialog" ref={ref} onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div>{children}</div>
      <div className="c-dialog-actions">
        <button
          type="button"
          className={`c-button${warning ? ' c-button--warning' : ''}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className="c-button c-button--outline" ref={cancelRef} onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </dialog>
  );
}
