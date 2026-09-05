import { useEffect, useState } from 'react';

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** `navigator.onLine`, kept current by the window's online/offline events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const changed = (): void => setOnline(isOnline());
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    changed();
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, []);

  return online;
}
