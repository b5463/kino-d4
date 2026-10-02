import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { MenuCommand } from '../MenuBar';

/**
 * A button that opens a popover of commands: the top bar's overflow and the
 * rail's gear. Same MenuCommand shape the 2005 menu bar used, so the items
 * moved across unchanged. Escape closes and hands focus back; arrows walk the
 * enabled items; a click outside closes.
 */
export function ShellMenu({
  label,
  items,
  children,
  className,
  align = 'right',
  title,
}: {
  /** Accessible name of the trigger and the menu. */
  label: string;
  items: MenuCommand[];
  /** Trigger content. */
  children: ReactNode;
  className?: string;
  /** Which edge of the trigger the popover hangs from. */
  align?: 'left' | 'right' | 'above';
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = itemsRef.current.findIndex((i) => !i.disabled);
    setActive(first < 0 ? 0 : first);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const move = (dir: 1 | -1) => {
    const list = itemsRef.current;
    let i = active;
    for (let n = 0; n < list.length; n++) {
      i = (i + dir + list.length) % list.length;
      if (!list[i].disabled) break;
    }
    setActive(i);
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) btnRef.current?.focus();
  };

  const onPopKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        close(true);
        break;
    }
  };

  return (
    <div className={`shellmenu shellmenu--${align}${className ? ` ${className}` : ''}`} ref={rootRef}>
      <button
        type="button"
        ref={btnRef}
        className={open ? 'topbtn is-open' : 'topbtn'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open ? (
        <div className="menu-pop shellmenu-pop" role="menu" aria-label={label} onKeyDown={onPopKey}>
          {items.map((item, j) => (
            <Fragment key={`${item.label}-${j}`}>
              {item.separatorAbove ? <div className="menu-sep" role="separator" /> : null}
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                className="menu-item"
                ref={(el) => {
                  itemRefs.current[j] = el;
                }}
                tabIndex={active === j ? 0 : -1}
                disabled={item.disabled}
                aria-checked={item.checked === undefined ? undefined : item.checked}
                onMouseEnter={() => setActive(j)}
                onClick={() => {
                  setOpen(false);
                  item.action?.();
                }}
              >
                <span className="check" aria-hidden="true">
                  {item.checked ? '✓' : ''}
                </span>
                <span>{item.label}</span>
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
