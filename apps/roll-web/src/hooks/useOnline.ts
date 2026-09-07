import { useEffect, useState } from 'react';

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * `navigator.onLine`, kept current by the window's online/offline events.
 *
 * The initial value is read TWICE on purpose: once for the first render, and
 * again from the effect. `navigator.onLine` is a live property, and a page
 * restored from the back/forward cache or resumed from a service worker after
 * a reload can render with one value and be handed another before the first
 * `online`/`offline` event ever fires. Only the events would leave the banner
 * missing on an offline reload — which is exactly the case where a guest most
 * needs to be told.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const changed = (): void => setOnline(isOnline());
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    // A restored page reports its state through `pageshow`, not through an
    // `offline` event that fired while the tab was frozen.
    window.addEventListener('pageshow', changed);
    changed();
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
      window.removeEventListener('pageshow', changed);
    };
  }, []);

  return online;
}
