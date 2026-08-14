// Tiny UI command bus so menus and toolbar can trigger page-level actions
// (run self test, open backup picker) without prop-drilling through the app.

export type UiEvent = 'self-test' | 'backup' | 'restore' | 'toggle-faults' | 'apply';

const handlers: Record<UiEvent, Set<() => void>> = {
  'self-test': new Set(),
  'backup': new Set(),
  'restore': new Set(),
  'toggle-faults': new Set(),
  // Ctrl+S. The apply bar of whichever section is open answers it.
  'apply': new Set(),
};

export function onUi(evt: UiEvent, cb: () => void): () => void {
  handlers[evt].add(cb);
  return () => handlers[evt].delete(cb);
}

export function emitUi(evt: UiEvent) {
  // Defer one tick so a page mounted by the same click can subscribe first.
  setTimeout(() => {
    for (const cb of handlers[evt]) cb();
  }, 30);
}
