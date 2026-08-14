import { useEffect, useRef } from 'react';

/**
 * One modal contract for the whole app: Escape closes, Tab is trapped
 * inside, focus lands somewhere deliberate on open and returns to the
 * element that opened it on close.
 *
 * Two dialogs with two different keyboard behaviours teach the user that
 * Escape is unreliable, so both the confirm dialog and the capture
 * inspector use this.
 */
export function useModal({
  open,
  onClose,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  /** Where focus goes on open. Danger dialogs point this at Cancel. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const returnToRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    returnToRef.current = document.activeElement as HTMLElement | null;

    const focusables = () =>
      [
        ...(containerRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), canvas[tabindex], [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);

    const target = initialFocus?.current ?? focusables()[0] ?? containerRef.current;
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = containerRef.current?.contains(active) ?? false;
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Hand focus back to whatever opened the dialog.
      returnToRef.current?.focus?.();
    };
  }, [open, onClose, initialFocus]);

  return containerRef;
}
