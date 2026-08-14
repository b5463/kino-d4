import { Fragment, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

// Classic File/Camera/View/Tools/Help strip. Menus expose the same commands
// as the rest of the interface — discoverability, not secret features.
//
// Keyboard behaviour matches the era it borrows from: Alt+letter opens a
// menu, arrows walk items and jump between menus, Escape closes and hands
// focus back to the menu title. A 2000s menu bar that only worked with a
// mouse would be a costume, not a menu bar.

export interface MenuCommand {
  label: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separatorAbove?: boolean;
}

export interface MenuSpec {
  label: string;
  items: MenuCommand[];
}

export function MenuBar({ menus, version }: { menus: MenuSpec[]; version: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // App rebuilds the menu spec every render; effects must not depend on it.
  const menusRef = useRef(menus);
  menusRef.current = menus;

  const close = (restoreFocus: boolean) => {
    const wasOpen = open;
    setOpen(null);
    if (restoreFocus && wasOpen !== null) btnRefs.current[wasOpen]?.focus();
  };

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Alt+F / Alt+C / … from anywhere. The mnemonic is the first letter, which
  // is unique across the five menus and shown underlined in the label.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const idx = menusRef.current.findIndex((m) => m.label[0].toLowerCase() === e.key.toLowerCase());
      if (idx < 0) return;
      e.preventDefault();
      setOpen((cur) => (cur === idx ? null : idx));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Opening any menu puts the highlight on its first available command.
  useEffect(() => {
    if (open === null) return;
    const first = menusRef.current[open].items.findIndex((i) => !i.disabled);
    setActive(first < 0 ? 0 : first);
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    itemRefs.current[active]?.focus();
  }, [open, active]);

  const move = (dir: 1 | -1) => {
    if (open === null) return;
    const items = menusRef.current[open].items;
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (!items[i].disabled) break;
    }
    setActive(i);
  };

  const edge = (which: 'first' | 'last') => {
    if (open === null) return;
    const items = menusRef.current[open].items;
    const idx =
      which === 'first'
        ? items.findIndex((i) => !i.disabled)
        : items.map((i) => !i.disabled).lastIndexOf(true);
    if (idx >= 0) setActive(idx);
  };

  const onPopKey = (e: React.KeyboardEvent) => {
    if (open === null) return;
    const count = menusRef.current.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        edge('first');
        break;
      case 'End':
        e.preventDefault();
        edge('last');
        break;
      case 'ArrowRight':
        e.preventDefault();
        setOpen((open + 1) % count);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        setOpen((open - 1 + count) % count);
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        close(true);
        break;
    }
  };

  return (
    <div className="menubar" ref={rootRef}>
      <span className="menubar-brand">
        <Icon name="camera" />
        KINO <span className="studio">STUDIO</span>
      </span>
      {menus.map((menu, i) => (
        <div key={menu.label} className="menu-root">
          <button
            type="button"
            className="menu-btn"
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            aria-haspopup="menu"
            aria-expanded={open === i}
            aria-keyshortcuts={`Alt+${menu.label[0].toUpperCase()}`}
            onClick={() => setOpen(open === i ? null : i)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(i);
              } else if (e.key === 'ArrowRight' && open !== null) {
                e.preventDefault();
                setOpen((i + 1) % menus.length);
              } else if (e.key === 'ArrowLeft' && open !== null) {
                e.preventDefault();
                setOpen((i - 1 + menus.length) % menus.length);
              }
            }}
          >
            <span className="mn">{menu.label[0]}</span>
            {menu.label.slice(1)}
          </button>
          {open === i ? (
            <div className="menu-pop" role="menu" aria-label={menu.label} onKeyDown={onPopKey}>
              {menu.items.map((item, j) => (
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
                      setOpen(null);
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
      ))}
      <span className="menubar-right">v{version}</span>
    </div>
  );
}
