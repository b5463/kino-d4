import type { ReactNode } from 'react';

/**
 * Compact dark-blue site bar, shared by the feed and detail pages. The right
 * slot carries the LIVE lamp on roll pages. No nav links yet: the guest app
 * has no routes besides the roll itself, and dead links are worse than none.
 */
export function SiteHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="site-header">
      <div className="site-width site-header-row">
        <span className="site-brand">KINO ROLL</span>
        {right ?? null}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-width">
        <strong>KINO</strong> · four lenses. one press.
      </div>
    </footer>
  );
}
