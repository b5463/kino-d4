import { useEffect, useId, useRef, useState } from 'react';

export interface OverflowItem {
  label: string;
  onSelect: () => void;
  warning?: boolean;
}

/**
 * The one disclosure that is not a word: "…" opens a short list of actions.
 * Escape and a click outside close it; focus returns to the button.
 */
export function Overflow({
  items,
  label = 'More actions',
  trigger = '…',
  quiet = true,
}: {
  items: OverflowItem[];
  label?: string;
  /** The word on the button; "…" by default. */
  trigger?: string;
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="c-overflow" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={quiet ? 'c-word c-word--quiet' : 'c-word'}
        aria-label={trigger === '…' ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open ? (
        <div className="c-overflow-menu" role="menu" id={id}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.warning ? 'is-warning' : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
